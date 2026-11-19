mod companion;
mod attest;
mod browsers;
mod clock;
mod coverage;
mod heartbeat;
mod integrity;
pub use integrity::scrub_webview2_env;
mod lockdown;
mod notify;

use companion::*;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State, Emitter};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(feature = "autostart")]
use tauri_plugin_autostart::ManagerExt;

// The store build takes neither plugin: the Store updates the package, and
// autostart is the package's StartupTask. Mixing them would register two
// autostart mechanisms and ship an updater the Store forbids.
#[cfg(all(feature = "store", any(feature = "updater", feature = "autostart")))]
compile_error!("feature \"store\" requires --no-default-features (no updater, no autostart plugin)");
use serde::{Serialize, Deserialize};
use sysinfo::{ProcessRefreshKind, System, UpdateKind};
use std::time::{SystemTime, UNIX_EPOCH};
use std::thread;
use std::path::PathBuf;

/// Emitted as "enforcer-stood-down" on EVERY Rust focus_active true→false
/// transition — emergency disarm, local or remote session end, deadline
/// expiry, and the restore-time stand-downs — so the session UI follows Rust
/// instead of running a countdown for a session nothing is enforcing.
#[derive(Clone, Serialize)]
struct StoodDownPayload {
    reason: String,
    retained_targets: usize,
    timestamp: u64,
}

// Every field carries #[serde(default)] so a truncated-but-parseable state file
// still deserializes into a safe (disarmed) value instead of failing outright.
#[derive(Serialize, Deserialize)]
struct LockProfile {
    #[serde(default)]
    is_locked: bool,
    #[serde(default = "default_lock_mode")]
    lock_mode: String,
    /// The currently-ARMED session kill list the enforcer loop reads. Set to
    /// `exe_approved` on session start, cleared on stop. Transient.
    #[serde(default)]
    exe_blacklist: HashSet<String>,
    /// Session app names the LOCAL user has APPROVED. The only names a session
    /// may ever kill (G1). A session arm — local or remote — enforces exactly
    /// this set, never the raw Firebase list.
    #[serde(default)]
    exe_approved: HashSet<String>,
    /// Session app names that arrived from a Firebase (remote) sync but have
    /// NOT been approved on this machine. Not enforced until approved.
    #[serde(default)]
    exe_pending: HashSet<String>,
    /// Session app names the local user just added on THIS PC (note_local_exe),
    /// not yet echoed back by Firebase. The only "added here" vouch (M4):
    /// nothing read from Firebase, such as blockedApps_meta, can approve a name.
    /// Used up when the name arrives in a sync.
    #[serde(default)]
    exe_added_here: HashSet<String>,
    /// False only on a new install (no state file): its first blocklist sync is
    /// approved as a whole, as the webview's old per-PC flag did. A state file
    /// from before this field has its own approvals, so it reads as true.
    #[serde(default = "default_true")]
    exe_migrated: bool,
    #[serde(default)]
    web_blacklist: HashSet<String>,
    #[serde(default)]
    permanent_exe: HashSet<String>,
    /// Permanent blocks that arrived from a Firebase (remote) sync but have NOT
    /// yet been confirmed on THIS machine. They are NOT enforced. A remote
    /// actor with the account can add to permanentExe, so a new permanent block
    /// must be approved locally (confirm_pending_permanent) before it can kill.
    /// Persisted so a pending prompt survives a restart.
    #[serde(default)]
    permanent_pending: HashSet<String>,
    #[serde(default)]
    focus_active: bool,
    /// Set by clear_all_blocks. While true, Firebase-driven syncs may not
    /// re-arm the enforcer — a reconnect would otherwise replay the stale
    /// config/focusActive:true that trapped the operator in the first place.
    /// Cleared only by an explicit session start (update_enforcement(true)).
    #[serde(default)]
    disarm_latch: bool,
    /// Wall-clock deadline (epoch ms) for the running focus session.
    ///
    /// Without this a restored session would never end: the countdown lives in
    /// a JS setInterval that dies with the webview, and the only caller of
    /// update_enforcement(false) is endSession — unreachable after a restart
    /// because React boots with isActive=false. The enforcer loop expires the
    /// session itself against this value.
    #[serde(default)]
    session_end_time: Option<u64>,
    /// Wall-clock deadline (epoch ms) of a bail-out fuse, or None.
    ///
    /// Bailing out does not stop the session — it starts a fuse. Enforcement
    /// continues untouched until this moment, and only then does the session
    /// end, voided. The value lives here, next to session_end_time, because it
    /// must survive both a restart and a sign-out: a fuse the operator could
    /// escape by quitting the app would not be a fuse.
    #[serde(default)]
    bailout_deadline: Option<u64>,
    /// Local calendar date ("YYYY-MM-DD") on which a bail-out was last armed.
    ///
    /// One per day. The webview supplies the date because "local calendar day"
    /// is a property of the operator's locale, not of this process; Rust still
    /// owns every comparison that decides whether the fuse has burned down.
    #[serde(default)]
    bailout_used_date: Option<String>,
    /// The UTC offset (minutes) when that bail-out was used. The day is also
    /// checked in that zone, so moving the time zone across midnight doesn't
    /// make a new day (1.3.1).
    #[serde(default)]
    bailout_used_offset_min: Option<i32>,
    /// Catches the clock being changed (clock.rs). Deadlines move with a jump,
    /// so a session lasts its planned time whatever the clock says.
    #[serde(default)]
    clock: clock::Watch,
    /// Keep running in the tray when the window is closed. A running session
    /// always hides, whatever this says.
    #[serde(default = "default_true")]
    close_to_tray: bool,
    /// How long this session has been enforced with the PC awake. Counted here
    /// by the enforcer, so neither a hidden window nor a throttled webview can
    /// change it. Time asleep, or with the app closed, simply isn't counted.
    #[serde(default)]
    session_awake_ms: u64,
    /// The session's label and owner, for its history entry.
    #[serde(default)]
    session_objective: Option<String>,
    #[serde(default)]
    session_uid: Option<String>,
    /// The operator chose "Start and close other browsers" for this session.
    #[serde(default)]
    browser_lockdown: bool,
    /// This session blocks websites: losing Web Guard mid-session matters.
    #[serde(default)]
    session_blocks_sites: bool,
    /// Finished sessions whose history entry hasn't reached Firebase. Only the
    /// signed-in webview can write it, so what's owed outlives the process and
    /// waits here until the webview confirms the write.
    #[serde(default)]
    pending_records: Vec<SessionRecord>,
    /// When the running session was armed (epoch ms). Restore checks the
    /// deadline and the awake time against it.
    #[serde(default)]
    session_started_at: Option<u64>,
    /// Permanent blocks removed while the session ran. They keep being killed
    /// until it ends: a removal mid-session takes effect after it.
    #[serde(default)]
    session_held_permanent: HashSet<String>,
    /// When this PC last ended a session (epoch ms). A server session that
    /// started before this has already ended here and is never re-armed.
    #[serde(default)]
    last_session_ended_at: Option<u64>,
    /// When the enforcer last looked at the clock. Not persisted: time with the
    /// app closed must not count as enforced.
    #[serde(skip)]
    last_clock_check: Option<u64>,
}

/// The history entry for a finished session, decided here when it ends.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct SessionRecord {
    ended_at: u64,
    minutes: u64,
    /// "completed" | "aborted" | "bailed-out"
    status: String,
    objective: String,
    uid: Option<String>,
}

/// More than this unsent means something is badly wrong; keep the newest.
const MAX_PENDING_RECORDS: usize = 100;

/// The enforcer looks at the clock every 2 s, so a gap this long means nothing
/// was running: asleep or hibernating. A forward clock edit reads the same way
/// and is no more deserving of credit.
const SLEEP_GAP_MS: u64 = 30_000;

/// How much of the time from `prev` to `now` counts as enforced. Nothing for a
/// gap, and nothing past the session's own end.
fn awake_in_gap(prev: u64, now: u64, session_end: Option<u64>) -> u64 {
    if now.saturating_sub(prev) >= SLEEP_GAP_MS {
        return 0;
    }
    session_end.map_or(now, |end| end.min(now)).saturating_sub(prev)
}

impl LockProfile {
    /// The clock was moved by `jump` ms. Every wall-clock time that measures
    /// this session moves with it, so the session still lasts its planned
    /// time, a Bail out fuse still takes five minutes, and the jump isn't
    /// counted as time enforced (or as sleep).
    fn shift_clock(&mut self, jump: i64) {
        if jump == 0 || !self.focus_active {
            return;
        }
        self.session_end_time = self.session_end_time.map(|t| clock::shifted(t, jump));
        self.bailout_deadline = self.bailout_deadline.map(|t| clock::shifted(t, jump));
        self.session_started_at = self.session_started_at.map(|t| clock::shifted(t, jump));
        self.last_clock_check = self.last_clock_check.map(|t| clock::shifted(t, jump));
    }

    /// Look at the clocks; if the wall clock was changed, move the session with it.
    fn watch_clock(&mut self, wall: u64, tick: u64) -> i64 {
        let jump = self.clock.observe(wall, tick);
        self.shift_clock(jump);
        jump
    }

    /// Called by the enforcer every tick, and when a session ends locally.
    fn note_clock(&mut self, now: u64) {
        if let (Some(prev), true) = (self.last_clock_check, self.focus_active) {
            self.session_awake_ms += awake_in_gap(prev, now, self.session_end_time);
        }
        self.last_clock_check = Some(now);
    }

    fn start_session(&mut self, now: u64, end_time: Option<u64>, objective: Option<String>, uid: Option<String>, browser_lockdown: bool, blocks_sites: bool) {
        self.browser_lockdown = browser_lockdown;
        self.session_blocks_sites = blocks_sites;
        self.session_end_time = end_time;
        self.session_awake_ms = 0;
        self.session_objective = objective;
        self.session_uid = uid;
        self.last_clock_check = Some(now);
        self.session_started_at = Some(now);
        self.session_held_permanent.clear();
        // Any fuse still set here belongs to a session that is over.
        self.bailout_deadline = None;
    }

    /// Stand down and decide what the session earned. A session is void once
    /// its fuse is armed, whichever deadline ended it. bailout_used_date and
    /// exe_blacklist stay: one bail-out per day, and standing config.
    fn end_session(&mut self, ended_at: u64) {
        self.end_session_as(ended_at, false);
    }

    /// end_session, with `never_completed` for an end that didn't happen with
    /// the enforcer watching (a restore, a clear): recorded aborted at best.
    fn end_session_as(&mut self, ended_at: u64, never_completed: bool) {
        let voided = self.bailout_deadline.is_some();
        let reached_end = !never_completed && self.session_end_time.is_some_and(|end| ended_at >= end);
        self.last_session_ended_at = Some(ended_at);
        self.session_started_at = None;
        self.session_held_permanent.clear();
        let minutes = if voided { 0 } else { self.session_awake_ms.div_ceil(60_000) };
        if voided || minutes > 0 {
            if self.pending_records.len() >= MAX_PENDING_RECORDS {
                self.pending_records.remove(0);
            }
            self.pending_records.push(SessionRecord {
                ended_at,
                minutes,
                status: if voided { "bailed-out" } else if reached_end { "completed" } else { "aborted" }.to_string(),
                objective: self.session_objective.take().unwrap_or_default(),
                uid: self.session_uid.take(),
            });
        }
        self.focus_active = false;
        self.session_end_time = None;
        self.bailout_deadline = None;
        self.session_awake_ms = 0;
        self.browser_lockdown = false;
        self.session_blocks_sites = false;
    }

    fn ack_record(&mut self, ended_at: u64) -> bool {
        let before = self.pending_records.len();
        self.pending_records.retain(|r| r.ended_at != ended_at);
        self.pending_records.len() != before
    }

    fn armed(&self) -> bool {
        self.focus_active
    }
}

fn default_true() -> bool {
    true
}

// "soft" everywhere by default — "hard" seizes the screen (fullscreen,
// always-on-top, no decorations) and no user has opted into that.
fn default_lock_mode() -> String {
    "soft".to_string()
}

/// How long the bail-out fuse burns. Long enough that bailing out is a
/// decision rather than a reflex, short enough to be a real escape hatch.
const BAILOUT_FUSE_MS: u64 = 5 * 60 * 1000;
/// Test builds with DEV_MODE burn the same five minutes: the rules refuse a
/// bailoutEnd under now + 270 s (1.3.1 B2), so a shorter dev fuse would end the
/// session in Rust while Firebase still held it.
#[cfg(feature = "dev-mode")]
const BAILOUT_FUSE_DEV_MS: u64 = 5 * 60 * 1000;

/// How long a fuse armed now burns. Without the dev-mode feature it is always
/// BAILOUT_FUSE_MS: no file, setting or variable can change it.
fn bailout_fuse_ms(app: &tauri::AppHandle) -> u64 {
    fuse_ms_for(|| is_dev_mode(app.clone()))
}

/// The fuse, given a way to ask whether DEV_MODE is on. A release build never
/// asks: the question, and the file behind it, only exist with dev-mode.
fn fuse_ms_for(dev_mode: impl FnOnce() -> bool) -> u64 {
    #[cfg(feature = "dev-mode")]
    if dev_mode() {
        return BAILOUT_FUSE_DEV_MS;
    }
    #[cfg(not(feature = "dev-mode"))]
    let _ = dev_mode;
    BAILOUT_FUSE_MS
}

/// Minimum length of a user-supplied block term.
///
/// The kill is a PowerShell wildcard `*<term>*`. A one- or two-character term
/// matches an enormous set of processes, and Stop-Process -Force destroys
/// unsaved work. Three characters is still loose, but it rules out the
/// catastrophic cases.
const MIN_BLOCK_TERM_LEN: usize = 3;

/// Processes that must never be killed, whatever the user blocked.
/// A term like "ser" matches services.exe via the wildcard; killing any of
/// these either destroys the session or takes the machine down.
const PROTECTED_PROCESSES: &[&str] = &[
    "explorer", "winlogon", "csrss", "services", "lsass", "svchost", "system",
    "smss", "wininit", "dwm", "taskmgr",
];

/// This binary's own process name: app.exe in the dev and direct-download builds,
/// Lock-In.exe in the Store build. Terms that would match it are refused.
fn own_process_stem() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let safe: String = exe
        .file_stem()?
        .to_str()?
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    (!safe.is_empty()).then_some(safe)
}

/// Lock-In's own window is this process, as are Teams' and Outlook's. Never killed.
/// It isn't in PROTECTED_PROCESSES because that check runs both ways, and "msedge"
/// must stay blockable: it closes Edge and now passes over this.
const WEBVIEW_PROCESS: &str = "msedgewebview2";

/// Where the images the kill pass never ends live on this PC (M8, M9). A
/// process is protected by its image path, not its name: a game copied to
/// svchost.exe, msedgewebview2.exe or app.exe in Downloads isn't.
/// Every path is lower case with `\` separators.
struct ImagePaths {
    /// %SystemRoot%, e.g. c:\windows.
    windir: String,
    /// This binary (current_exe).
    own_exe: Option<String>,
    /// The WebView2 runtime folders: …\Microsoft\EdgeWebView\Application\ under
    /// Program Files (x86), Program Files, and the per-user install.
    webview_dirs: Vec<String>,
}

fn norm_path(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

impl ImagePaths {
    fn of_this_pc() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let windir = norm_path(var("SystemRoot").as_deref().unwrap_or(r"C:\Windows")).trim_end_matches('\\').to_string();
        let own_exe = std::env::current_exe().ok().map(|p| norm_path(&p.to_string_lossy()));
        let webview_dirs = ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]
            .iter()
            .filter_map(|k| var(k))
            .map(|root| format!(r"{}\microsoft\edgewebview\application\", norm_path(&root).trim_end_matches('\\')))
            .collect();
        ImagePaths { windir, own_exe, webview_dirs }
    }
}

/// A path with `.` or `..` parts isn't trusted as being where it starts. Windows
/// reports images by their full canonical path, so a real one never has them.
fn plain_path(p: &str) -> bool {
    !p.split('\\').any(|part| part == "." || part == "..")
}

/// True for a file directly in `dir` or below it.
fn under(p: &str, dir: &str) -> bool {
    p.strip_prefix(dir).is_some_and(|rest| rest.starts_with('\\'))
}

/// M8: one of PROTECTED_PROCESSES running from where Windows keeps it
/// (System32, SysWOW64, or explorer.exe in %SystemRoot%). An image Windows
/// won't name to us at all (System, csrss under protection) is never killed.
fn is_windows_image(stem: &str, path: Option<&str>, paths: &ImagePaths) -> bool {
    if !PROTECTED_PROCESSES.contains(&stem) {
        return false;
    }
    let Some(p) = path.map(norm_path) else { return true };
    plain_path(&p)
        && (under(&p, &format!(r"{}\system32", paths.windir))
            || under(&p, &format!(r"{}\syswow64", paths.windir))
            || p == format!(r"{}\explorer.exe", paths.windir))
}

/// M9: WebView2, known by its image: msedgewebview2.exe inside a WebView2
/// runtime folder. Lock-In's window, and Teams' and Outlook's.
fn is_webview2_image(path: Option<&str>, paths: &ImagePaths) -> bool {
    let Some(p) = path.map(norm_path) else { return false };
    plain_path(&p)
        && p.ends_with(r"\msedgewebview2.exe")
        && paths.webview_dirs.iter().any(|d| p.starts_with(d.as_str()))
}

/// This binary, by its full path.
fn is_own_image(path: Option<&str>, paths: &ImagePaths) -> bool {
    matches!((path.map(norm_path), &paths.own_exe), (Some(p), Some(own)) if &p == own)
}

/// True when the only thing a term could match is the webview ("webview", "view2"),
/// so it would block nothing and should say so. "msedge" and "edge" also match Edge.
fn targets_only_webview(term: &str) -> bool {
    WEBVIEW_PROCESS.contains(term) && !"msedge".contains(term)
}

/// Lock-In and its own webview, from (pid, parent, image is WebView2): the root
/// and the WebView2 processes descended from it through WebView2 processes (M9).
/// Anything else Lock-In starts (a browser from "Install Web Guard", an app
/// opened from a shortcut) is the user's and stays blockable.
fn own_process_tree(processes: &[(u32, Option<u32>, bool)], root: u32) -> HashSet<u32> {
    let mut tree = HashSet::from([root]);
    loop {
        let before = tree.len();
        for (pid, parent, is_webview2) in processes {
            if *is_webview2 && parent.is_some_and(|p| tree.contains(&p)) {
                tree.insert(*pid);
            }
        }
        if tree.len() == before {
            return tree;
        }
    }
}

fn own_tree_of(sys: &System, paths: &ImagePaths) -> HashSet<u32> {
    let processes: Vec<(u32, Option<u32>, bool)> = sys
        .processes()
        .iter()
        .map(|(pid, p)| {
            let exe = p.exe().map(|e| e.to_string_lossy());
            (pid.as_u32(), p.parent().map(|x| x.as_u32()), is_webview2_image(exe.as_deref(), paths))
        })
        .collect();
    own_process_tree(&processes, std::process::id())
}

/// End a process directly. sysinfo's own kill isn't used because on Windows it
/// spawns a hidden `taskkill.exe /PID n /F` for each process, every time. This is the
/// same forced end, with no extra process. Exit code 1, as taskkill /F gives.
fn terminate_process(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) else {
            return false;
        };
        let ended = TerminateProcess(handle, 1).is_ok();
        let _ = CloseHandle(handle);
        ended
    }
}

