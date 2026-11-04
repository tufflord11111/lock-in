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
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Fixed, because the extension has to know it. Bound to 127.0.0.1 only.
pub const PORT: u16 = 47823;
/// Web Guard's id on the Chrome Web Store. Edge and Brave install from there, so
/// they send the same one.
pub const WEB_GUARD_EXTENSION_ID: &str = "pcmcaccnegefcjhdabjjfhaakjfeocea";
/// The extension beats about every 30 s, so this tolerates one missed beat.
pub const FRESH_MS: u64 = 60_000;

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
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Beat {
    pub at: u64,
    pub incognito_allowed: bool,
    pub uid: Option<String>,
}

/// The latest beat per browser. In memory only: a beat means nothing later.
#[derive(Default)]
pub struct BeatStore {
    beats: Mutex<HashMap<String, Beat>>,
}

impl BeatStore {
    pub fn record(&self, body: BeatBody, now: u64) {
        if let Ok(mut beats) = self.beats.lock() {
            beats.insert(
                body.browser,
                Beat { at: now, incognito_allowed: body.incognito_allowed, uid: body.uid },
            );
        }
    }

    /// The browser's latest beat, if it counts for this account. Web Guard signed
    /// in to someone else isn't enforcing this session. With no account known
    /// (a session from before uids were stored), any signed-in Web Guard counts.
    pub fn latest(&self, browser: &str, uid: Option<&str>) -> Option<Beat> {
        let beats = self.beats.lock().ok()?;
        let beat = beats.get(browser)?;
        let counts = match (&beat.uid, uid) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some(a), Some(b)) => a == b,
        };
        counts.then(|| beat.clone())
    }

    pub fn is_fresh(&self, browser: &str, uid: Option<&str>, now: u64) -> bool {
        self.latest(browser, uid)
            .map_or(false, |b| now.saturating_sub(b.at) < FRESH_MS)
    }
}

#[derive(Debug, PartialEq)]
pub enum Rejected {
    NotFound,
    WrongHost,
    WrongOrigin,
    BadBody,
    UnidentifiedBrowser,
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
    let host_ok = header(head, "host").map_or(false, |h| {
        h == format!("127.0.0.1:{}", port) || h == format!("localhost:{}", port)
    });
    if !host_ok {
        return Err(Rejected::WrongHost);
    }
    let origin = header(head, "origin").unwrap_or("");
    let origin_ok = origin
        .strip_prefix("chrome-extension://")
        .map_or(false, |id| allowed_ids.iter().any(|a| a == id));
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

fn handle(mut stream: TcpStream, port: u16, allowed: &[String], store: &BeatStore, now: u64) {
    let status = match read_request(&mut stream) {
        None => "400 Bad Request",
        Some(request) => match accept_beat(&request, port, allowed) {
            Ok(beat) => {
                store.record(beat, now);
                "204 No Content"
            }
            Err(Rejected::NotFound) => "404 Not Found",
            Err(Rejected::WrongHost) | Err(Rejected::WrongOrigin) => "403 Forbidden",
            Err(Rejected::BadBody) | Err(Rejected::UnidentifiedBrowser) => "422 Unprocessable Entity",
        },
    };
    let _ = write!(stream, "HTTP/1.1 {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status);
}

/// Serve on this listener until the process ends. One at a time, each bounded by
/// the read timeout, so a stuck client costs at most a beat or two.
pub fn serve(listener: TcpListener, allowed: Vec<String>, store: Arc<BeatStore>, clock: fn() -> u64) {
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(PORT);
    for stream in listener.incoming().flatten() {
        handle(stream, port, &allowed, &store, clock());
    }
}

pub fn bind() -> std::io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", PORT))
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
        }
    }

    #[test]
    fn freshness_reads_the_clock_and_goes_stale_at_60_s() {
        let store = BeatStore::default();
        assert!(!store.is_fresh("chrome", Some("u1"), 1_000));
        store.record(body("chrome", Some("u1")), 1_000);
        assert!(store.is_fresh("chrome", Some("u1"), 60_999));
        assert!(!store.is_fresh("chrome", Some("u1"), 61_000));
        assert!(!store.is_fresh("edge", Some("u1"), 1_000));
    }

    #[test]
    fn a_beat_only_counts_for_the_account_web_guard_is_signed_in_to() {
        let store = BeatStore::default();
        store.record(body("chrome", Some("u1")), 1_000);
        assert!(!store.is_fresh("chrome", Some("u2"), 1_000));
        assert!(store.is_fresh("chrome", None, 1_000));
        // Signed out, it blocks nothing, so it never counts.
        store.record(body("chrome", None), 2_000);
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
        std::thread::spawn(move || serve(listener, ids(), served, || 5_000));

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
        assert!(send(request(&host, Some(ORIGIN), OK_BODY)).contains("204"));
        assert!(store.is_fresh("edge", Some("u1"), 5_000));
    }
}
