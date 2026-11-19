//! Web Guard's heartbeat, over loopback.
//!
//! The Firebase last_seen is one value per account: no browser name, and a Chrome
//! on another PC keeps this desktop "not stale". A beat that reaches 127.0.0.1
//! came from this PC, says which browser sent it, and works offline.
//!
//! A hand-written reader rather than a server crate: one route, one small body,
//! one connection at a time, and it only ever records a beat.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Fixed, because the extension has to know it. Bound to 127.0.0.1 only.
pub const PORT: u16 = 47823;
/// Web Guard's id on the Chrome Web Store. Edge and Brave install from there, so
/// they send the same one.
pub const WEB_GUARD_EXTENSION_ID: &str = "pcmcaccnegefcjhdabjjfhaakjfeocea";
/// Web Guard beats every 15 s while awake and its alarm wakes it about every 30 s,
/// so a beat older than this means it is gone: disabled, removed or blocked.
pub const FRESH_MS: u64 = 35_000;

const MAX_REQUEST_BYTES: usize = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(2);
/// A build reporting anything else, plain "chromium" above all, allows nothing.
const IDENTIFIED_BROWSERS: &[&str] = &["chrome", "edge", "brave", "firefox"];

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatBody {
    pub browser: String,
    #[serde(default)]
    pub version: String,
    /// False means Web Guard isn't running in this browser's private windows.
    #[serde(default)]
    pub incognito_allowed: bool,
    /// The account Web Guard is signed in to. Signed out, it blocks nothing.
    pub uid: Option<String>,
    /// A random id Web Guard keeps per browser profile (1.3.1+). None from older
    /// copies, whose beats count for their whole browser instance.
    #[serde(default)]
    pub profile_id: Option<String>,
    /// How many windows this copy of Web Guard can see (1.3.1+): its profile's,
    /// plus Incognito's when it's allowed there.
    #[serde(default)]
    pub windows: Option<u32>,
    /// Web Guard is blocking session sites right now (1.3.1+).
    #[serde(default)]
    pub locked: Option<bool>,
    /// Web Guard can act on every site (1.3.1+). False when its site access was
    /// cut to "on click" or a few sites in the browser's extension settings.
    #[serde(default)]
    pub host_access: Option<bool>,
}

/// What the desktop tells Web Guard in reply to a beat: its own session, so a
/// Web Guard that never heard of it from Firebase (blocked, offline, or an
/// account token writing focusActive false) blocks anyway.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReply {
    pub active: bool,
    pub end_time: Option<u64>,
    pub bailout_end: Option<u64>,
}

/// The desktop's session for a beat from this account.
pub type SessionFor = Arc<dyn Fn(Option<&str>) -> SessionReply + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Beat {
    pub at: u64,
    pub incognito_allowed: bool,
    pub uid: Option<String>,
    /// The browser instance it came from: the top process of the browser's own
    /// process tree. There is one per user-data-dir, so a browser started with
    /// another --user-data-dir is another instance and needs a beat of its own.
    pub root: u32,
    pub profile: Option<String>,
    pub windows: Option<u32>,
    pub locked: Option<bool>,
    pub host_access: Option<bool>,
    /// The reply to this copy's previous beat said a session is live, so this
    /// beat was sent knowing about it.
    pub told_active: bool,
    /// What the reply to this beat said.
    pub replied_active: bool,
}

impl Beat {
    /// Web Guard signed in to someone else isn't enforcing this session. With no
    /// account known (a session from before uids were stored), any signed-in
    /// Web Guard counts.
    pub fn counts_for(&self, uid: Option<&str>) -> bool {
        match (&self.uid, uid) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some(a), Some(b)) => a == b,
        }
    }
}

/// Who made a connection, as Windows sees it, not as the request claims.
#[derive(Debug, Clone, PartialEq)]
pub struct Attested {
    /// browsers.rs id of the process that owns the connection.
    pub browser: &'static str,
    /// Top process of that browser's tree (see Beat::root).
    pub root: u32,
}

/// Finds the process behind a loopback connection: (client, server) -> who.
pub type Attest = fn(SocketAddr, SocketAddr) -> Option<Attested>;

/// A beat is forgotten this long after it arrived.
const FORGET_MS: u64 = 10 * 60_000;