/// The kill pass's whole decision for one process, from its name stem and its
/// image path (None when Windows won't give it).
fn may_kill(stem: &str, pid: u32, image: Option<&str>, term: &str, paths: &ImagePaths, own_tree: &HashSet<u32>) -> bool {
    stem.contains(term)
        && !is_windows_image(stem, image, paths)
        && !is_webview2_image(image, paths)
        && !is_own_image(image, paths)
        && !own_tree.contains(&pid)
}

/// True when a block term would match this binary's own process.
///
/// One way only. The kill is `*term*` over process names, so only a term inside
/// our name can hit us. The reverse would refuse "whatsapp" for containing "app",
/// which can never match app.exe.
fn targets_own_process(term: &str, own_stem: &str) -> bool {
    own_stem.contains(term)
}

/// True when a block term would target a protected process.
///
/// Checked both ways: "ser" must be rejected because it matches "services"
/// through the wildcard, and "explorer2" because it contains "explorer".
fn targets_protected(term: &str, protected: &[String]) -> bool {
    protected
        .iter()
        .any(|p| p.contains(term) || term.contains(p.as_str()))
}

/// Apps a user very plausibly has unsaved work open in. NOT refused — for some
/// users these ARE the distraction, and blocking them is the product — but the
/// UI must show a stronger confirmation and Rust logs [Guard] WARN so the
/// choice is on the record. Entries carry both the friendly name and the real
/// process stem (Word is winword.exe, PowerPoint is powerpnt.exe) because the
/// wildcard matches process names, not display names.
const WARN_PROCESSES: &[&str] = &[
    "code", "cursor", "devenv", "idea", "pycharm", "webstorm", "sublime",
    "sublime_text", "notepad", "notepad++", "word", "winword", "excel",
    "powerpoint", "powerpnt", "outlook", "claude", "chatgpt", "obsidian",
    "notion", "figma", "photoshop", "blender", "terminal", "windowsterminal",
    "wt", "git",
];

/// True when a block term would hit a common work app. Same both-ways
/// substring test as the protected list.
fn targets_work_app(term: &str) -> bool {
    WARN_PROCESSES
        .iter()
        .any(|p| p.contains(term) || term.contains(p))
}

/// Single source of truth for what a block entry means. Used by BOTH the
/// enforcer (sanitize_block_entry) and the UI (classify_block_entry) so the
/// confirmation dialog and the kill loop can never disagree.
///
/// Ok((cleaned, warn)) — usable; `warn` means it hits a common work app.
/// Err(reason)         — refused, with the reason the UI should show.
fn analyze_block_entry(raw: &str) -> Result<(String, bool), String> {
    let clean: String = raw
        .to_lowercase()
        .replace(".exe", "")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();

    if clean.len() < MIN_BLOCK_TERM_LEN {
        return Err(format!(
            "too short — block terms need at least {} characters (it is matched as *{}*, so a short term hits far too many processes)",
            MIN_BLOCK_TERM_LEN, clean
        ));
    }
    let system: Vec<String> = PROTECTED_PROCESSES.iter().map(|s| s.to_string()).collect();
    if targets_protected(&clean, &system)
        || targets_only_webview(&clean)
        || own_process_stem().is_some_and(|own| targets_own_process(&clean, &own))
    {
        return Err(
            "would match a protected Windows system process (explorer, csrss, lsass, svchost…) or Lock-In itself — killing those crashes the machine or the enforcer".to_string(),
        );
    }
    Ok((clean.clone(), targets_work_app(&clean)))
}

/// Normalize and validate a user-supplied block entry for the enforcer.
/// Returns None — with a logged reason — when the entry is unusable or unsafe.
fn sanitize_block_entry(raw: &str) -> Option<String> {
    match analyze_block_entry(raw) {
        Ok((clean, warn)) => {
            if warn {
                println!(
                    "[Guard] WARN block entry {:?} — common work app; it WILL be force-closed without a save prompt while a session runs",
                    raw
                );
            }
            Some(clean)
        }
        Err(reason) => {
            println!("[Guard] REJECTED block entry {:?} — {}", raw, reason);
            None
        }
    }
}

// ─── IPC Command: classify_block_entry ───────────────────────────────────────
// The UI calls this BEFORE writing a block entry to Firebase, so the operator
// sees the verdict — ok / warn / rejected, with the reason — instead of the
// entry silently vanishing at the Rust boundary.
#[derive(Serialize)]
struct BlockEntryVerdict {
    /// "ok" | "warn" | "rejected"
    verdict: String,
    cleaned: Option<String>,
    reason: Option<String>,
}

#[tauri::command]
fn classify_block_entry(raw: String) -> BlockEntryVerdict {
    match analyze_block_entry(&raw) {
        Ok((clean, warn)) => BlockEntryVerdict {
            verdict: if warn { "warn" } else { "ok" }.to_string(),
            cleaned: Some(clean),
            reason: if warn {
                Some("This is a common work app. It will be force-closed immediately, without a save prompt, every 2 seconds while a session is running.".to_string())
            } else {
                None
            },
        },
        Err(reason) => BlockEntryVerdict {
            verdict: "rejected".to_string(),
            cleaned: None,
            reason: Some(reason),
        },
    }
}

/// Kill every running process whose name contains `term`, in-process.
///
/// Replaces the old PowerShell `Get-Process | Where-Object { $_.Name -like
/// '*term*' } | Stop-Process -Force` spawn. Semantics are preserved exactly:
///
///   * substring match on the process name, the `*term*` wildcard;
///   * case-insensitive, as PowerShell's `-like` was. sysinfo's own
///     `processes_by_name` is case-SENSITIVE `contains`, so it is deliberately
///     not used — it would silently stop matching `Spotify.exe`;
///   * matched against the name without its `.exe` suffix, which is what
///     PowerShell's `$_.Name` exposed;
///   * protected processes are re-checked here, by image path (may_kill: M8,
///     M9), so this stays a second boundary behind sanitize_block_entry
///     rather than replacing it.
///
/// Caller must refresh `sys` first, with exe paths. Returns the names actually
/// terminated.
fn kill_processes_matching(sys: &System, term: &str, paths: &ImagePaths) -> Vec<String> {
    let mut killed = Vec::new();
    let own_tree = own_tree_of(sys, paths);
    for (pid, process) in sys.processes() {
        let lowered = process.name().to_lowercase();
        let stem = lowered.strip_suffix(".exe").unwrap_or(&lowered);
        let image = process.exe().map(|e| e.to_string_lossy());
        if !may_kill(stem, pid.as_u32(), image.as_deref(), term, paths, &own_tree) {
            continue;
        }
        if terminate_process(pid.as_u32()) {
            killed.push(stem.to_string());
        }
    }
    killed
}

struct AppState {
    profile: Arc<Mutex<LockProfile>>,
    /// None when app_data_dir() failed: enforcement runs from memory only and
    /// nothing is written. There is deliberately no relative-path fallback —
    /// the working directory of a packaged (MSIX) app is not writable, and of
    /// an NSIS one is wherever it was launched from.
    state_path: Option<PathBuf>,
    /// Why state_path is None, for get_enforcer_state to surface.
    persist_error: Option<String>,
    /// The other kind of install is also on this PC. See other_install_present.
    other_install: bool,
    beats: Arc<heartbeat::BeatStore>,
    /// The webview's reachability probe. False until it first reports.
    online: Arc<AtomicBool>,
    /// False while the heartbeat port can't be opened, so no beat can arrive.
    /// A thread keeps retrying (heartbeat::bind_with_retry).
    heartbeat_listening: Arc<AtomicBool>,
}

/// An extra accepted extension id, for an unpacked test copy of Web Guard. Read
/// from DEV_EXTENSION_ID beside DEV_MODE, and only when DEV_MODE exists, in a
/// dev-mode test build. A release build accepts only the store's id.
#[cfg(feature = "dev-mode")]
fn dev_extension_id(app: &tauri::AppHandle) -> Option<String> {
    if !is_dev_mode(app.clone()) {
        return None;
    }
    let dir = app.path().app_data_dir().ok()?;
    std::fs::read_to_string(dir.join("DEV_EXTENSION_ID")).ok()
}

#[cfg(not(feature = "dev-mode"))]
fn dev_extension_id(_app: &tauri::AppHandle) -> Option<String> {
    None
}

/// True when the Store package and a direct-download install are both here.
/// They look identical in the Start menu but keep separate state, and whichever
/// starts second hands off to the first, so it's easy to be running the wrong one
/// without knowing: that cost a whole laptop test of 1.2.9 on the Store's 1.2.8.
fn other_install_present(store_build: bool, package_exists: bool, direct_exists: bool) -> bool {
    if store_build { direct_exists } else { package_exists }
}

fn detect_other_install() -> bool {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_default();
    other_install_present(
        cfg!(feature = "store"),
        local.join("Packages").join("Lock-In.Lock-In_gfjpe7j35ca8g").is_dir(),
        local.join("Lock-In").join("app.exe").is_file()
            || program_files.join("Lock-In").join("app.exe").is_file(),
    )
}

/// What this copy is, in words a person can match to Settings > Apps.
fn build_label() -> String {
    let kind = if cfg!(feature = "store") { "Microsoft Store" } else { "direct download" };
    format!("{} ({})", env!("CARGO_PKG_VERSION"), kind)
}

/// Every running process that is a known browser, by browser id.
fn running_browsers(sys: &mut System) -> std::collections::HashMap<&'static str, Vec<u32>> {
    sys.refresh_processes_specifics(ProcessRefreshKind::new().with_exe(UpdateKind::OnlyIfNotSet));
    let mut found: std::collections::HashMap<&'static str, Vec<u32>> = std::collections::HashMap::new();
    for (pid, process) in sys.processes() {
        let name = process.name().to_lowercase();
        let stem = name.strip_suffix(".exe").unwrap_or(&name);
        let path = process.exe().map(|p| p.to_string_lossy().to_lowercase());
        if let Some(id) = browsers::identify(stem, path.as_deref()) {
            found.entry(id).or_default().push(pid.as_u32());
        }
    }
    found
}

/// WM_CLOSE to these processes' top-level windows, the way the X button asks.
fn post_close_to_windows(pids: &[u32]) {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
    };
    unsafe extern "system" fn close_if_ours(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let pids = unsafe { &*(lparam.0 as *const Vec<u32>) };
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pids.contains(&pid) && IsWindowVisible(hwnd).as_bool() {
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
        BOOL(1)
    }
    let pids = pids.to_vec();
    unsafe {
        let _ = EnumWindows(Some(close_if_ours), LPARAM(&pids as *const Vec<u32> as isize));
    }
}

#[derive(Clone, Serialize)]
struct LockdownWarningPayload {
    message: String,
}

/// Put a warning in front of the operator, wherever the window is. The toast also
/// goes out every time, so it's there when the window is next looked at.
fn deliver_warning(app: &tauri::AppHandle, title: &str, message: String) {
    let _ = app.emit("lockdown-warning", LockdownWarningPayload { message: message.clone() });
    let focused = app
        .get_webview_window("main")
        .is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    if focused {
        return;
    }
    let shown = notify::show_windows_notification(title, &message);
    if let Err(e) = &shown {
        println!("[Lockdown] notification not shown ({}) — showing the window", e);
    }
    if notify::route(focused, shown.is_ok()) == notify::Route::ShowWindow {
        show_main_window(app);
    }
}

/// Said once in a session that would close browsers when the heartbeat port
/// couldn't open, so none can prove it runs Web Guard.
const APPS_ONLY_NOTICE: &str = "Lock-In can't check your browsers, so this session falls back to blocking apps only: it won't close any browser. Web Guard still blocks sites where it's installed. Lock-In keeps trying and starts checking browsers again as soon as it can.";

/// Said where Web Guard is running but doesn't count for this session's account.
const WRONG_ACCOUNT: &str = "Web Guard is installed but signed in to a different account or signed out — sign in with this account to keep this browser open.";

/// What the 10-second warning says. A browser that can run Web Guard is told how
/// to stay open next time, with the Store link (the toast can't hold a button).
/// `wrong_account`: Web Guard beats from it, signed out or on another account.
fn lockdown_warning(browser: &str, lost_web_guard: bool, wrong_account: bool, gap: Option<coverage::Gap>) -> String {
    let name = browsers::name_of(browser);
    let after = if lost_web_guard { " Once closed, it stays closed until the session ends." } else { "" };
    if !wrong_account {
        match gap {
            Some(coverage::Gap::UnseenWindows) => {
                return format!("{name} has a window Web Guard can't see: a Guest window, another profile, or an Incognito window. Closing {name} in 10 seconds. Save anything you've typed.{after}");
            }
            Some(coverage::Gap::UnseenIncognito) => {
                return format!("{name} has a window Web Guard can't see, most likely an Incognito window: Web Guard isn't allowed in Incognito. Closing {name} in 10 seconds. Save anything you've typed. To keep Incognito windows open during sessions, turn on \"Allow in Incognito\" for Lock-In Web Guard in {name}'s extension settings.{after}");
            }
            Some(coverage::Gap::SiteAccess) => {
                return format!("Web Guard can't reach every site in {name}: its site access is limited. Closing {name} in 10 seconds. Save anything you've typed. To keep it open, set Lock-In Web Guard's site access to \"On all sites\" in {name}'s extension settings.{after}");
            }
            Some(coverage::Gap::NotLocked) => {
                return format!("Web Guard in {name} isn't blocking this session. Closing {name} in 10 seconds. Save anything you've typed.{after}");
            }
            _ => {}
        }
    }
    if wrong_account {
        let after = if lost_web_guard { " Once closed, it stays closed until the session ends." } else { "" };
        format!("Closing {name} in 10 seconds. Save anything you've typed. {WRONG_ACCOUNT}{after}")
    } else if lost_web_guard {
        format!("Web Guard stopped answering in {name}. Closing it in 10 seconds, and it stays closed until the session ends. Save anything you've typed.")
    } else if browsers::takes_web_guard(browser) {
        format!("Closing {name} in 10 seconds. Save anything you've typed. Install Web Guard in this browser to keep using it during sessions, signed in to this Lock-In account: {WEB_GUARD_STORE_URL}")
    } else {
        format!("Closing {name} in 10 seconds. Save anything you've typed. Lock-In can't block sites in it during this session.")
    }
}

/// Run lockdown for as long as the app runs. Only looks at processes during a
/// session that uses it, so the rest of the time this is one lock a second.
fn lockdown_runner(
    app: tauri::AppHandle,
    profile: Arc<Mutex<LockProfile>>,
    beats: Arc<heartbeat::BeatStore>,
    online: Arc<AtomicBool>,
    listening: Arc<AtomicBool>,
) {
    let mut sys = System::new();
    let mut tracker = lockdown::Tracker::default();
    let mut grace = coverage::Grace::default();
    let mut session_key = None;
    let mut told_apps_only = None;
    let started = std::time::Instant::now();
    loop {
        thread::sleep(std::time::Duration::from_secs(1));
        let listening = listening.load(Ordering::SeqCst);
        let (active, in_lockdown, apps_only, blocks_sites, end, uid) = match profile.lock() {
            Ok(p) => (
                p.focus_active && (p.browser_lockdown || p.session_blocks_sites),
                // A session that blocks sites closes browsers without Web Guard, however it started.
                lockdown::lockdown_applies(p.browser_lockdown, p.session_blocks_sites, listening),
                lockdown::falls_back_to_apps_only(p.browser_lockdown, p.session_blocks_sites, listening),
                p.session_blocks_sites,
                p.session_end_time,
                p.session_uid.clone(),
            ),
            Err(_) => continue,
        };
        if session_key != end || !active {
            tracker.reset();
            grace.reset();
            session_key = end;
        }
        if !active {
            continue;
        }
        // Once per session, and not before the window has had a moment to load
        // (a session restored at launch would otherwise emit to no one).
        if apps_only && told_apps_only != end && started.elapsed() >= std::time::Duration::from_secs(5) {
            told_apps_only = end;
            log_ui_event(&app, "lockdown-apps-only");
            deliver_warning(&app, "Lock-In isn't closing browsers", APPS_ONLY_NOTICE.to_string());
        }
        let running = running_browsers(&mut sys);
        let ids: Vec<&'static str> = running.keys().copied().collect();
        // Every instance of a browser (one per user-data-dir) needs its own beat,
        // and its beats must see every window it has (coverage.rs).
        let instances = attest::instances(&sys);
        let windows = attest::chromium_windows_by_pid();
        let now = now_millis();
        let mut verdicts: std::collections::HashMap<&'static str, coverage::Verdict> = std::collections::HashMap::new();
        let mut covered: std::collections::HashMap<&'static str, Option<u64>> = std::collections::HashMap::new();
        for id in &ids {
            let inst: Vec<coverage::Instance> = instances
                .get(id)
                .map(|roots| roots.iter().map(|r| coverage::Instance { root: *r, windows: windows.get(r).copied().unwrap_or(0) }).collect())
                .unwrap_or_default();
            let v = coverage::brand(&inst, &beats.all(id), uid.as_deref(), now, heartbeat::FRESH_MS);
            verdicts.insert(id, v);
            covered.insert(id, grace.last_beat(id, v, now));
        }
        let last_beat = |b: &str| covered.get(b).copied().flatten();
        let tick = lockdown::Tick {
            now,
            lockdown: in_lockdown,
            blocks_sites,
            online: online.load(Ordering::Relaxed),
            running: &ids,
            last_beat: &last_beat,
            fresh_ms: heartbeat::FRESH_MS,
        };
        for action in tracker.tick(&tick) {
            match action {
                // Nothing on screen to lose or to warn about, like Edge's startup
                // boost in the background. It still closes on time.
                lockdown::Action::Warn { browser, .. }
                    if !running.get(browser).is_some_and(|pids| {
                        let open = pids_with_windows();
                        pids.iter().any(|p| open.contains(p))
                    }) => {}
                lockdown::Action::Warn { browser, lost_web_guard } => {
                    let wrong_account = beats.wrong_account(browser, uid.as_deref(), now_millis());
                    let gap = verdicts.get(browser).and_then(|v| v.gap);
                    log_ui_event(&app, "lockdown-warned");
                    deliver_warning(&app, "Lock-In is closing a browser", lockdown_warning(browser, lost_web_guard, wrong_account, gap));
                }
                lockdown::Action::SoftClose { browser } => {
                    if let Some(pids) = running.get(browser) {
                        post_close_to_windows(pids);
                    }
                }
                lockdown::Action::ForceClose { browser } => {
                    if let Some(pids) = running.get(browser) {
                        for pid in pids {
                            terminate_process(*pid);
                        }
                    }
                    println!("[Lockdown] closed {}", browser);
                    log_ui_event(&app, "lockdown-closed");
                }
            }
        }
    }
}