/// The latest beat per browser instance and profile. In memory only: a beat
/// means nothing later.
#[derive(Default)]
pub struct BeatStore {
    beats: Mutex<HashMap<(String, u32, String), Beat>>,
}

impl BeatStore {
    /// `replied_active`: what the reply to this beat says.
    pub fn record(&self, body: BeatBody, root: u32, now: u64, replied_active: bool) {
        if let Ok(mut beats) = self.beats.lock() {
            beats.retain(|_, b| now.saturating_sub(b.at) < FORGET_MS);
            let key = (body.browser.clone(), root, body.profile_id.clone().unwrap_or_default());
            let told_active = beats.get(&key).is_some_and(|prev| prev.replied_active);
            beats.insert(
                key,
                Beat {
                    at: now,
                    incognito_allowed: body.incognito_allowed,
                    uid: body.uid,
                    root,
                    profile: body.profile_id,
                    windows: body.windows,
                    locked: body.locked,
                    host_access: body.host_access,
                    told_active,
                    replied_active,
                },
            );
        }
    }

    /// A fresh beat for this account from a Web Guard that can block in every
    /// window: allowed in Incognito, and with access to every site. What the
    /// Start dialog asks; lockdown asks coverage.rs, per instance.
    pub fn protects(&self, browser: &str, uid: Option<&str>, now: u64) -> bool {
        self.all(browser).iter().any(|b| {
            b.counts_for(uid)
                && now.saturating_sub(b.at) < FRESH_MS
                && b.incognito_allowed
                && b.host_access != Some(false)
        })
    }

    /// Every beat from this browser, any instance.
    pub fn all(&self, browser: &str) -> Vec<Beat> {
        self.beats
            .lock()
            .map(|beats| beats.iter().filter(|(k, _)| k.0 == browser).map(|(_, b)| b.clone()).collect())
            .unwrap_or_default()
    }

    /// The browser's latest beat from any instance, if it counts for this account.
    pub fn latest(&self, browser: &str, uid: Option<&str>) -> Option<Beat> {
        self.all(browser).into_iter().filter(|b| b.counts_for(uid)).max_by_key(|b| b.at)
    }

    pub fn is_fresh(&self, browser: &str, uid: Option<&str>, now: u64) -> bool {
        self.latest(browser, uid)
            .is_some_and(|b| now.saturating_sub(b.at) < FRESH_MS)
    }

    /// Web Guard is running in this browser (a fresh beat) but doesn't count for this
    /// account: signed out (no uid) or signed in to another Lock-In account. False with
    /// no fresh beat at all, when the app can't tell whether Web Guard is there.
    pub fn wrong_account(&self, browser: &str, uid: Option<&str>, now: u64) -> bool {
        let fresh = |b: &Beat| now.saturating_sub(b.at) < FRESH_MS;
        let all = self.all(browser);
        all.iter().any(fresh) && !all.iter().any(|b| fresh(b) && b.counts_for(uid))
    }
}

#[derive(Debug, PartialEq)]
pub enum Rejected {
    NotFound,
    WrongHost,
    WrongOrigin,
    BadBody,
    UnidentifiedBrowser,
    /// The connection isn't owned by the browser the beat names.
    NotABrowser,
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// Everything a request must prove before its beat is recorded. Host is checked
/// as well as Origin, so a page can't reach this through DNS rebinding.
pub fn accept_beat(request: &str, port: u16, allowed_ids: &[String]) -> Result<BeatBody, Rejected> {
    let (head, body) = request.split_once("\r\n\r\n").ok_or(Rejected::BadBody)?;
    if !head.starts_with("POST /beat HTTP/1.") {
        return Err(Rejected::NotFound);
    }
    let host_ok = header(head, "host").is_some_and(|h| {
        h == format!("127.0.0.1:{}", port) || h == format!("localhost:{}", port)
    });
    if !host_ok {
        return Err(Rejected::WrongHost);
    }
    let origin = header(head, "origin").unwrap_or("");
    let origin_ok = origin
        .strip_prefix("chrome-extension://")
        .is_some_and(|id| allowed_ids.iter().any(|a| a == id));
    if !origin_ok {
        return Err(Rejected::WrongOrigin);
    }
    let beat: BeatBody = serde_json::from_str(body).map_err(|_| Rejected::BadBody)?;
    if !IDENTIFIED_BROWSERS.contains(&beat.browser.as_str()) {
        return Err(Rejected::UnidentifiedBrowser);
    }
    Ok(beat)
}

/// The ids accepted, for this run. Only a DEV_MODE install can add one: an
/// unpacked test copy of the extension gets a different id from the store's.
pub fn allowed_extension_ids(dev_extension_id: Option<String>) -> Vec<String> {
    let mut ids = vec![WEB_GUARD_EXTENSION_ID.to_string()];
    if let Some(id) = dev_extension_id {
        let id = id.trim().to_string();
        if id.len() == 32 && id.chars().all(|c| ('a'..='p').contains(&c)) {
            ids.push(id);
        }
    }
    ids
}

/// One whole request, up to the size limit. Stops at Content-Length.
fn read_request(stream: &mut TcpStream) -> Option<String> {
    stream.set_read_timeout(Some(READ_TIMEOUT)).ok()?;
    let mut data = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..n]);
        if data.len() > MAX_REQUEST_BYTES {
            return None;
        }
        if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&data[..end]).to_string();
            let length: usize = header(&head, "content-length")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            if data.len() >= end + 4 + length {
                break;
            }
        }
    }
    String::from_utf8(data).ok()
}

/// A beat that passed the request checks must also come from the browser it
/// names: Windows says which process owns the connection. curl, a script, or
/// any other program gets 403, whatever headers it sends.
pub fn attested_for(body: &BeatBody, who: Option<Attested>) -> Result<u32, Rejected> {
    match who {
        Some(a) if a.browser == body.browser => Ok(a.root),
        _ => Err(Rejected::NotABrowser),
    }
}

fn handle(mut stream: TcpStream, port: u16, allowed: &[String], store: &BeatStore, now: u64, attest: Attest, session: &SessionFor) {
    let peer = stream.peer_addr().ok();
    let local = stream.local_addr().ok();
    let mut reply_body = String::new();
    let status = match read_request(&mut stream) {
        None => "400 Bad Request",
        Some(request) => match accept_beat(&request, port, allowed) {
            Ok(beat) => {
                let who = match (peer, local) {
                    (Some(p), Some(l)) => attest(p, l),
                    _ => None,
                };
                match attested_for(&beat, who) {
                    Ok(root) => {
                        let reply = session(beat.uid.as_deref());
                        reply_body = serde_json::json!({ "session": reply }).to_string();
                        store.record(beat, root, now, reply.active);
                        "200 OK"
                    }
                    Err(_) => {
                        println!("[Heartbeat] refused a beat that didn't come from {}", beat.browser);
                        "403 Forbidden"
                    }
                }
            }
            Err(Rejected::NotFound) => "404 Not Found",
            Err(Rejected::WrongHost) | Err(Rejected::WrongOrigin) | Err(Rejected::NotABrowser) => "403 Forbidden",
            Err(Rejected::BadBody) | Err(Rejected::UnidentifiedBrowser) => "422 Unprocessable Entity",
        },
    };
    let content_type = if reply_body.is_empty() { "" } else { "Content-Type: application/json\r\n" };
    let _ = write!(
        stream,
        "HTTP/1.1 {}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        content_type,
        reply_body.len(),
        reply_body
    );
}

/// Serve on this listener until the process ends. One at a time, each bounded by
/// the read timeout, so a stuck client costs at most a beat or two.
pub fn serve(listener: TcpListener, allowed: Vec<String>, store: Arc<BeatStore>, clock: fn() -> u64, attest: Attest, session: SessionFor) {
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(PORT);
    for stream in listener.incoming().flatten() {
        handle(stream, port, &allowed, &store, clock(), attest, &session);
    }
}

pub fn bind_on(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", port))
}

/// The wait after the nth failed bind (from 0): 1 s, doubling, at most 60 s.
pub fn retry_delay(failures: u32) -> Duration {
    Duration::from_millis((1_000u64 << failures.min(6)).min(60_000))
}