/// What Web Guard is told about this PC's session in reply to a beat. Only a
/// session that blocks sites, only to Web Guard signed in to its account.
fn session_reply(p: &LockProfile, uid: Option<&str>, now: u64) -> heartbeat::SessionReply {
    let same_account = match (&p.session_uid, uid) {
        (Some(a), Some(b)) => a == b,
        (None, Some(_)) => true,
        _ => false,
    };
    let live = p.focus_active && p.session_blocks_sites && p.session_end_time.is_some_and(|e| e > now);
    if !(live && same_account) {
        return heartbeat::SessionReply::default();
    }
    heartbeat::SessionReply { active: true, end_time: p.session_end_time, bailout_end: p.bailout_deadline }
}

/// Epoch milliseconds, monotonic enough for a wall-clock session deadline.
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Push a focus_active true→false transition to the UI. Called from every
/// site that stands the enforcer down, so the React countdown can never keep
/// running for a session Rust has already stopped enforcing.
fn emit_stood_down(app: &tauri::AppHandle, reason: &str, retained_targets: usize) {
    let _ = app.emit(
        "enforcer-stood-down",
        StoodDownPayload {
            reason: reason.to_string(),
            retained_targets,
            timestamp: now_millis(),
        },
    );
}

/// Notify the UI that new permanent blocks arrived from a remote sync and are
/// waiting for local approval (F4). They are NOT enforced until approved.
fn emit_permanent_pending(app: &tauri::AppHandle, pending: &HashSet<String>) {
    let names: Vec<String> = pending.iter().cloned().collect();
    let _ = app.emit("permanent-pending", names);
}

/// Same, for session (blockedApps) blocks staged from a remote sync (G1).
fn emit_exe_pending(app: &tauri::AppHandle, pending: &HashSet<String>) {
    let names: Vec<String> = pending.iter().cloned().collect();
    let _ = app.emit("exe-pending", names);
}

/// Clear EVERY block — session targets, permanent blocks, and unapproved
/// pending ones — and stand the enforcer fully down. Used by clear_all_blocks,
/// the always-available escape on the Login and degraded screens. Sets the
/// disarm latch so a Firebase reconnect cannot silently
/// re-arm. Caller persists, emits, and logs.
fn wipe_all_blocks(profile: &mut LockProfile) -> (usize, usize) {
    let cleared_session = profile.exe_approved.len().max(profile.exe_blacklist.len());
    let cleared_permanent = profile.permanent_exe.len();
    profile.is_locked = false;
    profile.focus_active = false;
    profile.lock_mode = "soft".to_string();
    profile.exe_blacklist.clear();
    profile.exe_approved.clear();
    profile.exe_pending.clear();
    profile.exe_added_here.clear();
    profile.permanent_exe.clear();
    profile.permanent_pending.clear();
    profile.session_held_permanent.clear();
    profile.session_end_time = None;
    profile.session_started_at = None;
    // A clear is a stand-down too. A fuse left behind would void the next
    // session on its first tick. bailout_used_date stays: one per day.
    profile.bailout_deadline = None;
    profile.browser_lockdown = false;
    profile.session_blocks_sites = false;
    profile.disarm_latch = true;
    (cleared_session, cleared_permanent)
}

/// What closing the window does. Hide keeps the enforcer thread alive.
fn close_hides(armed: bool, close_to_tray: bool) -> bool {
    armed || close_to_tray
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// True when Windows started us (the plugin's Run key passes this) at sign-in.
fn is_silent_launch<S: AsRef<str>>(args: &[S]) -> bool {
    args.iter().any(|a| a.as_ref() == "--silently")
}

/// How the dashboard comes up at launch, after the network delay.
#[derive(Debug, PartialEq)]
enum BootShow {
    /// Started by hand: shown and focused, as ever.
    ShowAndFocus,
    /// Started by Windows at sign-in: shown, so the dashboard is there with the
    /// parrot, but not activated, so it doesn't take the keyboard from whatever
    /// the user opened first. (1.2.10 kept it in the tray.)
    ShowWithoutFocus,
}

fn boot_show(silent: bool) -> BootShow {
    if silent {
        BootShow::ShowWithoutFocus
    } else {
        BootShow::ShowAndFocus
    }
}

/// Shows a window without activating it: SW_SHOWNOACTIVATE, not Tauri's show(),
/// which activates.
fn show_without_focus(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(HWND(hwnd.0), SW_SHOWNOACTIVATE);
        }
    }
}

const WEB_GUARD_STORE_URL: &str = "https://chromewebstore.google.com/detail/pcmcaccnegefcjhdabjjfhaakjfeocea";

const QUIT_REFUSED_MESSAGE: &str = "A session is running. Use Bail out.";

#[derive(Clone, Serialize)]
struct QuitRefusedPayload {
    reason: String,
}

/// The tray's Quit rule: never while a session runs.
fn quit_allowed(armed: bool) -> bool {
    !armed
}

/// The tray's Quit. Refused while armed; Task Manager still ends the app, as
/// the site FAQ says, but the tray won't be the way out of a session.
fn tray_quit(app: &tauri::AppHandle) {
    let armed = app
        .state::<AppState>()
        .profile
        .lock()
        .map(|p| p.armed())
        .unwrap_or(false);
    if !quit_allowed(armed) {
        println!("[Tray] Quit refused — a session is running");
        log_ui_event(app, "quit-refused");
        show_main_window(app);
        let _ = app.emit(
            "quit-refused",
            QuitRefusedPayload { reason: QUIT_REFUSED_MESSAGE.to_string() },
        );
        return;
    }
    app.exit(0);
}

/// Write the profile to disk. MUST be called while holding the profile lock so
/// the file can never disagree with memory.
///
/// Writes to a sibling .tmp then renames — a process killed mid-write leaves the
/// previous good file intact rather than a truncated one.
fn persist_profile(profile: &LockProfile, path: &Option<PathBuf>) {
    // No state path: in-memory only (see AppState::state_path).
    let Some(path) = path else { return };
    let json = match serde_json::to_string_pretty(profile) {
        Ok(j) => j,
        Err(e) => {
            println!("[Persist] serialize failed: {}", e);
            return;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            println!("[Persist] could not create state dir: {}", e);
            return;
        }
    }
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, json) {
        println!("[Persist] write failed: {}", e);
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        println!("[Persist] rename failed: {}", e);
    }
}

/// Load persisted state at boot. Any failure — missing file, corrupt JSON,
/// poisoned mutex — logs and leaves the in-memory default (fully disarmed).
/// Never panics.
fn restore_profile(profile: &Arc<Mutex<LockProfile>>, path: &PathBuf, app: &tauri::AppHandle) {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) => {
            println!("[Persist] no saved state ({}) — booting disarmed", e);
            return;
        }
    };
    let restored: LockProfile = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(e) => {
            println!("[Persist] state file CORRUPT ({}) — booting disarmed", e);
            return;
        }
    };
    let mut p = match profile.lock() {
        Ok(p) => p,
        Err(e) => {
            println!("[Persist] mutex poisoned during restore ({}) — booting disarmed", e);
            return;
        }
    };
    *p = restored;

    // A clock moved while Lock-In was closed (and the PC didn't restart)
    // moves the deadlines before they are judged.
    let jump = p.watch_clock(now_millis(), clock::tick64());
    if jump != 0 {
        println!("[Clock] the clock moved {} ms while Lock-In was closed", jump);
    }

    // Every rule for a restored profile lives in integrity::settle_restored.
    // Emits are inert at boot (no webview is listening yet) but keep every
    // stand-down on the same path; the pull probe on first auth covers it.
    for reason in integrity::settle_restored(&mut p, now_millis()) {
        println!("[Persist] restore stood the session down: {}", reason);
        emit_stood_down(app, reason, p.exe_blacklist.len());
    }

    println!(
        "[Persist] restored — locked={}, focus={}, exe={}, perm={}, latch={}, end={:?}",
        p.is_locked,
        p.focus_active,
        p.exe_blacklist.len(),
        p.permanent_exe.len(),
        p.disarm_latch,
        p.session_end_time
    );
}

// ─── IPC Command: sync_lock_state ─────────────────────────────────────────────
// Called by useOmniSync whenever lock state or blocklist changes.
// Returns Ok so the JS promise resolves (not rejects), flipping engineOffline → false.
#[tauri::command]
fn sync_lock_state(
    is_locked: bool,
    lock_mode: String,
    blacklist: Vec<String>,
    focus_active: bool,
    app_state: State<AppState>,
) -> Result<String, String> {
    match app_state.profile.lock() {
        Ok(mut profile) => {
            // focus_active is deliberately NOT written here. Session lifecycle
            // belongs to update_enforcement alone. React fires this command
            // twice at boot with un-hydrated defaults (focusActive=false), which
            // was clobbering a focus_active=true restored from disk.
            if focus_active != profile.focus_active {
                println!(
                    "[Enforcer] sync_lock_state focus_active={} IGNORED (owned by update_enforcement, current={})",
                    focus_active, profile.focus_active
                );
            }

            // Disarm latch still guards is_locked — a reconnect must not re-arm
            // the other half of `enforcer_active = is_locked || focus_active`.
            if profile.disarm_latch {
                println!(
                    "[Enforcer] disarm latch ACTIVE — ignoring is_locked={} from sync_lock_state",
                    is_locked
                );
            } else {
                profile.is_locked = is_locked;
            }
            profile.lock_mode = lock_mode.clone();
            // Strip .exe suffix and lowercase for robust matching
            profile.web_blacklist = blacklist
                .into_iter()
                .map(|s| s.to_lowercase().replace(".exe", ""))
                .collect();
            println!(
                "[Enforcer] Synced — locked={}, mode={}, focus={}, web_blocks={:?}",
                profile.is_locked, lock_mode, profile.focus_active, profile.web_blacklist
            );
            persist_profile(&profile, &app_state.state_path);
            Ok("Engine synced".to_string())
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

// ─── IPC Command: check_sniper ────────────────────────────────────────────────
// Called during onboarding calibration to verify the sniper subsystem can read
// this machine's processes. Returns { ready, message }.
#[derive(Clone, Serialize)]
struct SniperStatus {
    ready: bool,
    message: String,
}

/// Blocking works by reading the process table and killing from it, in-process,
/// so that's what's checked: can we see processes, ourselves included.
fn process_table_readable() -> bool {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessRefreshKind::new());
    sys.process(sysinfo::Pid::from_u32(std::process::id())).is_some()
}

fn sniper_status(readable: bool) -> SniperStatus {
    if readable {
        SniperStatus {
            ready: true,
            message: "Sniper subsystem online. Process termination active.".to_string(),
        }
    } else {
        SniperStatus {
            ready: false,
            message: "Sniper subsystem degraded — run as Administrator.".to_string(),
        }
    }
}

#[tauri::command]
fn check_sniper() -> SniperStatus {
    sniper_status(process_table_readable())
}

/// Why a session with this deadline must not be armed, if it mustn't.
/// No deadline: it would never expire on its own. A past deadline: the loop
/// could run a kill pass before its next expiry check.
fn arm_refusal(end_time: Option<u64>, now: u64) -> Option<String> {
    match end_time {
        None => Some("the session has no end time".to_string()),
        Some(end) if end <= now => Some(format!(
            "the session's end time passed {} ms ago",
            now - end
        )),
        Some(_) => None,
    }
}

/// What update_enforcement does with a request. Pure, so the rules can be tested.
#[derive(Debug, PartialEq)]
enum EnforcementDecision {
    Arm,
    StandDown,
    /// Another device's session ending must not end the one running here. The
    /// armed session still ends at its own deadline or fuse.
    IgnoreRemoteStop,
    /// A session started elsewhere has no countdown or Bail out on this
    /// desktop, so it would kill apps behind an idle-looking dashboard.
    RefuseRemoteArm,
    /// A local start must not cancel a burning fuse.
    RefuseArmDuringFuse,
}

fn enforcement_decision(
    is_active: bool,
    remote: bool,
    focus_active: bool,
    fuse_burning: bool,
) -> EnforcementDecision {
    match (is_active, remote) {
        (true, true) => EnforcementDecision::RefuseRemoteArm,
        (true, false) if focus_active && fuse_burning => EnforcementDecision::RefuseArmDuringFuse,
        (true, false) => EnforcementDecision::Arm,
        (false, true) if focus_active => EnforcementDecision::IgnoreRemoteStop,
        (false, _) => EnforcementDecision::StandDown,
    }
}

// ─── IPC Command: update_enforcement ─────────────────────────────────────────
// Lightweight alias called by the session start/stop flow.
// Accepts { isActive, blockedList } to enforce during a focus session.
// Tauri takes command arguments as named parameters; a struct would change the
// IPC shape every caller sends.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn update_enforcement(
    is_active: bool,
    _blocked_list: Vec<String>, // ignored for arming — approved set is authoritative (G1)
    end_time: Option<u64>,
    from_remote: Option<bool>,
    objective: Option<String>,
    uid: Option<String>,
    lockdown: Option<bool>,
    blocks_sites: Option<bool>,
    planned_minutes: Option<u64>,
    app: tauri::AppHandle,
    app_state: State<AppState>,
) -> Result<String, String> {
    // A mirrored session from another device is NOT deliberate local action:
    // it can neither arm this desktop nor stop a session armed here.
    let remote = from_remote.unwrap_or(false);
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let now = now_millis();
            let fuse_burning = profile.bailout_deadline.is_some_and(|d| d > now);
            match enforcement_decision(is_active, remote, profile.focus_active, fuse_burning) {
                EnforcementDecision::IgnoreRemoteStop => {
                    println!(
                        "[Enforcer] IGNORED remote stop — local session armed until {:?}",
                        profile.session_end_time
                    );
                    log_ui_event(&app, "remote-stop-ignored");
                    return Ok("Remote stop ignored — session armed".to_string());
                }
                EnforcementDecision::RefuseRemoteArm => {
                    // Ok, not Err: the mirror's catch must not read this as an
                    // engine failure.
                    println!(
                        "[Enforcer] REFUSED remote arm — no desktop UI to show it (end_time={:?})",
                        end_time
                    );
                    log_ui_event(&app, "remote-arm-refused");
                    return Ok("Remote arm refused — not shown on this desktop".to_string());
                }
                EnforcementDecision::RefuseArmDuringFuse => {
                    println!("[Enforcer] REFUSED arm — a bail-out fuse is burning");
                    return Err("Refused to arm: a bail-out is burning".to_string());
                }
                EnforcementDecision::Arm | EnforcementDecision::StandDown => {}
            }
            if is_active {
                // Not over a running session (H2): re-arming would replace its
                // deadline. A session already past its deadline (the tick
                // hasn't ended it yet) is ended first, so it is recorded.
                if let Err(reason) = integrity::local_arm(&profile, now) {
                    println!("[Enforcer] REFUSED arm — {}", reason);
                    return Err(reason);
                }
                // The deadline is the webview's, capped at now + the planned
                // duration (H2). No deadline, a past one, or no plan: refused.
                let end = match integrity::session_end(now, end_time, planned_minutes) {
                    Ok(end) => end,
                    Err(reason) => {
                        println!("[Enforcer] REFUSED arm — {} (remote = {})", reason, remote);
                        return Err(reason);
                    }
                };
                if profile.focus_active {
                    let previous_end = profile.session_end_time.unwrap_or(now);
                    profile.note_clock(now);
                    profile.end_session(previous_end);
                }
                // An explicit LOCAL session start is the only thing that lifts
                // the latch — deliberate operator action, not a reconnect or a
                // mirrored write from another machine.
                if profile.disarm_latch {
                    profile.disarm_latch = false;
                    println!("[Enforcer] disarm latch CLEARED by explicit local session start");
                }
                // G1: arm from the locally-APPROVED set only, never the raw
                // list the caller passed. A remote (or local) session start
                // can therefore only kill apps the user approved on this
                // machine; unapproved remote additions sit in exe_pending and
                // do nothing. The passed `blocked_list` is ignored for arming.
                profile.exe_blacklist = profile.exe_approved.clone();
                // Deadline so a session persisted across a restart still ends.
                profile.start_session(now, Some(end), objective, uid, lockdown.unwrap_or(false), blocks_sites.unwrap_or(false));
                println!(
                    "🔒 ENFORCER ARMED: Active = {}, remote = {}, approved targets = {:?}, end_time = {}",
                    is_active, remote, profile.exe_blacklist, end
                );
            } else {
                // Session ending. exe_blacklist is standing config and is NOT
                // cleared — enforcer_active gates whether it is used, and
                // wiping it here meant every stop persisted exe=0, so an
                // offline boot had nothing to restore.
                let was_active = profile.focus_active;
                if was_active {
                    // Only at the deadline or once the fuse has burned (H2):
                    // before that the way out is Bail out, not this command.
                    if let Err(reason) = integrity::local_stop(&profile, now) {
                        println!("[Enforcer] REFUSED local stop — session armed until {:?}", profile.session_end_time);
                        log_ui_event(&app, "local-stop-refused");
                        return Err(reason);
                    }
                    let at = integrity::stop_time(&profile, now);
                    profile.note_clock(now);
                    profile.end_session(at);
                } else {
                    profile.session_end_time = None;
                    // bailout_used_date stays: it is what makes it one per day.
                    profile.bailout_deadline = None;
                }
                println!(
                    "🔓 ENFORCER STOOD DOWN: remote={}, {} target(s) retained",
                    remote,
                    profile.exe_blacklist.len()
                );
                // Only a real true→false transition is pushed to the UI.
                if was_active {
                    emit_stood_down(
                        &app,
                        if remote { "session-ended-remote" } else { "session-ended-local" },
                        profile.exe_blacklist.len(),
                    );
                }
            }
            profile.focus_active = is_active;

            persist_profile(&profile, &app_state.state_path);
            Ok("Enforcement updated".to_string())
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

#[tauri::command]
fn sync_blocklist(
    blocked_list: Vec<String>,
    uid: Option<String>,
    app: tauri::AppHandle,
    app_state: State<AppState>,
) -> Result<String, String> {
    // Every list the webview sends came from Firebase, so it is always remote:
    // the webview no longer says which names this PC added, nor that a sync is
    // local (M4). Those approvals are Rust's own (note_local_exe).
    let remote = true;
    let mut profile = app_state.profile.lock().map_err(|e| format!("Mutex lock failed: {}", e))?;
    // Disarm latch: a reconnect must not refill anything that a clear just
    // wiped, until a deliberate local session start lifts it.
    if profile.disarm_latch {
        println!("[Enforcer] disarm latch ACTIVE — refusing blocklist sync");
        return Ok("Blocklist sync skipped — disarm latch active".to_string());
    }
    // `blocked_list` is every entry in blockedApps. The rules (G1, M4, the
    // session freeze, the account check) are in integrity::apply_session_sync.
    let pending = integrity::apply_session_sync(&mut profile, &blocked_list, remote, uid.as_deref())?;
    println!(
        "📋 BLOCKLIST SYNCED (remote={}) — {} approved, {} pending approval",
        remote,
        profile.exe_approved.len(),
        pending.len()
    );
    persist_profile(&profile, &app_state.state_path);
    if !pending.is_empty() {
        emit_exe_pending(&app, &pending);
    }
    Ok(format!("Blocklist sync — {} pending approval", pending.len()))
}

/// Where a .lnk points, read through the shell's own IShellLinkW. On its own thread
/// because COM must be set up per thread, and the caller's may already be in another
/// apartment. An unreadable shortcut, or one with no target, is an error.
fn shortcut_target(path: String) -> Result<String, String> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    thread::spawn(move || unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().map_err(|e| e.to_string())?;
        let read = || -> windows::core::Result<String> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.cast::<IPersistFile>()?.Load(&HSTRING::from(path.as_str()), STGM_READ)?;
            let mut buffer = [0u16; 1024];
            link.GetPath(&mut buffer, std::ptr::null_mut(), 0)?;
            let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
            Ok(String::from_utf16_lossy(&buffer[..len]))
        };
        let target = read();
        CoUninitialize();
        target.map_err(|e| e.to_string())
    })
    .join()
    .map_err(|_| "shortcut reader stopped".to_string())?
}