/// Keep trying to open the port until it opens, then hand it to `on_open`.
/// `listening` says which it is right now, for lockdown and the Start dialog.
/// Every failure goes to `on_fail`, which logs it. A session that needs the
/// port says so on screen (APPS_ONLY_NOTICE in lib.rs), so a session never
/// runs with browsers unchecked without saying so.
pub fn bind_with_retry(
    port: u16,
    listening: &AtomicBool,
    on_fail: impl Fn(u32, &std::io::Error),
    sleep: impl Fn(Duration),
) -> TcpListener {
    let mut failures = 0u32;
    loop {
        match bind_on(port) {
            Ok(listener) => {
                listening.store(true, Ordering::SeqCst);
                return listener;
            }
            Err(e) => {
                listening.store(false, Ordering::SeqCst);
                on_fail(failures, &e);
                sleep(retry_delay(failures));
                failures = failures.saturating_add(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> Vec<String> {
        vec![WEB_GUARD_EXTENSION_ID.to_string()]
    }

    fn request(host: &str, origin: Option<&str>, body: &str) -> String {
        let origin = origin.map_or(String::new(), |o| format!("Origin: {}\r\n", o));
        format!(
            "POST /beat HTTP/1.1\r\nHost: {}\r\n{}Content-Length: {}\r\n\r\n{}",
            host, origin, body.len(), body
        )
    }

    const OK_BODY: &str = r#"{"browser":"edge","version":"1.2.5","incognitoAllowed":false,"uid":"u1"}"#;
    const ORIGIN: &str = "chrome-extension://pcmcaccnegefcjhdabjjfhaakjfeocea";

    #[test]
    fn a_beat_from_web_guard_is_accepted_and_names_the_browser() {
        let beat = accept_beat(&request("127.0.0.1:47823", Some(ORIGIN), OK_BODY), PORT, &ids()).unwrap();
        assert_eq!(beat.browser, "edge");
        assert!(!beat.incognito_allowed);
        assert_eq!(beat.uid.as_deref(), Some("u1"));
    }

    #[test]
    fn only_web_guards_extension_id_is_accepted() {
        for origin in [
            None,
            Some("https://evil.example"),
            Some("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            Some("chrome-extension://pcmcaccnegefcjhdabjjfhaakjfeocea.evil.example"),
            Some("moz-extension://pcmcaccnegefcjhdabjjfhaakjfeocea"),
        ] {
            let r = request("127.0.0.1:47823", origin, OK_BODY);
            assert_eq!(accept_beat(&r, PORT, &ids()), Err(Rejected::WrongOrigin), "{:?}", origin);
        }
    }

    #[test]
    fn a_rebound_hostname_is_refused() {
        let r = request("evil.example:47823", Some(ORIGIN), OK_BODY);
        assert_eq!(accept_beat(&r, PORT, &ids()), Err(Rejected::WrongHost));
    }

    #[test]
    fn a_browser_it_cant_name_counts_for_nothing() {
        for browser in ["chromium", "vivaldi", ""] {
            let body = format!(r#"{{"browser":"{}","uid":"u1"}}"#, browser);
            let r = request("127.0.0.1:47823", Some(ORIGIN), &body);
            assert_eq!(accept_beat(&r, PORT, &ids()), Err(Rejected::UnidentifiedBrowser));
        }
    }

    #[test]
    fn other_routes_and_bad_bodies_are_refused() {
        let get = "GET /beat HTTP/1.1\r\nHost: 127.0.0.1:47823\r\n\r\n";
        assert_eq!(accept_beat(get, PORT, &ids()), Err(Rejected::NotFound));
        let bad = request("127.0.0.1:47823", Some(ORIGIN), "not json");
        assert_eq!(accept_beat(&bad, PORT, &ids()), Err(Rejected::BadBody));
    }

    #[test]
    fn a_dev_extension_id_must_look_like_one() {
        assert_eq!(allowed_extension_ids(None).len(), 1);
        assert_eq!(allowed_extension_ids(Some("short".into())).len(), 1);
        assert_eq!(allowed_extension_ids(Some("z".repeat(32))).len(), 1);
        assert_eq!(allowed_extension_ids(Some(format!("{}\n", "a".repeat(32)))).len(), 2);
    }

    fn body(browser: &str, uid: Option<&str>) -> BeatBody {
        BeatBody {
            browser: browser.into(),
            version: String::new(),
            incognito_allowed: true,
            uid: uid.map(str::to_string),
            profile_id: None,
            windows: None,
            locked: None,
            host_access: None,
        }
    }

    #[test]
    fn web_guard_signed_out_or_on_another_account_is_told_apart_from_no_web_guard() {
        let store = BeatStore::default();
        // No beat: can't tell.
        assert!(!store.wrong_account("edge", Some("u1"), 1_000));
        // Signed out.
        store.record(body("edge", None), 1, 1_000, false);
        assert!(store.wrong_account("edge", Some("u1"), 2_000));
        // Another account.
        store.record(body("chrome", Some("u2")), 1, 1_000, false);
        assert!(store.wrong_account("chrome", Some("u1"), 2_000));
        // This account: counts, so not wrong.
        store.record(body("brave", Some("u1")), 1, 1_000, false);
        assert!(!store.wrong_account("brave", Some("u1"), 2_000));
        // A stale beat says nothing either way.
        assert!(!store.wrong_account("edge", Some("u1"), 1_000 + FRESH_MS));
    }

    #[test]
    fn freshness_reads_the_clock_and_goes_stale_at_35_s() {
        let store = BeatStore::default();
        assert!(!store.is_fresh("chrome", Some("u1"), 1_000));
        store.record(body("chrome", Some("u1")), 1, 1_000, false);
        assert!(store.is_fresh("chrome", Some("u1"), 35_999));
        assert!(!store.is_fresh("chrome", Some("u1"), 36_000));
        assert!(!store.is_fresh("edge", Some("u1"), 1_000));
    }

    #[test]
    fn a_beat_only_counts_for_the_account_web_guard_is_signed_in_to() {
        let store = BeatStore::default();
        store.record(body("chrome", Some("u1")), 1, 1_000, false);
        assert!(!store.is_fresh("chrome", Some("u2"), 1_000));
        assert!(store.is_fresh("chrome", None, 1_000));
        // Signed out, it blocks nothing, so it never counts.
        store.record(body("chrome", None), 1, 2_000, false);
        assert!(!store.is_fresh("chrome", Some("u1"), 2_000));
        assert!(!store.is_fresh("chrome", None, 2_000));
    }

    #[test]
    fn the_server_records_over_a_real_socket_on_loopback_only() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        assert!(addr.ip().is_loopback());
        let store = Arc::new(BeatStore::default());
        let served = Arc::clone(&store);
        // Stands in for Windows saying the connection belongs to Edge, instance 42.
        fn edge(_: SocketAddr, _: SocketAddr) -> Option<Attested> {
            Some(Attested { browser: "edge", root: 42 })
        }
        let session: SessionFor = Arc::new(|uid: Option<&str>| SessionReply {
            active: uid == Some("u1"),
            end_time: Some(9_000),
            bailout_end: None,
        });
        std::thread::spawn(move || serve(listener, ids(), served, || 5_000, edge, session));

        let host = format!("127.0.0.1:{}", addr.port());
        let send = |text: String| {
            let mut s = TcpStream::connect(addr).unwrap();
            s.write_all(text.as_bytes()).unwrap();
            let mut reply = String::new();
            s.read_to_string(&mut reply).unwrap();
            reply
        };
        assert!(send(request(&host, Some("https://evil.example"), OK_BODY)).contains("403"));
        assert!(!store.is_fresh("edge", Some("u1"), 5_000));
        let reply = send(request(&host, Some(ORIGIN), OK_BODY));
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        // The reply carries the desktop's own session.
        let json: serde_json::Value = serde_json::from_str(reply.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({ "session": { "active": true, "endTime": 9000, "bailoutEnd": null } }));
        assert!(store.is_fresh("edge", Some("u1"), 5_000));
        let first = store.latest("edge", Some("u1")).unwrap();
        assert_eq!(first.root, 42);
        assert!(!first.told_active && first.replied_active);
        // The next beat was sent knowing about the session.
        send(request(&host, Some(ORIGIN), OK_BODY));
        assert!(store.latest("edge", Some("u1")).unwrap().told_active);
        // Another account's Web Guard isn't told about this session.
        let other = send(request(&host, Some(ORIGIN), &OK_BODY.replace("u1", "u2")));
        assert!(other.contains(r#""active":false"#), "{other}");
        // Claiming to be Chrome from a connection Windows says is Edge's.
        let chrome = OK_BODY.replace("\"edge\"", "\"chrome\"");
        assert!(send(request(&host, Some(ORIGIN), &chrome)).contains("403"));
        assert!(!store.is_fresh("chrome", Some("u1"), 5_000));
    }

    #[test]
    fn a_beat_counts_only_from_the_browser_it_names() {
        let b = body("chrome", Some("u1"));
        assert_eq!(attested_for(&b, None), Err(Rejected::NotABrowser));
        assert_eq!(attested_for(&b, Some(Attested { browser: "edge", root: 7 })), Err(Rejected::NotABrowser));
        assert_eq!(attested_for(&b, Some(Attested { browser: "chrome", root: 7 })), Ok(7));
    }

    /// The forged check-in from the Phase A red team: curl with Web Guard's
    /// Origin and a valid body, against the real attestation.
    #[test]
    fn a_forged_curl_check_in_is_refused() {
        let curl = std::path::Path::new(r"C:\Windows\System32\curl.exe");
        assert!(curl.is_file(), "curl.exe ships with Windows 10 1803+");
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let store = Arc::new(BeatStore::default());
        let served = Arc::clone(&store);
        let session: SessionFor = Arc::new(|_: Option<&str>| SessionReply { active: true, end_time: Some(9_000), bailout_end: None });
        std::thread::spawn(move || serve(listener, ids(), served, || 5_000, crate::attest::who, session));
        let out = std::process::Command::new(curl)
            .args([
                "-s", "-o", "NUL", "-w", "%{http_code}", "-X", "POST",
                "-H", &format!("Origin: {}", ORIGIN),
                "-H", "Content-Type: application/json",
                "--data", OK_BODY,
                &format!("http://127.0.0.1:{}/beat", port),
            ])
            .output()
            .unwrap();
        let code = String::from_utf8_lossy(&out.stdout).to_string();
        println!("curl got HTTP {}", code);
        assert_eq!(code, "403");
        assert!(store.all("edge").is_empty(), "nothing recorded");
    }

    #[test]
    fn a_busy_port_is_retried_with_backoff_and_reported_until_it_opens() {
        let squatter = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = squatter.local_addr().unwrap().port();
        let listening = Arc::new(AtomicBool::new(true));
        let failures = Arc::new(Mutex::new(Vec::new()));
        let squatter = Mutex::new(Some(squatter));
        let (l, f) = (Arc::clone(&listening), Arc::clone(&failures));
        let listener = bind_with_retry(
            port,
            &l,
            |n, e| f.lock().unwrap().push((n, e.kind())),
            |wait| {
                // While the port is busy: not listening, so lockdown falls back and says so.
                assert!(!listening.load(Ordering::SeqCst));
                assert!(crate::lockdown::falls_back_to_apps_only(false, true, listening.load(Ordering::SeqCst)));
                if failures.lock().unwrap().len() == 3 {
                    squatter.lock().unwrap().take(); // the other program lets go
                }
                assert!(wait <= Duration::from_secs(60));
            },
        );
        assert_eq!(listener.local_addr().unwrap().port(), port);
        assert!(listening.load(Ordering::SeqCst));
        let got = failures.lock().unwrap().clone();
        assert_eq!(got.iter().map(|(n, _)| *n).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(retry_delay(0), Duration::from_secs(1));
        assert_eq!(retry_delay(1), Duration::from_secs(2));
        assert_eq!(retry_delay(10), Duration::from_secs(60));
    }

    #[test]
    fn the_start_dialog_counts_only_web_guard_that_can_block_everywhere() {
        let store = BeatStore::default();
        store.record(body("chrome", Some("u1")), 1, 1_000, false);
        assert!(store.protects("chrome", Some("u1"), 2_000));
        let mut no_incognito = body("edge", Some("u1"));
        no_incognito.incognito_allowed = false;
        store.record(no_incognito, 2, 1_000, false);
        assert!(!store.protects("edge", Some("u1"), 2_000));
        let mut few_sites = body("brave", Some("u1"));
        few_sites.host_access = Some(false);
        store.record(few_sites, 3, 1_000, false);
        assert!(!store.protects("brave", Some("u1"), 2_000));
    }

    #[test]
    fn beats_are_kept_per_instance_and_profile() {
        let store = BeatStore::default();
        let mut a = body("chrome", Some("u1"));
        a.profile_id = Some("p1".into());
        let mut b = a.clone();
        b.profile_id = Some("p2".into());
        store.record(a.clone(), 10, 1_000, false);
        store.record(b, 10, 1_000, false);
        store.record(a, 20, 1_000, false);
        assert_eq!(store.all("chrome").len(), 3);
        // Forgotten after ten minutes.
        store.record(body("edge", Some("u1")), 1, 1_000 + FORGET_MS, false);
        assert_eq!(store.all("chrome").len(), 0);
    }
}