#[tauri::command]
fn resolve_shortcut(shortcut_path: String) -> Result<String, String> {
    // Verify it ends in .lnk or .exe
    if !shortcut_path.ends_with(".lnk") && !shortcut_path.ends_with(".exe") {
        return Err("Invalid shortcut path".to_string());
    }
    match shortcut_target(shortcut_path) {
        Ok(target) if !target.is_empty() => Ok(target),
        _ => Err("Could not resolve shortcut".to_string()),
    }
}

/// A top-level window, as the picker needs to see it.
struct TopWindow {
    pid: u32,
    visible: bool,
    owned: bool,
    titled: bool,
}

fn top_level_windows() -> Vec<TopWindow> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
    };
    unsafe extern "system" fn add(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let found = unsafe { &mut *(lparam.0 as *mut Vec<TopWindow>) };
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            found.push(TopWindow {
                pid,
                visible: IsWindowVisible(hwnd).as_bool(),
                owned: GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid()),
                titled: GetWindowTextLengthW(hwnd) > 0,
            });
        }
        BOOL(1)
    }
    let mut found = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(add), LPARAM(&mut found as *mut Vec<TopWindow> as isize));
    }
    found
}

/// Processes with a titled main window, by the rule Get-Process's MainWindowTitle
/// uses: a process's main window is its first visible, unowned top-level window.
fn pids_with_titled_main_window(windows: &[TopWindow]) -> HashSet<u32> {
    let mut seen = HashSet::new();
    let mut titled = HashSet::new();
    for w in windows.iter().filter(|w| w.visible && !w.owned) {
        if seen.insert(w.pid) && w.titled {
            titled.insert(w.pid);
        }
    }
    titled
}

/// Process names as the picker lists them.
fn picker_names<I: IntoIterator<Item = String>>(names: I, own_stem: &str) -> Vec<String> {
    let mut apps: Vec<String> = names
        .into_iter()
        .map(|name| {
            let lowered = name.trim().to_lowercase();
            lowered.strip_suffix(".exe").unwrap_or(&lowered).to_string()
        })
        .filter(|line| {
            !line.is_empty()
                && *line != own_stem
                && line != "lock-in"
                && line != "cmd"
                && line != "powershell"
        })
        .map(|name| format!("{}.exe", name))
        .collect();
    apps.sort();
    apps.dedup();
    apps
}

#[tauri::command]
fn get_running_apps() -> Result<Vec<String>, String> {
    // Lock-In must never appear in its own picker. The literal "lockin" that
    // used to be filtered here matched NEITHER build — the dev and direct-download
    // binary is app.exe and the Store's is Lock-In.exe (process name "lock-in").
    // Use the real stem from current_exe(), with the Store name as a fallback
    // in case that lookup fails.
    let own_stem = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_lowercase()))
        .unwrap_or_default();

    let titled = pids_with_titled_main_window(&top_level_windows());
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessRefreshKind::new());
    let names = sys
        .processes()
        .iter()
        .filter(|(pid, _)| titled.contains(&pid.as_u32()))
        .map(|(_, process)| process.name().to_string());
    Ok(picker_names(names, &own_stem))
}

#[tauri::command]
fn sync_permanent_exe(
    blocked_list: Vec<String>,
    uid: Option<String>,
    app: tauri::AppHandle,
    app_state: State<AppState>,
) -> Result<String, String> {
    // From Firebase, so always remote: a new permanent block waits for the
    // banner (F4) whatever the webview says (M4).
    let remote = true;
    let mut profile = app_state.profile.lock().map_err(|e| format!("Lock failed: {}", e))?;
    // Post-wipe: refuse to refill or stage until a deliberate local session
    // start lifts the latch, so a reconnect cannot undo a clear.
    if profile.disarm_latch {
        println!("[Permanent] disarm latch ACTIVE — ignoring permanent sync");
        return Ok("Permanent sync skipped — disarm latch active".to_string());
    }
    let pending = integrity::apply_permanent_sync(&mut profile, &blocked_list, remote, uid.as_deref())?;
    println!(
        "[Permanent] sync (remote={}) — {} enforced, {} pending approval",
        remote,
        profile.permanent_exe.len(),
        pending.len()
    );
    persist_profile(&profile, &app_state.state_path);
    if !pending.is_empty() {
        emit_permanent_pending(&app, &pending);
    }
    Ok(format!("Permanent sync — {} pending approval", pending.len()))
}

// ─── IPC Command: is_dev_mode ────────────────────────────────────────────────
// Test builds (the dev-mode feature) only: true when a file named DEV_MODE exists
// in the app data directory (%APPDATA%\com.lockin.app\DEV_MODE). Unlocks test-only
// UI such as the 2-minute "Micro" session and the 30 s Bail out fuse. A release
// build is compiled without the feature: always false, and it never looks for the
// file, which any user could create in their own %APPDATA%.
#[cfg(feature = "dev-mode")]
#[tauri::command]
fn is_dev_mode(app: tauri::AppHandle) -> bool {
    match app.path().app_data_dir() {
        Ok(dir) => dir.join("DEV_MODE").is_file(),
        Err(_) => false,
    }
}

#[cfg(not(feature = "dev-mode"))]
#[tauri::command]
fn is_dev_mode(_app: tauri::AppHandle) -> bool {
    false
}

// ─── IPC Commands: boot snapshot ─────────────────────────────────────────────
// The RTDB web SDK keeps no disk cache, so a cold boot without a reachable
// Firebase has nothing to render — no handle, no streak, no blocklist. The
// webview therefore keeps its own snapshot of the last known good state next
// to enforcer_state.json, and reads it before it waits for anything remote.
//
// Rust only stores and returns bytes. It never parses the contents, so a
// malformed or hostile snapshot can do nothing here; the webview validates it.
// Capped so a runaway writer cannot fill the disk.
const SNAPSHOT_MAX_BYTES: usize = 4 * 1024 * 1024;

fn snapshot_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("snapshot.json"))
        .map_err(|e| format!("app_data_dir unavailable: {}", e))
}

#[tauri::command]
fn read_snapshot(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = snapshot_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("read failed: {}", e))
}

#[tauri::command]
fn write_snapshot(app: tauri::AppHandle, json: String) -> Result<(), String> {
    if json.len() > SNAPSHOT_MAX_BYTES {
        return Err(format!(
            "snapshot too large: {} bytes (max {})",
            json.len(),
            SNAPSHOT_MAX_BYTES
        ));
    }
    let path = snapshot_path(&app)?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Write to a sibling then rename, so a crash mid-write cannot leave a
    // truncated snapshot that would boot the app into a half-empty dashboard.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write failed: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename failed: {}", e))
}

#[tauri::command]
fn clear_snapshot(app: tauri::AppHandle) -> Result<(), String> {
    let path = snapshot_path(&app)?;
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| format!("remove failed: {}", e))?;
    }
    Ok(())
}

// ─── IPC Command: arm_bailout ────────────────────────────────────────────────
/// Arm the bail-out fuse for the running session.
///
/// Returns the deadline on success. Refuses — without changing anything — when
/// there is no live session, when a fuse is already burning, or when one has
/// already been used on this local date. The refusal carries the milliseconds
/// remaining so the UI can say how long is left rather than only that it said
/// no. Nothing here can shorten or cancel an existing fuse; there is
/// deliberately no disarm counterpart.
#[derive(Serialize)]
struct BailoutResult {
    armed: bool,
    /// Epoch ms when the fuse burns down. Present whenever one is burning.
    deadline: Option<u64>,
    /// Why it refused: "no-session" | "already-burning" | "used-today".
    refused: Option<String>,
    /// Milliseconds left on the burning fuse, when one is burning.
    remaining_ms: Option<u64>,
}

#[tauri::command]
fn arm_bailout(
    app: tauri::AppHandle,
    app_state: State<AppState>,
) -> Result<BailoutResult, String> {
    let mut profile = app_state
        .profile
        .lock()
        .map_err(|e| format!("profile lock poisoned: {}", e))?;
    let fuse = bailout_fuse_ms(&app);
    // The day is this PC's local date (H2), never one the webview sends, on
    // the clock with any caught jump taken out (clock.rs).
    let now = now_millis();
    let (today, offset) = integrity::local_day(profile.clock.true_now(now));
    let result = integrity::arm_bailout_at(&mut profile, now, &today, offset, fuse);
    if result.armed {
        persist_profile(&profile, &app_state.state_path);
        println!("[Enforcer] bail-out armed — fuse {} ms, deadline {:?}", fuse, result.deadline);
    }
    Ok(result)
}

// ─── IPC Command: append_ui_event ────────────────────────────────────────────
// A small on-disk trail of UI events that are otherwise invisible after the
// fact — a toast the operator never saw, a write that sat queued offline.
// Lives next to enforcer_state.json: %APPDATA%\com.lockin.app\ui-events.log
//
// One line per event: "<ISO-8601 UTC> <event> <uid prefix>". Only allowlisted
// event names are accepted and the uid is cut to 6 alphanumerics, so the
// webview can never write arbitrary text (or newlines) into the file.
//
// Append-only. When the next line would take the file past 200 KB it is
// renamed to ui-events.log.1 (replacing any older one) and a fresh file is
// started — existing lines are never rewritten, and at most ~400 KB is kept.
const UI_EVENT_LOG_CAP: u64 = 200 * 1024;
const UI_EVENTS: &[&str] = &[
    "session-end-timeout-offline",
    "session-end-timeout-connected",
    "session-end-acked",
    "session-end-refused",
    "bailout-armed",
    "bailout-fired",
    "reconcile-write",
    "name-repair",
    "remote-stop-ignored",
    "remote-arm-refused",
    "session-recorded",
    "quit-refused",
    "autostart-set",
    "autostart-error",
    "start-apps-only",
    "lockdown-warned",
    "lockdown-closed",
    "lockdown-incognito-gap",
    "heartbeat-port-busy",
    "local-stop-refused",
    "session-rearmed",
    "stood-down-ignored",
];

/// Epoch milliseconds → "YYYY-MM-DDTHH:MM:SS.mmmZ" (UTC), without a date crate.
/// Days-to-civil conversion from Howard Hinnant's chrono-compatible algorithms.
fn iso8601_utc(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = (secs / 86_400) as i64;
    let sod = secs % 86_400;
    let (h, mi, se) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, mo, d, h, mi, se, millis
    )
}

/// Rust's own line in the same trail. A release build has no console, so a
/// println! alone is invisible when someone asks why the enforcer did something.
fn log_ui_event(app: &tauri::AppHandle, event: &str) {
    if let Err(e) = append_ui_event(event.to_string(), String::new(), app.clone()) {
        println!("[UiEvents] could not log {}: {}", event, e);
    }
}

#[tauri::command]
fn append_ui_event(event: String, uid_prefix: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::io::Write;

    if !UI_EVENTS.contains(&event.as_str()) {
        return Err(format!("unknown ui event: {}", event));
    }
    let uid: String = uid_prefix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(6)
        .collect();
    let uid = if uid.is_empty() { "-".to_string() } else { uid };

    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("ui-events.log");
    let line = format!("{} {} {}\n", iso8601_utc(now_millis()), event, uid);

    let current = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if current > 0 && current + line.len() as u64 > UI_EVENT_LOG_CAP {
        // std::fs::rename replaces an existing target on Windows.
        std::fs::rename(&path, dir.join("ui-events.log.1")).map_err(|e| e.to_string())?;
    }

    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .map_err(|e| e.to_string())
}

// ─── IPC Command: get_enforcer_state ─────────────────────────────────────────
// Read-only snapshot of the enforcer's Rust-side truth. The degraded/offline
// screen gates its kill switch on THIS, never on Firebase-derived React state —
// on a degraded boot the React session flags are false while the Rust enforcer
// may still be armed from a prior run.
#[derive(Serialize)]
struct EnforcerState {
    is_locked: bool,
    focus_active: bool,
    exe_blacklist_len: usize,
    permanent_exe_len: usize,
    /// Session app names awaiting local approval (G1). Not enforced.
    exe_pending: Vec<String>,
    /// Permanent block names awaiting local approval (F4). Not enforced.
    permanent_pending: Vec<String>,
    disarm_latch: bool,
    /// Epoch ms deadline of the running session, or null when none is armed.
    session_end_time: Option<u64>,
    bailout_deadline: Option<u64>,
    bailout_used_date: Option<String>,
    /// How long a fuse armed right now would burn. The UI states this before
    /// the operator commits, and a dev-mode test build with DEV_MODE shortens
    /// it, so it cannot be a constant on the webview side.
    bailout_fuse_ms: u64,
    /// Entries for the webview to write, then ack_session_record.
    pending_records: Vec<SessionRecord>,
    /// Blocks removed during this session that are still enforced until it
    /// ends: the Blocks tab shows them as "Removes after this session".
    session_held: Vec<String>,
    session_started_at: Option<u64>,
    close_to_tray: bool,
    other_install: bool,
    build_label: String,
    /// Set when the state file cannot be written at all (no app data folder):
    /// enforcement works, but nothing survives a restart.
    persistence_error: Option<String>,
}

#[tauri::command]
fn get_enforcer_state(app: tauri::AppHandle, app_state: State<AppState>) -> Result<EnforcerState, String> {
    match app_state.profile.lock() {
        Ok(profile) => Ok(EnforcerState {
            is_locked: profile.is_locked,
            focus_active: profile.focus_active,
            exe_blacklist_len: profile.exe_blacklist.len(),
            permanent_exe_len: profile.permanent_exe.len(),
            exe_pending: profile.exe_pending.iter().cloned().collect(),
            permanent_pending: profile.permanent_pending.iter().cloned().collect(),
            disarm_latch: profile.disarm_latch,
            session_end_time: profile.session_end_time,
            bailout_deadline: profile.bailout_deadline,
            bailout_used_date: profile.bailout_used_date.clone(),
            bailout_fuse_ms: bailout_fuse_ms(&app),
            pending_records: profile.pending_records.clone(),
            session_held: integrity::held_removals(&profile),
            session_started_at: profile.session_started_at,
            close_to_tray: profile.close_to_tray,
            other_install: app_state.other_install,
            build_label: build_label(),
            persistence_error: app_state.persist_error.clone(),
        }),
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

// ─── IPC Command: set_close_to_tray ──────────────────────────────────────────
// A setting of this machine's window, not of the account, so it stays out of
// Firebase and lives with the rest of the enforcer's state.
#[tauri::command]
fn set_close_to_tray(enabled: bool, app_state: State<AppState>) -> Result<bool, String> {
    let mut profile = app_state
        .profile
        .lock()
        .map_err(|e| format!("Mutex lock failed: {}", e))?;
    profile.close_to_tray = enabled;
    persist_profile(&profile, &app_state.state_path);
    println!("[Tray] keep running when closed = {}", enabled);
    Ok(enabled)
}

// ─── IPC Command: lockdown_status ────────────────────────────────────────────
// What the Start dialog needs to know.
#[derive(Serialize)]
struct LockdownStatus {
    /// False means no beat can arrive, so lockdown must not be offered: it would
    /// close every browser, including ones with a working Web Guard.
    listening: bool,
    closable: Vec<String>,
    /// The closable browsers that Web Guard would keep open, by id and name, leaving
    /// out those already running it on the wrong account.
    installable: Vec<BrowserRef>,
    /// Closable browsers where Web Guard runs but is signed out or on another account.
    wrong_account: Vec<String>,
    incognito_gaps: Vec<String>,
}

#[derive(Serialize)]
struct BrowserRef {
    id: String,
    name: String,
}

fn pids_with_windows() -> HashSet<u32> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible};
    unsafe extern "system" fn add(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let pids = unsafe { &mut *(lparam.0 as *mut HashSet<u32>) };
        let mut pid = 0u32;
        unsafe {
            if IsWindowVisible(hwnd).as_bool() {
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                pids.insert(pid);
            }
        }
        BOOL(1)
    }
    let mut pids = HashSet::new();
    unsafe {
        let _ = EnumWindows(Some(add), LPARAM(&mut pids as *mut HashSet<u32> as isize));
    }
    pids
}

#[tauri::command]
async fn lockdown_status(uid: Option<String>, app_state: State<'_, AppState>) -> Result<LockdownStatus, String> {
    let beats = Arc::clone(&app_state.beats);
    let listening = app_state.heartbeat_listening.load(Ordering::SeqCst);
    // Reading every process takes a moment; not on the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let mut sys = System::new();
        let running = running_browsers(&mut sys);
        let windows = pids_with_windows();
        let open: Vec<&'static str> = running
            .iter()
            .filter(|(_, pids)| pids.iter().any(|p| windows.contains(p)))
            .map(|(id, _)| *id)
            .collect();
        let now = now_millis();
        let uid = uid.as_deref();
        // Web Guard not allowed in Incognito or with limited site access doesn't
        // keep a browser open (1.3.1), so the dialog names those browsers too.
        let is_fresh = |b: &str| beats.protects(b, uid, now);
        let closable = lockdown::closable(&open, &is_fresh);
        LockdownStatus {
            listening,
            closable: closable.iter().map(|id| browsers::name_of(id).to_string()).collect(),
            installable: closable
                .iter()
                .filter(|id| browsers::takes_web_guard(id) && !beats.wrong_account(id, uid, now))
                .map(|id| BrowserRef { id: id.to_string(), name: browsers::name_of(id).to_string() })
                .collect(),
            wrong_account: closable
                .iter()
                .filter(|id| beats.wrong_account(id, uid, now))
                .map(|id| browsers::name_of(id).to_string())
                .collect(),
            incognito_gaps: open
                .iter()
                .filter(|id| beats.is_fresh(id, uid, now) && beats.latest(id, uid).is_some_and(|b| !b.incognito_allowed))
                .map(|id| browsers::name_of(id).to_string())
                .collect(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

// ─── IPC Command: lockdown_set_online ────────────────────────────────────────
#[tauri::command]
fn lockdown_set_online(online: bool, app_state: State<AppState>) {
    app_state.online.store(online, Ordering::Relaxed);
}

// ─── IPC Command: ack_session_record ─────────────────────────────────────────
// Firebase acknowledged this session's history entry, so nothing is owed.
#[tauri::command]
fn ack_session_record(ended_at: u64, app_state: State<AppState>) -> Result<(), String> {
    let mut profile = app_state
        .profile
        .lock()
        .map_err(|e| format!("Mutex lock failed: {}", e))?;
    if profile.ack_record(ended_at) {
        persist_profile(&profile, &app_state.state_path);
    }
    Ok(())
}

// ─── IPC Command: rearm_from_server ──────────────────────────────────────────
// M7: the webview found this PC's own session still live in Firebase while Rust
// has none (the state file was lost or edited while the app was closed). Rust
// re-arms it unless it already ended here. Arming only ever blocks more.
#[tauri::command]
fn rearm_from_server(
    session: integrity::ServerSession,
    app: tauri::AppHandle,
    app_state: State<AppState>,
) -> Result<bool, String> {
    let mut profile = app_state
        .profile
        .lock()
        .map_err(|e| format!("Mutex lock failed: {}", e))?;
    let was_active = profile.focus_active;
    integrity::rearm_from_server(&mut profile, &session, now_millis())?;
    let rearmed = !was_active && profile.focus_active;
    if rearmed {
        println!("🔒 ENFORCER RE-ARMED from the server session, until {:?}", profile.session_end_time);
        log_ui_event(&app, "session-rearmed");
        persist_profile(&profile, &app_state.state_path);
    }
    Ok(rearmed)
}

// ─── IPC Command: clear_disarm_latch ─────────────────────────────────────────
// Released by the frontend's disarm-recovery pass, and only AFTER the stale
// Firebase session flags have been cleared. If those writes fail the latch
// stays armed, so the next reconnect still cannot re-arm the enforcer.
#[tauri::command]
fn clear_disarm_latch(app_state: State<AppState>) -> Result<String, String> {
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let was_set = profile.disarm_latch;
            profile.disarm_latch = false;
            persist_profile(&profile, &app_state.state_path);
            println!("[Enforcer] disarm latch cleared by recovery (was_set={})", was_set);
            Ok(format!("Disarm latch cleared (was_set={})", was_set))
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

// ─── IPC Command: clear_all_blocks ───────────────────────────────────────────
// F2: the always-available escape. Wipes session AND permanent blocks with no
// auth and no network — reachable from the signed-out Login screen and the
// degraded boot screen. (An older disarm command did the same wipe; nothing
// called it any more, so it was removed.)
#[tauri::command]
fn clear_all_blocks(app: tauri::AppHandle, app_state: State<AppState>) -> Result<String, String> {
    let mut profile = app_state.profile.lock().map_err(|e| format!("Mutex lock failed: {}", e))?;
    let (cleared_session, cleared_permanent) = integrity::clear_all(&mut profile, now_millis())?;
    persist_profile(&profile, &app_state.state_path);
    emit_stood_down(&app, "clear-all-blocks", 0);
    println!("🧹 CLEAR ALL BLOCKS: session + permanent wiped (latch armed)");
    Ok(format!(
        "Cleared {} session target(s) and {} permanent block(s)",
        cleared_session, cleared_permanent
    ))
}

// ─── IPC Command: forget_account ─────────────────────────────────────────────
/// Delete account (B2 M6): drop this account's lists, approvals and unsent
/// records from enforcer_state.json. Refused while a session runs.
#[tauri::command]
fn forget_account(app_state: State<AppState>, uid: String) -> Result<(), String> {
    let mut profile = app_state.profile.lock().map_err(|e| format!("Mutex lock failed: {}", e))?;
    integrity::forget_account(&mut profile, &uid, now_millis())?;
    persist_profile(&profile, &app_state.state_path);
    Ok(())
}

// ─── IPC Command: confirm_pending_permanent ──────────────────────────────────
// F4: promote locally-approved pending permanent blocks into the enforced set:
// exactly the names the banner showed (L1). One staged after it rendered stays
// pending for the next banner.
#[tauri::command]
fn confirm_pending_permanent(names: Vec<String>, app_state: State<AppState>) -> Result<String, String> {
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let promoted = integrity::confirm_pending_permanent(&mut profile, &names);
            persist_profile(&profile, &app_state.state_path);
            println!("[Permanent] approved {} pending block(s): {:?}", promoted.len(), promoted);
            Ok(format!("Approved {} permanent block(s)", promoted.len()))
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

// ─── IPC Command: reject_pending_permanent ───────────────────────────────────
// F4: discard pending permanent blocks. The frontend also removes them from
// Firebase so they cannot re-stage on the next sync.
#[tauri::command]
fn reject_pending_permanent(names: Vec<String>, app_state: State<AppState>) -> Result<String, String> {
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let n = integrity::reject_pending_permanent(&mut profile, &names);
            persist_profile(&profile, &app_state.state_path);
            println!("[Permanent] rejected {} pending block(s)", n);
            Ok(format!("Rejected {} pending permanent block(s)", n))
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

// ─── IPC Command: confirm_pending_exe ────────────────────────────────────────
// G1: promote locally-approved session apps into the approved set: exactly the
// names the banner showed (L1). If a session is live, arm them immediately so
// approval takes effect without a restart.
#[tauri::command]
fn confirm_pending_exe(names: Vec<String>, app_state: State<AppState>) -> Result<String, String> {
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let promoted = integrity::confirm_pending_exe(&mut profile, &names);
            persist_profile(&profile, &app_state.state_path);
            println!("[Blocklist] approved {} pending app(s): {:?}", promoted.len(), promoted);
            Ok(format!("Approved {} session app(s)", promoted.len()))
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

// ─── IPC Command: reject_pending_exe ─────────────────────────────────────────
// G1: discard pending session apps. The frontend also removes them from
// Firebase (blockedApps) so they cannot re-stage on the next sync.
#[tauri::command]
fn reject_pending_exe(names: Vec<String>, app_state: State<AppState>) -> Result<String, String> {
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let n = integrity::reject_pending_exe(&mut profile, &names);
            persist_profile(&profile, &app_state.state_path);
            println!("[Blocklist] rejected {} pending app(s)", n);
            Ok(format!("Rejected {} pending session app(s)", n))
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

// ─── IPC Command: note_local_exe ─────────────────────────────────────────────
// M4: the Blocks tab on THIS PC is adding a session app. Called before the
// Firebase write, so the echo arms without the approval banner. The only way a
// name is approved as this PC's own.
#[tauri::command]
fn note_local_exe(name: String, app_state: State<AppState>) -> Result<String, String> {
    let mut profile = app_state.profile.lock().map_err(|e| format!("Mutex lock failed: {}", e))?;
    let noted = integrity::note_added_here(&mut profile, &name).ok_or_else(|| format!("Not a block name: {}", name))?;
    persist_profile(&profile, &app_state.state_path);
    Ok(noted)
}

/// ShellExecuteW reports success as any value above 32.
fn shell_execute_succeeded(code: isize) -> bool {
    code > 32
}

/// Where a browser that takes Web Guard installs, machine-wide then per-user, in
/// the order to try. Anything but Edge or Brave means Chrome.
fn store_browser_candidates(browser: &str, program_files: &[Option<PathBuf>], local_app_data: Option<PathBuf>) -> Vec<PathBuf> {
    let tail: &[&str] = match browser {
        "edge" => &["Microsoft", "Edge", "Application", "msedge.exe"],
        "brave" => &["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
        _ => &["Google", "Chrome", "Application", "chrome.exe"],
    };
    program_files
        .iter()
        .flatten()
        .chain(local_app_data.iter())
        .map(|root| tail.iter().fold(root.clone(), |path, part| path.join(part)))
        .collect()
}

/// Open the extension's store page in the browser it's for (Chrome, Edge or
/// Brave; Chrome when none is named), since Web Guard installs into the browser
/// that opens the page, not whatever the default browser is. With that browser
/// not found, the default browser is the only way left to reach the page. The
/// URL is fixed here, so this can't be used to open anything else.
#[tauri::command]
fn open_web_guard_store(browser: Option<String>) -> Result<(), String> {
    let candidates = store_browser_candidates(
        browser.as_deref().unwrap_or("chrome"),
        &[std::env::var_os("ProgramFiles").map(PathBuf::from), std::env::var_os("ProgramFiles(x86)").map(PathBuf::from)],
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
    );
    if let Some(exe) = candidates.iter().find(|p| p.is_file()) {
        return std::process::Command::new(exe)
            .arg(WEB_GUARD_STORE_URL)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    println!("[WebGuard] {:?} not found — opening the store page in the default browser", browser);
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let code = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(WEB_GUARD_STORE_URL),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if shell_execute_succeeded(code.0 as isize) {
        Ok(())
    } else {
        Err(format!("Windows couldn't open the page (code {})", code.0 as isize))
    }
}

/// True in the Microsoft Store (MSIX) build. The webview asks before touching
/// anything the Store owns — the updater above all.
#[tauri::command]
fn is_store_build() -> bool {
    cfg!(feature = "store")
}

#[cfg(feature = "autostart")]
#[tauri::command]
fn get_autostart_state(app: tauri::AppHandle) -> Result<bool, String> {
    let manager = app.autolaunch();
    manager.is_enabled().map_err(|e| e.to_string())
}

/// What toggle_autostart actually achieved. The UI sets the switch from
/// `enabled`, never from what it asked for: in the Store build Windows may
/// refuse (the user turned it off in Settings, or policy forbids it).
#[derive(Serialize)]
struct AutostartResult {
    enabled: bool,
    /// "Enabled" | "Disabled" | "DisabledByUser" | "DisabledByPolicy" | "EnabledByPolicy"
    state: String,
}

#[cfg(feature = "autostart")]
#[tauri::command]
fn toggle_autostart(
    enable: bool,
    app: tauri::AppHandle,
) -> Result<AutostartResult, String> {
    let manager = app.autolaunch();
    if enable {
        manager.enable().map_err(|e| e.to_string())?;
        println!("[AutoStart] Enabled via toggle");
    } else {
        manager.disable().map_err(|e| e.to_string())?;
        println!("[AutoStart] Disabled via toggle");
    }
    let enabled = manager.is_enabled().map_err(|e| e.to_string())?;
    log_ui_event(&app, "autostart-set");
    Ok(AutostartResult {
        enabled,
        state: if enabled { "Enabled" } else { "Disabled" }.to_string(),
    })
}

// Store build: the package's StartupTask (Package.appxmanifest, TaskId
// LockInAutostart, Enabled="false"). Only works with package identity, so an
// unpackaged store-feature binary reports an error rather than a state.
#[cfg(feature = "store")]
mod store_autostart {
    use std::time::{Duration, Instant};
    use windows::core::{RuntimeType, HSTRING};
    use windows::ApplicationModel::{StartupTask, StartupTaskState};
    use windows_future::{AsyncStatus, IAsyncOperation};

    const TASK_ID: &str = "LockInAutostart";
    const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);

    /// Poll the operation instead of blocking on .get(). 1.2.8's switch sat
    /// still with no toast while Windows had in fact changed the task, which is
    /// what a completion that never arrives looks like. Polling doesn't depend
    /// on that delivery, and the deadline guarantees the UI gets an answer.
    fn answer<T: RuntimeType + 'static>(op: IAsyncOperation<T>) -> Result<T, String> {
        let started = Instant::now();
        while op.Status().map_err(|e| e.to_string())? == AsyncStatus::Started {
            if started.elapsed() > ANSWER_TIMEOUT {
                return Err("Windows didn't answer".to_string());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        op.GetResults().map_err(|e| e.to_string())
    }

    fn task() -> Result<StartupTask, String> {
        let op = StartupTask::GetAsync(&HSTRING::from(TASK_ID)).map_err(|e| e.to_string())?;
        answer(op).map_err(|e| format!("StartupTask unavailable: {}", e))
    }

    pub fn is_on(state: StartupTaskState) -> bool {
        state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy
    }

    pub fn name(state: StartupTaskState) -> &'static str {
        match state {
            StartupTaskState::Enabled => "Enabled",
            StartupTaskState::DisabledByUser => "DisabledByUser",
            StartupTaskState::DisabledByPolicy => "DisabledByPolicy",
            StartupTaskState::EnabledByPolicy => "EnabledByPolicy",
            _ => "Disabled",
        }
    }

    pub fn read() -> Result<StartupTaskState, String> {
        task()?.State().map_err(|e| format!("StartupTask unavailable: {}", e))
    }

    /// RequestEnableAsync cannot override DisabledByUser or a policy; it
    /// returns the state Windows settled on, which is what we report.
    pub fn set(enable: bool) -> Result<StartupTaskState, String> {
        let t = task()?;
        if enable {
            answer(t.RequestEnableAsync().map_err(|e| e.to_string())?)
        } else {
            t.Disable().and_then(|_| t.State()).map_err(|e| e.to_string())
        }
    }
}

// Async + spawn_blocking: waiting on a WinRT operation must not happen on the
// main (UI) thread that sync commands use.
#[cfg(feature = "store")]
#[tauri::command]
async fn get_autostart_state() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| store_autostart::read().map(store_autostart::is_on))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(feature = "store")]
#[tauri::command]
async fn toggle_autostart(enable: bool, app: tauri::AppHandle) -> Result<AutostartResult, String> {
    let state = tauri::async_runtime::spawn_blocking(move || store_autostart::set(enable))
        .await
        .map_err(|e| e.to_string())??;
    log_ui_event(&app, "autostart-set");
    println!("[AutoStart] StartupTask {} → {}", if enable { "enable" } else { "disable" }, store_autostart::name(state));
    Ok(AutostartResult {
        enabled: store_autostart::is_on(state),
        state: store_autostart::name(state).to_string(),
    })
}

// Neither plugin nor store: no autostart at all.
#[cfg(not(any(feature = "autostart", feature = "store")))]
#[tauri::command]
fn get_autostart_state() -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(any(feature = "autostart", feature = "store")))]
#[tauri::command]
fn toggle_autostart(_enable: bool) -> Result<AutostartResult, String> {
    Err("Autostart is not available in this build".to_string())
}

// ─── SHIPPING INVARIANT ──────────────────────────────────────────────────────
// tauri.conf.json → app.windows[0].devtools MUST be false in any shipped build.
// The config is strict JSON (unknown keys are rejected, so it cannot carry this
// note itself). devtools:true hands F12 to whoever is at the machine — the
// WebView console logs uids and blocklists, and the enforcer can be driven
// from it. Flip it on for a local debug session only, and flip it back.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let profile = Arc::new(Mutex::new(LockProfile {
        is_locked: false,
        lock_mode: "soft".to_string(),
        exe_blacklist: HashSet::new(),
        exe_approved: HashSet::new(),
        exe_pending: HashSet::new(),
        exe_added_here: HashSet::new(),
        exe_migrated: false,
        web_blacklist: HashSet::new(),
        permanent_exe: HashSet::new(),
        permanent_pending: HashSet::new(),
        focus_active: false,
        disarm_latch: false,
        session_end_time: None,
        bailout_deadline: None,
        bailout_used_date: None,
        bailout_used_offset_min: None,
        clock: clock::Watch::default(),
        close_to_tray: true,
        session_awake_ms: 0,
        session_objective: None,
        session_uid: None,
        browser_lockdown: false,
        session_blocks_sites: false,
        pending_records: Vec::new(),
        session_started_at: None,
        session_held_permanent: HashSet::new(),
        last_session_ended_at: None,
        last_clock_check: None,
    }));

    let profile_for_sniper = Arc::clone(&profile);
    let profile_for_setup = Arc::clone(&profile);

    tauri::Builder::default()
        // MUST be the first plugin (its docs: plugins run in registration
        // order). A second launch exits at once and focuses this window —
        // two enforcers would each kill the other's targets and race on
        // enforcer_state.json. Every other plugin is registered in setup().
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if is_silent_launch(&argv) {
                println!("[SingleInstance] second silent launch — staying hidden");
                return;
            }
            println!("[SingleInstance] second launch — focusing the existing window");
            // Shown even inside the 3 s boot delay, or hidden in the tray.
            show_main_window(app);
        }))
        // No handler means close = exit, which ends the enforcer thread with it.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let Some(state) = window.try_state::<AppState>() else { return };
                let hide = state
                    .profile
                    .lock()
                    .map(|p| close_hides(p.armed(), p.close_to_tray))
                    .unwrap_or(true);
                if hide {
                    api.prevent_close();
                    let _ = window.hide();
                    println!("[Tray] window closed — hidden, still running");
                }
            }
            // 1.2.10 exits when its one window closes, which only happens when the close above
            // wasn't prevented: no session, and "keep running" off. The parrot's window would
            // otherwise keep the process alive there, invisible, so the same close exits here.
            // During a session main is only ever hidden, never destroyed, so this never fires then.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                window.app_handle().exit(0);
            }
        })
        // Every one is also listed in app_commands.in, and only a window whose
        // capability grants it can call it: "main" alone (see build.rs).
        .invoke_handler(tauri::generate_handler![sync_lock_state, update_enforcement, check_sniper, resolve_shortcut, get_running_apps, sync_blocklist, sync_permanent_exe, toggle_autostart, get_autostart_state, get_enforcer_state, clear_disarm_latch, classify_block_entry, clear_all_blocks, confirm_pending_permanent, reject_pending_permanent, confirm_pending_exe, reject_pending_exe, note_local_exe, append_ui_event, is_dev_mode, arm_bailout, ack_session_record, rearm_from_server, lockdown_status, lockdown_set_online, set_close_to_tray, open_web_guard_store, read_snapshot, write_snapshot, clear_snapshot, forget_account, is_store_build, companion_set_enabled, companion_show_main, companion_ready, companion_set_hitbox, companion_set_dragging, companion_interaction_ended, companion_state, #[cfg(debug_assertions)] companion_log_menu, #[cfg(debug_assertions)] companion_debug_log])
        .setup(move |app| {
            let handle = app.handle().clone();

            // ── Restore persisted enforcer state ───────────────────────────
            // MUST complete before the sniper thread starts, otherwise the
            // first ticks would run against a blank profile.
            let (state_path, persist_error) = match app.path().app_data_dir() {
                Ok(dir) => (Some(dir.join("enforcer_state.json")), None),
                Err(e) => {
                    // Keep enforcing from memory; a session started now will
                    // not survive a restart. The UI warns via get_enforcer_state.
                    eprintln!("[Persist] app_data_dir unavailable ({}) — state NOT persisted, running in memory", e);
                    (None, Some(format!("app data folder unavailable: {}", e)))
                }
            };
            println!("[Persist] state file: {:?}", state_path);
            if let Some(path) = &state_path {
                restore_profile(&profile_for_setup, path, &handle);
            }

            // ── Web Guard heartbeat ────────────────────────────────────────
            let beats = Arc::new(heartbeat::BeatStore::default());
            let online = Arc::new(AtomicBool::new(false));
            // The first try is here, so a session restored at boot sees the
            // port's real state; after a failure a thread keeps retrying.
            let heartbeat_listening = Arc::new(AtomicBool::new(false));
            {
                let first = heartbeat::bind_on(heartbeat::PORT);
                heartbeat_listening.store(first.is_ok(), Ordering::SeqCst);
                let allowed = heartbeat::allowed_extension_ids(dev_extension_id(&handle));
                let served = Arc::clone(&beats);
                let listening = Arc::clone(&heartbeat_listening);
                let app_for_log = handle.clone();
                // Web Guard's reply: this PC's own session, for the account it runs.
                let session_profile = Arc::clone(&profile_for_setup);
                let session_for: heartbeat::SessionFor = Arc::new(move |uid: Option<&str>| {
                    let Ok(p) = session_profile.lock() else { return heartbeat::SessionReply::default() };
                    session_reply(&p, uid, now_millis())
                });
                thread::spawn(move || {
                    let listener = match first {
                        Ok(listener) => listener,
                        Err(_) => heartbeat::bind_with_retry(
                            heartbeat::PORT,
                            &listening,
                            |n, e| {
                                println!("[Heartbeat] could not listen on 127.0.0.1:{} (try {}): {}", heartbeat::PORT, n + 1, e);
                                if n == 0 {
                                    log_ui_event(&app_for_log, "heartbeat-port-busy");
                                }
                            },
                            thread::sleep,
                        ),
                    };
                    println!("[Heartbeat] listening on 127.0.0.1:{}", heartbeat::PORT);
                    heartbeat::serve(listener, allowed, served, now_millis, attest::who, session_for);
                });
            }

            app.manage(AppState {
                profile: Arc::clone(&profile_for_setup),
                state_path: state_path.clone(),
                persist_error,
                other_install: detect_other_install(),
                beats: Arc::clone(&beats),
                online: Arc::clone(&online),
                heartbeat_listening: Arc::clone(&heartbeat_listening),
            });

            app.manage(CompanionState::default());
            companion::start(&handle);

            let lockdown_app = handle.clone();
            let lockdown_profile = Arc::clone(&profile_for_setup);
            thread::spawn(move || lockdown_runner(lockdown_app, lockdown_profile, beats, online, heartbeat_listening));

            // ── Tray ───────────────────────────────────────────────────────
            // Driven from Rust only, so no capability is needed for it.
            let open_item = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let parrot_item = companion::tray_item(&handle)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &parrot_item, &quit_item])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Lock-In")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "quit" => tray_quit(app),
                    companion::TRAY_ITEM_ID => companion::tray_item_clicked(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let sniper_state_path = state_path.clone();

            // ── Sniper Thread ──────────────────────────────────────────────
            // Every 2 s: ends expired sessions, then kills blocklisted
            // processes in-process via sysinfo (kill_processes_matching). Every
            // process whose name matches is killed individually, so
            // multi-process Electron apps like Discord go down one process at
            // a time rather than as a taskkill /T tree.
            thread::spawn(move || {
                println!("[Enforcer] Background thread STARTED");
                // One long-lived process table, refreshed in place only on ticks
                // that actually have something to kill (S3).
                let mut sys = System::new();
                let mut ticks_since_persist = 0u32;
                loop {
                    println!("[Enforcer] Tick...");
                    thread::sleep(std::time::Duration::from_secs(2));

                    // Session expiry — a session that survived a restart has no
                    // JS timer left to end it, so the enforcer ends it itself.
                    if let Ok(mut profile) = profile_for_sniper.lock() {
                        // A changed clock moves the deadlines with it (clock.rs),
                        // before anything is compared with them.
                        let jump = profile.watch_clock(now_millis(), clock::tick64());
                        if jump != 0 {
                            println!("[Clock] the clock moved {} ms; the session's deadlines moved with it", jump);
                            persist_profile(&profile, &sniper_state_path);
                        }
                        // Before expiry, so the last stretch counts. Saved about
                        // every 30 s: an End task loses no more than that.
                        profile.note_clock(now_millis());
                        ticks_since_persist += 1;
                        if profile.focus_active && ticks_since_persist >= 15 {
                            ticks_since_persist = 0;
                            persist_profile(&profile, &sniper_state_path);
                        }
                        if profile.focus_active {
                            // Two deadlines can end a session: its own, and a
                            // bail-out fuse. Whichever lands first ends it —
                            // but once a fuse is armed the session is void
                            // whatever ends it, so a bail-out at 55/60 cannot
                            // be salvaged by waiting out the last five minutes.
                            let bailing = profile.bailout_deadline.is_some();
                            let deadline = match (profile.session_end_time, profile.bailout_deadline) {
                                (Some(a), Some(b)) => Some(a.min(b)),
                                (Some(a), None) => Some(a),
                                (None, Some(b)) => Some(b),
                                (None, None) => None,
                            };
                            if let Some(end) = deadline {
                                if now_millis() >= end {
                                    // Stand down without touching exe_blacklist —
                                    // standing config, gated by enforcer_active.
                                    // bailout_used_date is deliberately kept:
                                    // it is what makes it one bail-out per day.
                                    profile.end_session(end);
                                    persist_profile(&profile, &sniper_state_path);
                                    let reason = if bailing { "bailout-expired" } else { "deadline-expired" };
                                    emit_stood_down(&handle, reason, profile.exe_blacklist.len());
                                    println!(
                                        "⏱ [Enforcer] {} — auto stand-down, {} target(s) retained",
                                        reason,
                                        profile.exe_blacklist.len()
                                    );
                                }
                            }
                        }
                    }

                    // Read state — drop lock immediately after
                    let (is_locked, lock_mode, focus_active, terms) =
                        match profile_for_sniper.lock() {
                            Ok(profile) => (
                                profile.is_locked,
                                profile.lock_mode.clone(),
                                profile.focus_active,
                                integrity::kill_terms(&profile),
                            ),
                            Err(_) => continue,
                        };

                    println!("[Enforcer] Loop tick — focus_active: {}, is_locked: {}, terms: {:?}",
                             focus_active, is_locked, terms);

                    // Where the protected images live, read per tick (M8, M9).
                    let image_paths = ImagePaths::of_this_pc();

                    // NOTE: is_locked is currently UNREACHABLE — permanently false.
                    // sync_lock_state is its only writer, and its only caller
                    // (syncWithRustEngine in useOmniSync.ts) passes the hardcoded
                    // literal `isLocked: false`. Nothing in the app sets it true.
                    // The lock_mode soft/hard split below is dormant too. Do not
                    // assume it runs.

                    // ── Kill pass ──────────────────────────────────────────
                    // Permanent blocks always apply; session targets only while
                    // the enforcer is armed (integrity::kill_terms).

                    if !terms.is_empty() {
                        // One cheap refresh per tick, not one process spawn per
                        // term: names, pids and image paths (read once per
                        // process) — no CPU, memory, disk or user lookups.
                        sys.refresh_processes_specifics(ProcessRefreshKind::new().with_exe(UpdateKind::OnlyIfNotSet));
                        for term in &terms {
                            let killed = kill_processes_matching(&sys, term, &image_paths);
                            if killed.is_empty() {
                                println!("[Enforcer] no match for '*{}*'", term);
                            } else {
                                println!("[Enforcer] 💀 terminated {:?} for '*{}*'", killed, term);
                            }
                        }
                    }

                    // Window enforcement.
                    // NOTE: dormant — is_locked is permanently false (see above),
                    // so the hard/soft split never runs and this always takes the
                    // release branch. lock_mode is read nowhere else.
                    if let Some(window) = handle.get_webview_window("main") {
                        if is_locked {
                            if lock_mode == "hard" {
                                let _ = window.set_focus();
                                let _ = window.set_always_on_top(true);
                                let _ = window.set_fullscreen(true);
                                let _ = window.set_decorations(false);
                            } else {
                                let _ = window.set_always_on_top(false);
                                let _ = window.set_fullscreen(false);
                                let _ = window.set_decorations(true);
                            }
                        } else {
                            let _ = window.set_always_on_top(false);
                            let _ = window.set_fullscreen(false);
                            let _ = window.set_decorations(true);
                        }
                    }
                }
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(feature = "autostart")]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--silently"]),
            ))?;

            // Autostart is OPT-IN. Nothing is registered with Windows until the
            // operator flips "LAUNCH ON STARTUP" in System Protocols, which calls
            // toggle_autostart. A first launch used to call enable() here with
            // no consent — a boot-start process installed silently. The plugin
            // stays initialised above so the toggle and get_autostart_state work.

            // Delayed window show — gives Windows 3 s to initialise its
            // network stack before the webview tries to reach Firebase.
            // The window starts hidden (tauri.conf.json: "visible": false)
            // and this thread makes it visible once the delay has passed.
            let silent = is_silent_launch(&std::env::args().collect::<Vec<_>>());
            if let Some(boot_window) = app.get_webview_window("main") {
                thread::spawn(move || {
                    thread::sleep(std::time::Duration::from_secs(3));
                    match boot_show(silent) {
                        BootShow::ShowAndFocus => {
                            let _ = boot_window.show();
                            let _ = boot_window.set_focus();
                            println!("[Boot] Window shown after 3 s network delay");
                        }
                        BootShow::ShowWithoutFocus => {
                            show_without_focus(&boot_window);
                            println!("[Boot] sign-in launch — window shown, not focused");
                        }
                    }
                });
            }

            app.handle().plugin(tauri_plugin_dialog::init())?;

            // The updater plugin only exposes the check/download commands to
            // JS; nothing here downloads or installs. The decision to fetch is
            // made in the webview (UpdateBanner), which defers while a focus
            // session is armed — an install restarts the app, and a restart
            // mid-session is exactly the escape hatch the enforcer exists to
            // deny.
            #[cfg(feature = "updater")]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{boot_show, BootShow, quit_allowed, terminate_process, picker_names, pids_with_titled_main_window, TopWindow, resolve_shortcut, process_table_readable, sniper_status, shell_execute_succeeded, arm_refusal, awake_in_gap, store_browser_candidates, lockdown_warning, WEB_GUARD_STORE_URL, WRONG_ACCOUNT, close_hides, may_kill, own_process_tree, is_webview2_image, ImagePaths, targets_only_webview, other_install_present, targets_own_process, targets_protected, PROTECTED_PROCESSES, enforcement_decision, is_silent_launch, iso8601_utc, wipe_all_blocks, EnforcementDecision, LockProfile};

    fn profile_with_fuse() -> LockProfile {
        let mut p: LockProfile = serde_json::from_str("{}").unwrap();
        p.focus_active = true;
        p.session_end_time = Some(2_000);
        p.bailout_deadline = Some(1_000);
        p.bailout_used_date = Some("2026-11-03".to_string());
        p
    }

    const APP_COMMANDS: &[&str] = include!("app_commands.in");

    #[test]
    fn the_command_list_matches_the_handler() {
        let src = include_str!("lib.rs").replace("#[cfg(debug_assertions)] companion_", "companion_");
        let open = "generate_handler![";
        let start = src.find(open).unwrap() + open.len();
        let end = start + src[start..].find(']').unwrap();
        let mut handler: Vec<&str> = src[start..end].split(',').map(str::trim).collect();
        let mut listed = APP_COMMANDS.to_vec();
        handler.sort();
        listed.sort();
        assert_eq!(handler, listed);
    }

    /// A window created with focus takes the foreground even while hidden: a --silently
    /// launch would pull the user out of whatever they are doing. The boot thread and
    /// show_main_window focus it when it is actually shown.
    #[test]
    fn main_is_created_without_focus() {
        // The Store build's config only overlays this one, so it inherits the window.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &conf["app"]["windows"][0];
        assert_eq!(main["visible"], false);
        assert_eq!(main["focus"], false);
        let store: serde_json::Value = serde_json::from_str(include_str!("../tauri.store.conf.json")).unwrap();
        assert!(store["app"]["windows"].is_null());
    }

    #[test]
    fn only_main_is_granted_commands_in_both_builds() {
        for raw in [
            include_str!("../capabilities/nsis/default.json"),
            include_str!("../capabilities/store/store.json"),
        ] {
            let cap: serde_json::Value = serde_json::from_str(raw).unwrap();
            assert_eq!(cap["windows"], serde_json::json!(["main"]));
            let granted = cap["permissions"].as_array().unwrap();
            for command in APP_COMMANDS {
                let permission = format!("allow-{}", command.replace('_', "-"));
                assert!(granted.iter().any(|p| p == permission.as_str()), "{} missing", permission);
            }
        }
    }

    fn this_pc() -> ImagePaths {
        ImagePaths {
            windir: r"c:\windows".to_string(),
            own_exe: Some(r"c:\program files\lock-in\app.exe".to_string()),
            webview_dirs: vec![r"c:\program files (x86)\microsoft\edgewebview\application\".to_string()],
        }
    }
    const WEBVIEW: &str = r"c:\program files (x86)\microsoft\edgewebview\application\131.0.2903.70\msedgewebview2.exe";

    #[test]
    fn a_term_never_kills_the_webview_but_still_kills_edge() {
        let paths = this_pc();
        let none = std::collections::HashSet::new();
        let edge = Some(r"c:\program files (x86)\microsoft\edge\application\msedge.exe");
        assert!(may_kill("msedge", 10, edge, "msedge", &paths, &none));
        assert!(!may_kill("msedgewebview2", 11, Some(WEBVIEW), "msedge", &paths, &none));
        assert!(!may_kill("msedgewebview2", 11, Some(WEBVIEW), "edge", &paths, &none));
        assert!(!may_kill("app", 12, Some(r"c:\program files\lock-in\app.exe"), "app", &paths, &none));
        assert!(may_kill("whatsapp", 13, Some(r"c:\users\u\whatsapp.exe"), "whatsapp", &paths, &none));
        assert!(!may_kill("notepad", 14, Some(r"c:\windows\system32\notepad.exe"), "discord", &paths, &none));
    }

    #[test]
    fn m8_windows_processes_are_protected_where_windows_keeps_them() {
        let paths = this_pc();
        let none = std::collections::HashSet::new();
        assert!(!may_kill("svchost", 1, Some(r"c:\windows\system32\svchost.exe"), "svchost", &paths, &none));
        assert!(!may_kill("svchost", 1, Some(r"c:\windows\syswow64\svchost.exe"), "svchost", &paths, &none));
        assert!(!may_kill("explorer", 2, Some(r"c:\windows\explorer.exe"), "explorer", &paths, &none));
        assert!(!may_kill("taskmgr", 3, Some(r"c:\windows\system32\taskmgr.exe"), "taskmgr", &paths, &none));
        // An image Windows won't name to us (csrss, System): never killed.
        assert!(!may_kill("csrss", 4, None, "csrss", &paths, &none));
        assert!(!may_kill("system", 5, None, "system", &paths, &none));
    }

    #[test]
    fn m8_a_protected_name_anywhere_else_is_not_protected() {
        let paths = this_pc();
        let none = std::collections::HashSet::new();
        // A game copied to these names keeps no protection from the name.
        assert!(may_kill("svchost", 20, Some(r"c:\users\u\downloads\svchost.exe"), "svchost", &paths, &none));
        assert!(may_kill("explorer", 21, Some(r"c:\windows\system32\..\..\users\u\explorer.exe"), "explorer", &paths, &none));
        assert!(may_kill("explorer", 22, Some(r"c:\games\explorer.exe"), "explorer", &paths, &none));
        assert!(may_kill("msedgewebview2", 23, Some(r"c:\users\u\desktop\msedgewebview2.exe"), "msedge", &paths, &none));
        assert!(may_kill("app", 24, Some(r"c:\users\u\app.exe"), "app", &paths, &none));
        // A Windows folder name used as a prefix of another folder is not it.
        assert!(may_kill("svchost", 25, Some(r"c:\windows\system32x\svchost.exe"), "svchost", &paths, &none));
    }

    #[test]
    fn m8_paths_compare_without_case_or_slash_differences() {
        let paths = this_pc();
        let none = std::collections::HashSet::new();
        assert!(!may_kill("svchost", 1, Some(r"C:\Windows\System32\SVCHOST.EXE"), "svchost", &paths, &none));
        assert!(!may_kill("app", 2, Some("C:/Program Files/Lock-In/App.exe"), "app", &paths, &none));
    }

    #[test]
    fn terms_that_could_only_hit_the_webview_are_refused() {
        for term in ["webview", "webview2", "msedgewebview2", "view2"] {
            assert!(targets_only_webview(term), "{}", term);
        }
        for term in ["msedge", "edge", "discord"] {
            assert!(!targets_only_webview(term), "{}", term);
        }
    }

    #[test]
    fn nothing_in_lock_ins_own_webview_tree_is_killed() {
        // (pid, parent, image is WebView2)
        let processes = [
            (100, Some(1), false),   // app.exe, us
            (101, Some(100), true),  // our webview
            (102, Some(101), true),  // its renderer
            (200, Some(1), true),    // Teams' webview
            (201, Some(200), true),
        ];
        let tree = own_process_tree(&processes, 100);
        assert_eq!(tree, std::collections::HashSet::from([100, 101, 102]));
    }

    #[test]
    fn m9_only_webview2_images_join_our_tree() {
        // Anything else Lock-In happens to start is the user's, and blockable.
        let processes = [
            (100, Some(1), false),   // us
            (101, Some(100), true),  // our webview
            (300, Some(100), false), // a browser, an app opened from a shortcut, a game
            (301, Some(300), false),
            (302, Some(101), false), // even under the webview: not WebView2, not ours
        ];
        let tree = own_process_tree(&processes, 100);
        assert_eq!(tree, std::collections::HashSet::from([100, 101]));
        let paths = this_pc();
        assert!(may_kill("fortnite", 300, Some(r"c:\games\fortnite.exe"), "fortnite", &paths, &tree));
        assert!(may_kill("helper", 302, Some(r"c:\users\u\helper.exe"), "helper", &paths, &tree));
    }

    #[test]
    fn m9_webview2_is_known_by_its_image_path() {
        let paths = this_pc();
        assert!(is_webview2_image(Some(WEBVIEW), &paths));
        assert!(!is_webview2_image(Some(r"c:\users\u\msedgewebview2.exe"), &paths));
        assert!(!is_webview2_image(Some(r"c:\program files (x86)\microsoft\edgewebview\application\131.0\notwebview.exe"), &paths));
        assert!(!is_webview2_image(None, &paths));
    }

    #[test]
    fn only_terms_that_would_match_our_own_process_are_refused() {
        // Direct-download and dev builds run as app.exe.
        for allowed in ["whatsapp", "apple", "appstore", "steamapp"] {
            assert!(!targets_own_process(allowed, "app"), "{}", allowed);
        }
        assert!(targets_own_process("app", "app"));
        // The Store build runs as Lock-In.exe.
        assert!(targets_own_process("lock", "lock-in"));
        assert!(targets_own_process("lock-in", "lock-in"));
        assert!(!targets_own_process("lockin", "lock-in"));
        assert!(!targets_own_process("whatsapp", "lock-in"));
    }

    #[test]
    fn system_processes_are_still_protected_both_ways() {
        let system: Vec<String> = PROTECTED_PROCESSES.iter().map(|s| s.to_string()).collect();
        assert!(targets_protected("ser", &system));
        assert!(targets_protected("explorer2", &system));
        assert!(!targets_protected("whatsapp", &system));
    }

    fn win(pid: u32, visible: bool, owned: bool, titled: bool) -> TopWindow {
        TopWindow { pid, visible, owned, titled }
    }

    #[test]
    fn the_picker_uses_the_same_main_window_rule_as_get_process() {
        let got = pids_with_titled_main_window(&[
            win(1, true, false, true),  // an ordinary app
            win(2, false, false, true), // hidden: not a main window
            win(3, true, true, true),   // owned, like a dialog: not a main window
            win(4, true, false, false), // main window has no title
            win(4, true, false, true),  // and a later one doesn't change that
            win(5, false, false, true), // skipped
            win(5, true, false, true),  // so this is its main window
        ]);
        assert_eq!(got, std::collections::HashSet::from([1, 5]));
    }

    #[test]
    fn the_picker_lists_names_as_it_always_did() {
        let got = picker_names(
            ["Spotify.exe", "spotify.exe", "Discord.exe", "app.exe", "Lock-In.exe", "cmd.exe", "powershell.exe", "  "]
                .map(String::from),
            "app",
        );
        assert_eq!(got, vec!["discord.exe", "spotify.exe"]);
    }

    #[test]
    fn terminate_process_really_ends_a_process() {
        let mut child = std::process::Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        assert!(terminate_process(child.id()));
        assert_eq!(child.wait().unwrap().code(), Some(1));
    }

    #[test]
    fn terminate_process_reports_a_process_that_isnt_there() {
        assert!(!terminate_process(0xFFFF_FFF0));
    }

    #[test]
    fn nothing_shells_out_to_these_any_more() {
        let src = include_str!("lib.rs");
        for name in ["powershell", "rundll32", "taskkill"] {
            assert!(!src.contains(&format!("Command::new(\"{}", name)), "{}", name);
        }
        // sysinfo's kill spawns taskkill.exe on Windows.
        assert!(!src.contains(&format!("process{}kill()", ".")));
    }

    /// A real .lnk on disk, written through the same COM interfaces.
    fn write_shortcut(path: &std::path::Path, target: &str) {
        use windows::core::{Interface, HSTRING};
        use windows::Win32::System::Com::*;
        use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
        let path = path.to_path_buf();
        let target = target.to_string();
        std::thread::spawn(move || unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            link.SetPath(&HSTRING::from(target.as_str())).unwrap();
            link.cast::<IPersistFile>()
                .unwrap()
                .Save(&HSTRING::from(path.to_str().unwrap()), true)
                .unwrap();
            CoUninitialize();
        })
        .join()
        .unwrap();
    }

    #[test]
    fn a_shortcut_resolves_to_its_target() {
        let dir = std::env::temp_dir().join(format!("lockin-lnk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let notepad = std::env::var("SystemRoot").unwrap() + "\\notepad.exe";
        // Including the characters the old PowerShell string had to strip or escape.
        for name in ["plain.lnk", "it's & a; `test.lnk"] {
            let lnk = dir.join(name);
            write_shortcut(&lnk, &notepad);
            let got = resolve_shortcut(lnk.to_str().unwrap().to_string()).unwrap();
            assert_eq!(got.to_lowercase(), notepad.to_lowercase(), "{}", name);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn what_isnt_a_shortcut_is_refused_as_before() {
        assert_eq!(resolve_shortcut("C:\\x\\notes.txt".into()).unwrap_err(), "Invalid shortcut path");
        assert_eq!(resolve_shortcut("C:\\no\\such\\file.lnk".into()).unwrap_err(), "Could not resolve shortcut");
        let notepad = std::env::var("SystemRoot").unwrap() + "\\notepad.exe";
        assert_eq!(resolve_shortcut(notepad).unwrap_err(), "Could not resolve shortcut");
    }

    #[test]
    fn the_check_really_reads_the_process_table() {
        assert!(process_table_readable());
    }

    #[test]
    fn calibration_says_the_same_things_it_always_did() {
        let ok = sniper_status(true);
        assert!(ok.ready);
        assert_eq!(ok.message, "Sniper subsystem online. Process termination active.");
        let bad = sniper_status(false);
        assert!(!bad.ready);
        assert_eq!(bad.message, "Sniper subsystem degraded — run as Administrator.");
    }

    #[cfg(not(feature = "dev-mode"))]
    #[test]
    fn a_release_build_never_asks_for_dev_mode_and_the_fuse_is_five_minutes() {
        let mut asked = false;
        let fuse = super::fuse_ms_for(|| {
            asked = true;
            true
        });
        assert!(!asked, "a release build must not look for DEV_MODE at all");
        assert_eq!(fuse, 5 * 60 * 1000);
        // Neither file name is anywhere in the code a release build compiles: the only
        // mentions of either are behind the dev-mode feature.
        let src = include_str!("lib.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for name in ["\"DEV_MODE\"", "\"DEV_EXTENSION_ID\"", "BAILOUT_FUSE_DEV_MS"] {
            assert!(body.matches(name).count() > 0, "{name} not found: the check would prove nothing");
            for (at, _) in body.match_indices(name) {
                let item_start = body[..at].rfind("\n#[cfg(").or_else(|| body[..at].rfind("\n    #[cfg(")).unwrap();
                let gate = &body[item_start..at];
                assert!(gate.contains("#[cfg(feature = \"dev-mode\")]"), "{name} at byte {at} is not behind dev-mode");
            }
        }
    }

    #[cfg(feature = "dev-mode")]
    #[test]
    fn a_dev_mode_build_burns_the_same_five_minute_fuse() {
        // The rules refuse a bailoutEnd under now + 270 s (1.3.1 B2), so a shorter
        // dev fuse would be refused in Firebase while Rust ended the session.
        assert_eq!(super::fuse_ms_for(|| true), 5 * 60 * 1000);
        assert_eq!(super::fuse_ms_for(|| false), 5 * 60 * 1000);
    }

    /// The shortest fuse database.rules.json accepts when Bail out is armed.
    fn rules_min_fuse_ms() -> u64 {
        let rules = include_str!("../../../../database.rules.json");
        let key = "newData.child('sessionState/bailoutEnd').val() >= now + ";
        let at = rules.find(key).expect("the rules' bailoutEnd minimum") + key.len();
        let digits: String = rules[at..].chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().unwrap()
    }

    #[test]
    fn every_build_arms_a_fuse_the_rules_accept() {
        let min = rules_min_fuse_ms();
        assert_eq!(min, 270_000);
        assert!(super::fuse_ms_for(|| true) >= min, "dev-mode fuse under the rules' minimum");
        assert!(super::fuse_ms_for(|| false) >= min);
    }

    #[test]
    fn shell_execute_reports_success_above_32() {
        assert!(shell_execute_succeeded(33));
        assert!(!shell_execute_succeeded(32));
        assert!(!shell_execute_succeeded(2)); // file not found
        assert!(!shell_execute_succeeded(0));
    }

    #[test]
    fn chrome_is_looked_for_machine_wide_then_per_user() {
        let got = store_browser_candidates(
            "chrome",
            &[Some("C:\\PF".into()), None],
            Some("C:\\Local".into()),
        );
        assert_eq!(
            got,
            vec![
                std::path::PathBuf::from("C:\\PF\\Google\\Chrome\\Application\\chrome.exe"),
                std::path::PathBuf::from("C:\\Local\\Google\\Chrome\\Application\\chrome.exe"),
            ]
        );
    }

    #[test]
    fn the_store_opens_in_the_browser_web_guard_is_for() {
        let pf = [Some("C:\\PF86".into())];
        let edge = store_browser_candidates("edge", &pf, None);
        assert_eq!(edge, vec![std::path::PathBuf::from("C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe")]);
        let brave = store_browser_candidates("brave", &pf, Some("C:\\Local".into()));
        assert_eq!(brave[1], std::path::PathBuf::from("C:\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"));
        // Anything else is Chrome: the page only installs into those three.
        assert!(store_browser_candidates("opera", &pf, None)[0].ends_with("chrome.exe"));
    }

    #[test]
    fn the_warning_says_how_to_keep_a_web_guard_browser_open() {
        for id in ["chrome", "edge", "brave"] {
            let m = lockdown_warning(id, false, false, None);
            assert!(m.contains("Install Web Guard in this browser to keep using it during sessions"), "{m}");
            // It can't tell more, so one general line on the account.
            assert!(m.contains("signed in to this Lock-In account"), "{m}");
            assert!(m.contains(WEB_GUARD_STORE_URL), "{m}");
        }
        for id in ["opera_gx", "firefox", "vivaldi"] {
            let m = lockdown_warning(id, false, false, None);
            assert!(!m.contains("Install Web Guard"), "{m}");
            assert!(m.contains("can't block sites in it"), "{m}");
        }
        assert!(lockdown_warning("edge", true, false, None).starts_with("Web Guard stopped answering in Edge"));
    }

    #[test]
    fn web_guard_is_told_only_its_own_accounts_site_session() {
        let mut p: LockProfile = serde_json::from_str("{}").unwrap();
        p.focus_active = true;
        p.session_blocks_sites = true;
        p.session_end_time = Some(10_000);
        p.session_uid = Some("u1".into());
        p.bailout_deadline = Some(8_000);
        let r = super::session_reply(&p, Some("u1"), 1_000);
        assert_eq!((r.active, r.end_time, r.bailout_end), (true, Some(10_000), Some(8_000)));
        assert!(!super::session_reply(&p, Some("u2"), 1_000).active, "another account");
        assert!(!super::session_reply(&p, None, 1_000).active, "signed out");
        assert!(!super::session_reply(&p, Some("u1"), 10_000).active, "over");
        p.session_blocks_sites = false;
        assert!(!super::session_reply(&p, Some("u1"), 1_000).active, "apps only");
    }

    #[test]
    fn incognito_and_site_access_gaps_say_how_to_fix_them() {
        use crate::coverage::Gap;
        let m = lockdown_warning("edge", false, false, Some(Gap::UnseenIncognito));
        assert!(m.starts_with("Edge has a window Web Guard can't see, most likely an Incognito window") && m.contains("Allow in Incognito"), "{m}");
        let m = lockdown_warning("chrome", false, false, Some(Gap::SiteAccess));
        assert!(m.contains("site access is limited") && m.contains("On all sites"), "{m}");
        let m = lockdown_warning("brave", false, false, Some(Gap::NotLocked));
        assert!(m.starts_with("Web Guard in Brave isn't blocking this session."), "{m}");
    }

    #[test]
    fn a_window_web_guard_cant_see_is_named_as_such() {
        let m = lockdown_warning("chrome", false, false, Some(crate::coverage::Gap::UnseenWindows));
        assert!(m.starts_with("Chrome has a window Web Guard can't see: a Guest window, another profile, or an Incognito window."), "{m}");
        assert!(m.contains("Closing Chrome in 10 seconds"), "{m}");
        let lost = lockdown_warning("chrome", true, false, Some(crate::coverage::Gap::UnseenWindows));
        assert!(lost.ends_with("Once closed, it stays closed until the session ends."), "{lost}");
    }

    #[test]
    fn web_guard_on_the_wrong_account_is_told_to_sign_in_with_this_one() {
        let m = lockdown_warning("edge", false, true, None);
        assert!(m.contains("Web Guard is installed but signed in to a different account or signed out — sign in with this account to keep this browser open."), "{m}");
        assert!(!m.contains("Install Web Guard"), "{m}");
        // Signed out mid-session: the same line, and that a close then lasts the session.
        let lost = lockdown_warning("chrome", true, true, None);
        assert!(lost.contains(WRONG_ACCOUNT) && lost.contains("stays closed until the session ends"), "{lost}");
    }

    #[test]
    fn each_build_looks_for_the_other_kind_of_install() {
        // Direct-download build: only the Store package counts, not itself.
        assert!(other_install_present(false, true, true));
        assert!(!other_install_present(false, false, true));
        // Store build: only a direct install counts, not its own package.
        assert!(other_install_present(true, true, true));
        assert!(!other_install_present(true, true, false));
    }

    const MIN: u64 = 60_000;

    fn started(end: u64) -> LockProfile {
        let mut p: LockProfile = serde_json::from_str("{}").unwrap();
        p.focus_active = true;
        p.start_session(0, Some(end), Some("Write".to_string()), Some("uid1".to_string()), false, false);
        p
    }

    /// Enforcer ticks every 2 s from `from` up to and including `to`.
    fn tick(p: &mut LockProfile, from: u64, to: u64) {
        let mut t = from;
        while t <= to {
            p.note_clock(t);
            t += 2_000;
        }
    }

    #[test]
    fn a_session_ended_by_the_enforcer_alone_is_credited_in_full() {
        // Nothing here touches a webview: this is the hidden-window case.
        let mut p = started(2 * MIN);
        tick(&mut p, 2_000, 2 * MIN);
        p.end_session(2 * MIN);
        assert_eq!(p.pending_records.len(), 1);
        let r = &p.pending_records[0];
        assert_eq!((r.minutes, r.status.as_str(), r.ended_at), (2, "completed", 2 * MIN));
        assert_eq!((r.objective.as_str(), r.uid.as_deref()), ("Write", Some("uid1")));
        assert!(!p.focus_active);
    }

    /// The enforcer's tick with both clocks: `wall` is what the PC's clock says,
    /// `tick` is GetTickCount64. Returns whether the session ended on this tick.
    fn tick_clocks(p: &mut LockProfile, wall: u64, tick: u64) -> bool {
        p.watch_clock(wall, tick);
        p.note_clock(wall);
        let deadline = match (p.session_end_time, p.bailout_deadline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        if let Some(end) = deadline {
            if p.focus_active && wall >= end {
                p.end_session(end);
                return true;
            }
        }
        false
    }

    #[test]
    fn a_clock_moved_forward_doesnt_end_the_session_early() {
        let mut p = started(30 * MIN);
        // Ten real minutes, wall and tick together (tick started at 7 s here).
        let mut t = 2_000;
        while t <= 10 * MIN {
            assert!(!tick_clocks(&mut p, t, t + 7_000));
            t += 2_000;
        }
        // The clock is set two hours ahead: the session's old end is long past on it.
        let jump = 2 * 60 * MIN;
        assert!(!tick_clocks(&mut p, 10 * MIN + 2_000 + jump, 10 * MIN + 2_000 + 7_000), "not ended by the jump");
        assert_eq!(p.session_end_time, Some(30 * MIN + jump), "the deadline moved with the clock");
        // It ends after 30 real minutes, credited in full.
        let mut ended_at = None;
        let mut t = 10 * MIN + 4_000;
        while t <= 31 * MIN {
            if tick_clocks(&mut p, t + jump, t + 7_000) {
                ended_at = Some(t);
                break;
            }
            t += 2_000;
        }
        assert_eq!(ended_at, Some(30 * MIN));
        let r = p.pending_records.last().unwrap();
        assert_eq!((r.status.as_str(), r.minutes), ("completed", 30));
    }

    #[test]
    fn a_clock_moved_back_doesnt_make_the_session_longer() {
        // A session ending at 2 h; the clock is set back by 1 h at 1 h 10.
        let h = 60 * MIN;
        let mut p = started(2 * h);
        let mut t = 2_000;
        while t <= h + 10 * MIN {
            assert!(!tick_clocks(&mut p, t, t));
            t += 2_000;
        }
        assert!(!tick_clocks(&mut p, t - h, t));
        assert_eq!(p.session_end_time, Some(h), "the deadline moved back by the hour");
        // It ends at 2 h of real time, not 3.
        let mut ended_at = None;
        let mut t = t + 2_000;
        while t <= 3 * h {
            if tick_clocks(&mut p, t - h, t) {
                ended_at = Some(t);
                break;
            }
            t += 2_000;
        }
        assert_eq!(ended_at, Some(2 * h));
    }

    #[test]
    fn sleep_across_the_deadline_still_ends_it_normally() {
        let mut p = started(30 * MIN);
        let mut t = 2_000;
        while t <= 20 * MIN {
            tick_clocks(&mut p, t, t);
            t += 2_000;
        }
        // Asleep for an hour: GetTickCount64 counted it too, so no clock jump.
        let woke = 20 * MIN + 60 * MIN;
        assert!(tick_clocks(&mut p, woke, woke), "ends on the first tick after waking");
        assert_eq!(p.clock.skew_ms, 0, "sleep isn't a clock change");
        let r = p.pending_records.last().unwrap();
        assert_eq!(r.ended_at, 30 * MIN, "at its own deadline, not moved");
        // Ended at its deadline as usual; the sleep isn't credited, 20 minutes of 30.
        assert_eq!((r.status.as_str(), r.minutes), ("completed", 20));
    }

    #[test]
    fn a_time_zone_moved_across_midnight_gives_no_second_bail_out() {
        use crate::clock::day_at;
        // 2026-11-19 23:00 in Singapore (UTC+8) = 15:00 UTC.
        let utc_15h = 1_795_100_400_000u64; // 2026-11-19T15:00:00Z
        assert_eq!(day_at(utc_15h, 480), "2026-11-19");
        let mut p = started(utc_15h + 60 * MIN);
        let fuse = 5 * MIN;
        let first = crate::integrity::arm_bailout_at(&mut p, utc_15h, &day_at(utc_15h, 480), 480, fuse);
        assert!(first.armed);
        // The fuse burns down; a new session starts.
        p.end_session(utc_15h + fuse);
        p.focus_active = true;
        p.start_session(utc_15h + 6 * MIN, Some(utc_15h + 90 * MIN), None, Some("uid1".into()), false, false);
        // Ten minutes later the zone is moved to UTC+10: it's 01:10 "tomorrow" there.
        let now = utc_15h + 10 * MIN;
        let there = day_at(now, 600);
        assert_eq!(there, "2026-11-20");
        let second = crate::integrity::arm_bailout_at(&mut p, now, &there, 600, fuse);
        assert_eq!(second.refused.as_deref(), Some("used-today"), "still the 19th where it was used");
        // Once it's the 20th in Singapore too, it's a new day.
        let next_day = utc_15h + 61 * MIN;
        let third = crate::integrity::arm_bailout_at(&mut p, next_day, &day_at(next_day, 600), 600, fuse);
        assert!(third.armed, "{:?}", third.refused);
    }

    #[test]
    fn a_clock_moved_a_day_ahead_gives_no_second_bail_out() {
        use crate::clock::day_at;
        let utc_15h = 1_795_100_400_000u64;
        let mut p = started(utc_15h + 120 * MIN);
        p.watch_clock(utc_15h, 1_000);
        assert!(crate::integrity::arm_bailout_at(&mut p, utc_15h, &day_at(utc_15h, 480), 480, 5 * MIN).armed);
        p.end_session(utc_15h + 5 * MIN);
        p.focus_active = true;
        p.start_session(utc_15h + 6 * MIN, Some(utc_15h + 60 * MIN), None, Some("uid1".into()), false, false);
        // The clock is set a day ahead.
        let day = 24 * 60 * MIN;
        let wall = utc_15h + 7 * MIN + day;
        p.watch_clock(wall, 1_000 + 7 * MIN);
        let today = day_at(p.clock.true_now(wall), 480);
        assert_eq!(today, "2026-11-19", "the day comes from the time that really passed");
        let again = crate::integrity::arm_bailout_at(&mut p, wall, &today, 480, 5 * MIN);
        assert_eq!(again.refused.as_deref(), Some("used-today"));
    }

    #[test]
    fn time_asleep_is_not_credited() {
        let mut p = started(25 * MIN);
        tick(&mut p, 2_000, 5 * MIN);
        tick(&mut p, 20 * MIN, 25 * MIN);
        p.end_session(25 * MIN);
        assert_eq!(p.pending_records[0].minutes, 10);
        assert_eq!(p.pending_records[0].status, "completed");
    }

    #[test]
    fn sleeping_past_the_end_credits_only_the_awake_part() {
        let mut p = started(25 * MIN);
        tick(&mut p, 2_000, 10 * MIN);
        p.note_clock(130 * MIN);
        p.end_session(25 * MIN);
        assert_eq!(p.pending_records[0].minutes, 10);
    }

    #[test]
    fn a_normal_tick_counts_and_a_gap_does_not() {
        assert_eq!(awake_in_gap(1_000, 3_000, Some(100 * MIN)), 2_000);
        assert_eq!(awake_in_gap(1_000, 1_000 + 29_999, Some(100 * MIN)), 29_999);
        assert_eq!(awake_in_gap(1_000, 1_000 + 30_000, Some(100 * MIN)), 0);
        // Capped at the session's end, and a backward clock counts for nothing.
        assert_eq!(awake_in_gap(10 * MIN, 10 * MIN + 2_000, Some(10 * MIN + 500)), 500);
        assert_eq!(awake_in_gap(10 * MIN, 5 * MIN, Some(25 * MIN)), 0);
    }

    #[test]
    fn time_with_the_app_closed_is_not_credited() {
        let mut p = started(10 * MIN);
        tick(&mut p, 2_000, 3 * MIN);
        let saved = serde_json::to_string(&p).unwrap();
        // Relaunched at minute 8: the restored profile has no last clock check.
        let mut p: LockProfile = serde_json::from_str(&saved).unwrap();
        tick(&mut p, 8 * MIN, 10 * MIN);
        p.end_session(10 * MIN);
        assert_eq!(p.pending_records[0].minutes, 5);
    }

    #[test]
    fn a_session_that_expired_while_closed_keeps_what_it_earned() {
        // 1.3.1 (M7, rule b): completed only if awake for the planned time less
        // 60 s. Here 60 s of a 2-minute session: exactly on the line.
        let mut p = started(2 * MIN);
        tick(&mut p, 2_000, MIN);
        let mut p: LockProfile = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(crate::integrity::settle_restored(&mut p, 3 * MIN), vec!["restored-expired"]);
        assert_eq!(p.pending_records[0].minutes, 1);
        assert_eq!(p.pending_records[0].status, "completed");
    }

    #[test]
    fn ending_early_is_aborted_and_ending_at_once_records_nothing() {
        let mut p = started(25 * MIN);
        tick(&mut p, 2_000, 3 * MIN);
        p.end_session(3 * MIN);
        assert_eq!(p.pending_records[0].status, "aborted");
        assert_eq!(p.pending_records[0].minutes, 3);

        let mut q = started(25 * MIN);
        q.end_session(1_000);
        assert!(q.pending_records.is_empty());
    }

    #[test]
    fn records_survive_a_restart_until_acknowledged() {
        let mut p = started(2 * MIN);
        tick(&mut p, 2_000, 2 * MIN);
        p.end_session(2 * MIN);
        let mut p: LockProfile = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(p.pending_records.len(), 1);
        assert!(!p.ack_record(1));
        assert!(p.ack_record(2 * MIN));
        assert!(p.pending_records.is_empty());
    }

    #[test]
    fn a_running_session_always_hides_on_close() {
        assert!(close_hides(true, false));
        assert!(close_hides(true, true));
        assert!(close_hides(false, true));
        assert!(!close_hides(false, false));
    }

    /// A profile as the app has it: the defaults, with or without a session running.
    fn profile(session: bool) -> LockProfile {
        let mut p: LockProfile = serde_json::from_str("{}").unwrap();
        p.focus_active = session;
        p
    }

    #[test]
    fn x_with_no_session_hides_to_the_tray() {
        // The defaults: "keep running" is on, so the X (and Alt+F4, and the taskbar's Close,
        // which all arrive as the same CloseRequested) hides the window and the app runs on.
        let p = profile(false);
        assert!(!p.armed());
        assert!(close_hides(p.armed(), p.close_to_tray));
    }

    #[test]
    fn x_during_a_session_hides_to_the_tray_whatever_the_setting() {
        for keep_running in [true, false] {
            let mut p = profile(true);
            p.close_to_tray = keep_running;
            assert!(p.armed());
            assert!(close_hides(p.armed(), p.close_to_tray), "keep running {keep_running}");
        }
    }

    #[test]
    fn x_with_no_session_and_keep_running_off_closes_as_in_1_2_10() {
        // The one close that isn't prevented, as in 1.2.10: the user turned "keep running" off.
        let mut p = profile(false);
        p.close_to_tray = false;
        assert!(!close_hides(p.armed(), p.close_to_tray));
    }

    #[test]
    fn tray_quit_is_refused_during_a_session_and_allowed_otherwise() {
        assert!(!quit_allowed(profile(true).armed()));
        assert!(quit_allowed(profile(false).armed()));
    }

    #[test]
    fn the_only_ways_out_are_tray_quit_and_a_close_that_was_not_prevented() {
        let src = include_str!("lib.rs").replace("\r\n", "\n");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        // Exactly two exits in the app: the tray's Quit, behind quit_allowed, and main being destroyed.
        assert_eq!(body.matches(".exit(0)").count(), 2);
        let quit = &body[body.find("fn tray_quit").unwrap()..];
        let quit = &quit[..quit.find("\n}\n").unwrap()];
        assert!(quit.find("if !quit_allowed(armed)").unwrap() < quit.find("app.exit(0)").unwrap());
        // The close handler prevents the close whenever it hides, so main is never destroyed then;
        // only main's destruction exits, and it hides only the window that was closed, so the
        // parrot's window stays on screen.
        let handler = &body[body.find(".on_window_event(").unwrap()..];
        let handler = &handler[..handler.find(".invoke_handler(").unwrap()];
        assert!(handler.contains("if hide {\n                    api.prevent_close();\n                    let _ = window.hide();"));
        assert!(handler.contains("matches!(event, tauri::WindowEvent::Destroyed) && window.label() == \"main\""));
        // Nothing else in the Rust ends the app or destroys main: companion.rs destroys only its own window.
        let companion = include_str!("companion.rs").replace("\r\n", "\n");
        assert!(!companion.contains(".exit("));
        assert_eq!(companion.matches(".destroy()").count(), 1);
        assert!(companion.contains("const LABEL: &str = \"parrot\";"));
    }

    #[test]
    fn keep_running_defaults_on_for_old_state_files() {
        let p: LockProfile = serde_json::from_str("{}").unwrap();
        assert!(p.close_to_tray);
    }

    #[test]
    fn a_sign_in_launch_shows_the_dashboard_without_taking_focus() {
        assert_eq!(boot_show(true), BootShow::ShowWithoutFocus);
        assert_eq!(boot_show(false), BootShow::ShowAndFocus);
        // The sign-in path shows with SW_SHOWNOACTIVATE and never calls set_focus.
        let src = include_str!("lib.rs").replace("\r\n", "\n");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        let arm = &body[body.find("BootShow::ShowWithoutFocus => {").unwrap()..];
        let arm = &arm[..arm.find("}").unwrap()];
        assert!(arm.contains("show_without_focus(&boot_window)"));
        assert!(!arm.contains("set_focus"));
        let helper = &body[body.find("fn show_without_focus").unwrap()..];
        let helper = &helper[..helper.find("\n}\n").unwrap()];
        assert!(helper.contains("SW_SHOWNOACTIVATE"));
        assert!(!helper.contains(".show()") && !helper.contains("set_focus"));
        // And main is still created hidden and unfocused, so nothing shows or focuses earlier.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["windows"][0]["visible"], false);
        assert_eq!(conf["app"]["windows"][0]["focus"], false);
    }

    /// The webview's CSP, directive by directive (1.3.1 M10).
    fn csp_directives() -> std::collections::HashMap<String, Vec<String>> {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let store: serde_json::Value = serde_json::from_str(include_str!("../tauri.store.conf.json")).unwrap();
        assert!(store["app"]["security"].get("csp").is_none(), "the Store build must use the same CSP");
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        csp.split(';')
            .filter_map(|d| {
                let mut parts = d.split_whitespace();
                Some((parts.next()?.to_string(), parts.map(str::to_string).collect()))
            })
            .collect()
    }

    #[test]
    fn m10_the_csp_names_the_exact_database_and_no_eval() {
        const DB: &str = "synchrofocus-ac0f2-default-rtdb.asia-southeast1.firebasedatabase.app";
        let d = csp_directives();
        let all: Vec<&String> = d.values().flatten().collect();
        assert!(!all.iter().any(|s| s.as_str() == "'unsafe-eval'"), "unsafe-eval");
        assert!(!all.iter().any(|s| s.contains('*')), "a wildcard host: {:?}", all.iter().filter(|s| s.contains('*')).collect::<Vec<_>>());
        for bare in ["https:", "wss:", "http:", "ws:", "*"] {
            for name in ["connect-src", "script-src", "frame-src", "default-src"] {
                assert!(!d[name].iter().any(|s| s == bare), "{name} allows any {bare} host");
            }
        }
        let want = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            d["connect-src"],
            want(&[
                "'self'", "ipc:", "http://ipc.localhost",
                &format!("https://{DB}"), &format!("wss://{DB}"),
                "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com",
            ])
        );
        assert_eq!(d["script-src"], want(&["'self'", "'unsafe-inline'", &format!("https://{DB}")]));
        assert_eq!(d["frame-src"], want(&["https://calendar.google.com", &format!("https://{DB}")]));
        assert_eq!(d["default-src"], want(&["'self'", "tauri:"]));
    }

    #[test]
    fn m10_the_updater_is_not_the_webviews_business() {
        // The updater fetches from Rust (tauri-plugin-updater), so the CSP doesn't
        // need GitHub; the endpoint stays HTTPS on github.com.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let endpoints = conf["plugins"]["updater"]["endpoints"].as_array().unwrap();
        assert!(endpoints.iter().all(|e| e.as_str().unwrap().starts_with("https://github.com/")));
        assert!(!csp_directives()["connect-src"].iter().any(|s| s.contains("github")));
    }

    #[test]
    fn silent_launch_is_only_the_exact_flag() {
        assert!(is_silent_launch(&["app.exe", "--silently"]));
        assert!(!is_silent_launch(&["app.exe"]));
        assert!(!is_silent_launch(&["app.exe", "--silent"]));
    }

    #[test]
    fn a_bailed_out_session_is_recorded_void_however_it_ended() {
        let mut p = profile_with_fuse();
        p.session_awake_ms = 20 * 60_000;
        p.end_session(1_000);
        assert!(!p.focus_active);
        assert_eq!(p.session_end_time, None);
        assert_eq!(p.bailout_deadline, None);
        assert_eq!(p.pending_records[0].minutes, 0);
        assert_eq!(p.pending_records[0].status, "bailed-out");
        assert_eq!(p.bailout_used_date.as_deref(), Some("2026-11-03"));
    }

    #[test]
    fn remote_stop_is_ignored_only_while_armed() {
        assert_eq!(enforcement_decision(false, true, true, false), EnforcementDecision::IgnoreRemoteStop);
        assert_eq!(enforcement_decision(false, true, true, true), EnforcementDecision::IgnoreRemoteStop);
        assert_eq!(enforcement_decision(false, true, false, false), EnforcementDecision::StandDown);
        assert_eq!(enforcement_decision(false, false, true, true), EnforcementDecision::StandDown);
    }

    #[test]
    fn remote_arm_is_always_refused() {
        assert_eq!(enforcement_decision(true, true, false, false), EnforcementDecision::RefuseRemoteArm);
        assert_eq!(enforcement_decision(true, true, true, true), EnforcementDecision::RefuseRemoteArm);
    }

    #[test]
    fn local_arm_refused_only_over_a_burning_fuse() {
        assert_eq!(enforcement_decision(true, false, true, true), EnforcementDecision::RefuseArmDuringFuse);
        assert_eq!(enforcement_decision(true, false, true, false), EnforcementDecision::Arm);
        // A stale fuse with no session behind it: arm clears it.
        assert_eq!(enforcement_decision(true, false, false, true), EnforcementDecision::Arm);
    }

    #[test]
    fn clear_all_blocks_clears_the_fuse_but_not_the_daily_limit() {
        let mut p = profile_with_fuse();
        wipe_all_blocks(&mut p);
        assert_eq!(p.bailout_deadline, None);
        assert_eq!(p.bailout_used_date.as_deref(), Some("2026-11-03"));
        assert!(p.disarm_latch);
    }

    #[test]
    fn arm_refusal_rejects_missing_or_past_deadlines() {
        let now = 1_789_633_173_000;
        assert!(arm_refusal(None, now).is_some());
        assert!(arm_refusal(Some(now - 60_000), now).is_some());
        assert!(arm_refusal(Some(now), now).is_some());
        assert_eq!(arm_refusal(Some(now + 1), now), None);
        assert_eq!(arm_refusal(Some(now + 25 * 60_000), now), None);
    }

    #[test]
    fn iso8601_utc_known_instants() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00.000Z");
        // Leap day, and the last millisecond of a day.
        assert_eq!(iso8601_utc(951_868_799_999), "2000-02-29T23:59:59.999Z");
        assert_eq!(iso8601_utc(951_868_800_000), "2000-03-01T00:00:00.000Z");
        // The 1.2.3 setup.exe signature timestamp, 1789633173 s.
        assert_eq!(iso8601_utc(1_789_633_173_000), "2026-09-17T08:19:33.000Z");
    }
}
