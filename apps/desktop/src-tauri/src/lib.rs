use std::collections::HashSet;
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
use sysinfo::{ProcessRefreshKind, System};
use std::time::{SystemTime, UNIX_EPOCH};
use std::thread;
use std::path::PathBuf;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[derive(Clone, Serialize)]
struct KillPayload {
    name: String,
    timestamp: u64,
}

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
    /// When a fuse ended a session and no bailed-out history entry has been
    /// written for it yet (epoch ms), or None. Only the webview can write the
    /// entry, and a fuse can burn down while the app is closed or signed out,
    /// so what is owed has to outlive the process.
    #[serde(default)]
    unrecorded_bailout: Option<u64>,
    /// Keep running in the tray when the window is closed. A running session
    /// always hides, whatever this says.
    #[serde(default = "default_true")]
    close_to_tray: bool,
    /// How long the PC has been asleep during the running session. Sessions
    /// are credited only for the rest. Reset when a session arms.
    #[serde(default)]
    session_asleep_ms: u64,
    /// When the enforcer last looked at the clock. Not persisted: time with the
    /// app closed isn't sleep, and a restored session credits from adoption.
    #[serde(skip)]
    last_clock_check: Option<u64>,
}

/// The enforcer looks at the clock every 2 s, so a gap this long means nothing
/// was running: asleep or hibernating. A forward clock edit reads the same way
/// and is no more deserving of credit.
const SLEEP_GAP_MS: u64 = 30_000;

/// How much of the gap from `prev` to `now` was sleep inside the session. Time
/// after the session's own end isn't session time, so it can't be taken off.
fn asleep_in_gap(prev: u64, now: u64, session_end: Option<u64>) -> u64 {
    if now.saturating_sub(prev) < SLEEP_GAP_MS {
        return 0;
    }
    session_end.map_or(now, |end| end.min(now)).saturating_sub(prev)
}

impl LockProfile {
    /// Returns true if it found sleep. Called by the enforcer every tick, and
    /// when the webview asks: on waking, its timer can fire first.
    fn note_clock(&mut self, now: u64) -> bool {
        let asleep = match self.last_clock_check {
            Some(prev) if self.focus_active => asleep_in_gap(prev, now, self.session_end_time),
            _ => 0,
        };
        self.last_clock_check = Some(now);
        self.session_asleep_ms += asleep;
        asleep > 0
    }

    /// A session is running here. Closing hides and Quit is refused until it
    /// ends. Permanent blocks don't count: the setting decides for those.
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
/// DEV_MODE shortens it so the whole path can be exercised in a test run.
const BAILOUT_FUSE_DEV_MS: u64 = 30 * 1000;

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

/// PROTECTED_PROCESSES plus this binary's own process name, which differs
/// between the dev build (app.exe) and the bundled product (Lock-In.exe).
fn protected_process_names() -> Vec<String> {
    let mut list: Vec<String> = PROTECTED_PROCESSES.iter().map(|s| s.to_string()).collect();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(stem) = exe.file_stem().and_then(|s| s.to_str()) {
            let safe: String = stem
                .to_lowercase()
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
                .collect();
            if !safe.is_empty() {
                list.push(safe);
            }
        }
    }
    list
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
    if targets_protected(&clean, &protected_process_names()) {
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
///   * the protected list is re-applied here by exact name, mirroring the old
///     `$protected -notcontains $_.Name.ToLower()` clause, so this stays a
///     second boundary behind sanitize_block_entry rather than replacing it.
///
/// Caller must refresh `sys` first. Returns the names actually terminated.
fn kill_processes_matching(sys: &System, term: &str, protected: &[String]) -> Vec<String> {
    let mut killed = Vec::new();
    for process in sys.processes().values() {
        let lowered = process.name().to_lowercase();
        let stem = lowered.strip_suffix(".exe").unwrap_or(&lowered);
        if !stem.contains(term) {
            continue;
        }
        if protected.iter().any(|p| p == stem) {
            println!("[Guard] skipped protected process '{}'", stem);
            continue;
        }
        if process.kill() {
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
    profile.permanent_exe.clear();
    profile.permanent_pending.clear();
    profile.session_end_time = None;
    // A clear is a stand-down too. A fuse left behind would void the next
    // session on its first tick. bailout_used_date stays: one per day.
    profile.bailout_deadline = None;
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

/// True when Windows started us (the plugin's Run key passes this): stay in the
/// tray instead of opening a window on every sign-in.
fn is_silent_launch<S: AsRef<str>>(args: &[S]) -> bool {
    args.iter().any(|a| a.as_ref() == "--silently")
}

const WEB_GUARD_STORE_URL: &str = "https://chromewebstore.google.com/detail/pcmcaccnegefcjhdabjjfhaakjfeocea";

const QUIT_REFUSED_MESSAGE: &str = "A session is running. Use Bail out.";

#[derive(Clone, Serialize)]
struct QuitRefusedPayload {
    reason: String,
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
    if armed {
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

/// End a session that a bail-out voided, and note that its entry is owed.
fn stand_down_voided(profile: &mut LockProfile, at: u64) {
    profile.focus_active = false;
    profile.session_end_time = None;
    profile.bailout_deadline = None;
    profile.unrecorded_bailout = Some(at);
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

    // A surviving disarm latch must still suppress arming, whatever the file
    // claims. Normal writes preserve this invariant; a hand-edited or
    // older-format file might not.
    if p.disarm_latch {
        p.is_locked = false;
        p.focus_active = false;
        p.exe_blacklist.clear();
        p.exe_approved.clear();
        p.exe_pending.clear();
        p.permanent_exe.clear();
        p.permanent_pending.clear();
        p.session_end_time = None;
        p.bailout_deadline = None;
        println!("[Persist] restored with disarm latch SET — forced disarmed, all blocks cleared");
    }

    // Expire a session whose deadline passed while the app was closed, so it
    // never arms even for the first 2 s tick.
    if p.focus_active {
        // A fuse that burned down while the app was closed still fires: the
        // whole point is that quitting cannot outrun it.
        if let Some(fuse) = p.bailout_deadline {
            if now_millis() >= fuse {
                stand_down_voided(&mut p, fuse);
                println!("[Persist] bail-out fuse burned down while closed — stood down, void");
                emit_stood_down(app, "bailout-expired", p.exe_blacklist.len());
            }
        }
    }

    if p.focus_active {
        match p.session_end_time {
            Some(end) if now_millis() >= end => {
                // A session is void once its fuse is armed, whichever deadline
                // ended it (see the sniper), so this one is still owed an entry.
                if p.bailout_deadline.is_some() {
                    p.unrecorded_bailout = Some(end);
                }
                // focus_active=false is what prevents arming; the list stays.
                p.focus_active = false;
                p.session_end_time = None;
                p.bailout_deadline = None;
                println!("[Persist] restored session had already expired — stood down, list retained");
                // Inert at boot — no webview is listening yet — but keeps
                // every stand-down site on the same path. The pull probe on
                // first auth covers this case regardless.
                emit_stood_down(app, "restored-expired", p.exe_blacklist.len());
            }
            Some(_) => {
                // Live deadline — the loop will expire it on time.
            }
            None => {
                // A state file from a build before session_end_time existed
                // (serde default → None). A session with no deadline can never
                // end on its own: that is permanent lockout for anyone upgrading
                // from a pre-deadline build. Stand down; the list stays.
                p.focus_active = false;
                p.bailout_deadline = None;
                println!("[Persist] restored session has NO deadline — standing down");
                emit_stood_down(app, "restored-no-deadline", p.exe_blacklist.len());
            }
        }
    }

    // A state file from before 1.2.9 can hold a fuse with no session behind it
    // (a stand-down that did not clear it). It must not void the next session.
    if !p.focus_active {
        p.bailout_deadline = None;
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
// Called during onboarding calibration to verify the sniper subsystem
// can execute taskkill on this machine. Returns { ready, message }.
#[derive(Clone, Serialize)]
struct SniperStatus {
    ready: bool,
    message: String,
}

#[tauri::command]
fn check_sniper() -> SniperStatus {
    // Dry-run: query taskkill help output — zero side-effects, always succeeds
    // if the Windows taskkill binary is available (it always is on Win10/11).
    let result = std::process::Command::new("taskkill")
        .arg("/?")
        .creation_flags(0x08000000)
        .output();

    match result {
        Ok(out) if out.status.success() || !out.stdout.is_empty() => {
            println!("[Calibration] ✅ Sniper subsystem verified — taskkill available.");
            SniperStatus {
                ready: true,
                message: "Sniper subsystem online. Process termination active.".to_string(),
            }
        }
        Ok(_) => {
            println!("[Calibration] ⚠ taskkill returned non-zero.");
            SniperStatus {
                ready: false,
                message: "Sniper subsystem degraded — run as Administrator.".to_string(),
            }
        }
        Err(e) => {
            println!("[Calibration] ❌ taskkill not found: {}", e);
            SniperStatus {
                ready: false,
                message: format!("Sniper offline: {}", e),
            }
        }
    }
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
#[tauri::command]
fn update_enforcement(
    is_active: bool,
    _blocked_list: Vec<String>, // ignored for arming — approved set is authoritative (G1)
    end_time: Option<u64>,
    from_remote: Option<bool>,
    app: tauri::AppHandle,
    app_state: State<AppState>,
) -> Result<String, String> {
    // A mirrored session from another device is NOT deliberate local action:
    // it can neither arm this desktop nor stop a session armed here.
    let remote = from_remote.unwrap_or(false);
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let now = now_millis();
            let fuse_burning = profile.bailout_deadline.map_or(false, |d| d > now);
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
                // Never arm a session that can't be running. With no deadline it
                // would never expire on its own; with a past one the loop could
                // run a kill pass before its next expiry check. The webview
                // filters these too — this is the backstop.
                if let Some(reason) = arm_refusal(end_time, now_millis()) {
                    println!("[Enforcer] REFUSED arm — {} (remote = {})", reason, remote);
                    return Err(format!("Refused to arm: {}", reason));
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
                profile.session_end_time = end_time;
                profile.session_asleep_ms = 0;
                // Any fuse still set here belongs to a session that is over.
                profile.bailout_deadline = None;
                println!(
                    "🔒 ENFORCER ARMED: Active = {}, remote = {}, approved targets = {:?}, end_time = {:?}",
                    is_active, remote, profile.exe_blacklist, end_time
                );
            } else {
                // Session ending. exe_blacklist is standing config and is NOT
                // cleared — enforcer_active gates whether it is used, and
                // wiping it here meant every stop persisted exe=0, so an
                // offline boot had nothing to restore.
                profile.session_end_time = None;
                // bailout_used_date stays: it is what makes it one per day.
                profile.bailout_deadline = None;
                println!(
                    "🔓 ENFORCER STOOD DOWN: remote={}, {} target(s) retained",
                    remote,
                    profile.exe_blacklist.len()
                );
                // focus_active still holds the PRIOR value here — only a real
                // true→false transition is pushed to the UI.
                if profile.focus_active {
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
    approved_list: Vec<String>,
    from_remote: Option<bool>,
    app: tauri::AppHandle,
    app_state: State<AppState>,
) -> Result<String, String> {
    let remote = from_remote.unwrap_or(false);
    match app_state.profile.lock() {
        Ok(mut profile) => {
            // Disarm latch: a reconnect must not refill anything that a clear
            // just wiped, until a deliberate local session start lifts it.
            if profile.disarm_latch {
                println!("[Enforcer] disarm latch ACTIVE — refusing blocklist sync");
                return Ok("Blocklist sync skipped — disarm latch active".to_string());
            }
            // `all` is every entry in blockedApps. `mine` is the subset the
            // frontend vouches for as this-device origin (H1) — plus, on the
            // first run after upgrade, the pre-existing set (H2).
            let all: HashSet<String> = blocked_list
                .iter()
                .filter_map(|s| sanitize_block_entry(s))
                .collect();
            let mine: HashSet<String> = approved_list
                .iter()
                .filter_map(|s| sanitize_block_entry(s))
                .collect();

            if remote {
                // Approved = anything already approved OR vouched as this-device
                // origin, that still exists in blockedApps. A NEW entry with a
                // different/absent origin is STAGED for local approval (G1),
                // never armed.
                let approved_kept: HashSet<String> = profile
                    .exe_approved
                    .union(&mine)
                    .cloned()
                    .filter(|n| all.contains(n))
                    .collect();
                let pending: HashSet<String> =
                    all.difference(&approved_kept).cloned().collect();
                profile.exe_approved = approved_kept;
                profile.exe_pending = pending.clone();
                // If a session is live, reflect approvals/removals immediately.
                if profile.focus_active {
                    profile.exe_blacklist = profile.exe_approved.clone();
                }
                println!(
                    "📋 BLOCKLIST SYNCED (remote) — {} approved, {} pending approval",
                    profile.exe_approved.len(),
                    pending.len()
                );
                persist_profile(&profile, &app_state.state_path);
                if !pending.is_empty() {
                    emit_exe_pending(&app, &pending);
                }
                Ok(format!("Blocklist sync — {} pending approval", pending.len()))
            } else {
                // Local/trusted path (reserved for an explicit on-device write).
                profile.exe_approved = all.clone();
                profile.exe_pending.clear();
                if profile.focus_active {
                    profile.exe_blacklist = profile.exe_approved.clone();
                }
                println!("📋 BLOCKLIST SYNCED (local) — {} approved", all.len());
                persist_profile(&profile, &app_state.state_path);
                Ok("Blocklist synced".to_string())
            }
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

#[tauri::command]
fn resolve_shortcut(shortcut_path: String) -> Result<String, String> {
    // Validate it looks like a real file path
    // Only allow path-safe characters
    let safe_path = shortcut_path
        .replace("'", "''")  // Escape single quotes for PowerShell
        .replace("`", "")    // Remove backtick (PS escape char)
        .replace(";", "")    // Remove command separator
        .replace("&", "");   // Remove background operator

    // Verify it ends in .lnk or .exe
    if !safe_path.ends_with(".lnk") && 
       !safe_path.ends_with(".exe") {
        return Err("Invalid shortcut path".to_string());
    }

    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            &format!("(New-Object -COM WScript.Shell).CreateShortcut('{}').TargetPath", safe_path)
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| e.to_string())?;
        
    let target = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if target.is_empty() {
        Err("Could not resolve shortcut".to_string())
    } else {
        Ok(target)
    }
}

#[tauri::command]
fn get_running_apps() -> Result<Vec<String>, String> {
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty Name"
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| e.to_string())?;

    // Lock-In must never appear in its own picker. The literal "lockin" that
    // used to be filtered here matched NEITHER build — the dev binary is
    // app.exe and the bundled product is Lock-In.exe (process name "lock-in").
    // Use the real stem from current_exe(), with the release name as a
    // fallback in case that lookup fails.
    let own_stem = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_lowercase()))
        .unwrap_or_default();

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut apps: Vec<String> = stdout
        .lines()
        .map(|line| line.trim().to_lowercase())
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
    Ok(apps)
}

#[tauri::command]
fn sync_permanent_exe(
    blocked_list: Vec<String>,
    from_remote: Option<bool>,
    app: tauri::AppHandle,
    app_state: State<AppState>,
) -> Result<String, String> {
    let remote = from_remote.unwrap_or(false);
    match app_state.profile.lock() {
        Ok(mut profile) => {
            // Post-wipe: refuse to refill or stage until a deliberate local
            // session start lifts the latch, so a reconnect cannot undo a clear.
            if profile.disarm_latch {
                println!("[Permanent] disarm latch ACTIVE — ignoring permanent sync");
                return Ok("Permanent sync skipped — disarm latch active".to_string());
            }

            let sanitized: HashSet<String> = blocked_list
                .iter()
                .filter_map(|s| sanitize_block_entry(s))
                .collect();

            if remote {
                // F4: a remote write may keep/remove already-approved entries,
                // but a NEW permanent block cannot start killing until it is
                // approved on THIS machine. New names are staged, not enforced.
                let enforced: HashSet<String> =
                    sanitized.intersection(&profile.permanent_exe).cloned().collect();
                let pending: HashSet<String> =
                    sanitized.difference(&profile.permanent_exe).cloned().collect();
                profile.permanent_exe = enforced;
                profile.permanent_pending = pending.clone();
                println!(
                    "[Permanent] remote sync — {} enforced, {} pending approval",
                    profile.permanent_exe.len(),
                    pending.len()
                );
                persist_profile(&profile, &app_state.state_path);
                if !pending.is_empty() {
                    emit_permanent_pending(&app, &pending);
                }
                Ok(format!("Permanent sync — {} pending approval", pending.len()))
            } else {
                // Local/trusted path (not currently used by the web listener,
                // reserved for an explicit on-device write).
                profile.permanent_exe = sanitized.clone();
                profile.permanent_pending.clear();
                println!("[Permanent] local sync — {} enforced", sanitized.len());
                persist_profile(&profile, &app_state.state_path);
                Ok("Permanent exe updated".to_string())
            }
        }
        Err(e) => Err(format!("Lock failed: {}", e)),
    }
}

// ─── IPC Command: is_dev_mode ────────────────────────────────────────────────
// True only when a file named DEV_MODE exists in the app data directory
// (%APPDATA%\com.lockin.app\DEV_MODE). Unlocks test-only UI such as the
// 2-minute "Micro" session. Deliberately a file, not a setting: nothing in the
// app can create it, so a normal install can never show those controls.
#[tauri::command]
fn is_dev_mode(app: tauri::AppHandle) -> bool {
    match app.path().app_data_dir() {
        Ok(dir) => dir.join("DEV_MODE").is_file(),
        Err(_) => false,
    }
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
    local_date: String,
) -> Result<BailoutResult, String> {
    let mut profile = app_state
        .profile
        .lock()
        .map_err(|e| format!("profile lock poisoned: {}", e))?;

    let now = now_millis();

    // A fuse already burning is reported, never restarted: restarting it would
    // be a way to extend the session, which is the opposite of the point.
    if let Some(deadline) = profile.bailout_deadline {
        if deadline > now {
            return Ok(BailoutResult {
                armed: false,
                deadline: Some(deadline),
                refused: Some("already-burning".to_string()),
                remaining_ms: Some(deadline - now),
            });
        }
    }

    if !profile.focus_active {
        return Ok(BailoutResult {
            armed: false,
            deadline: None,
            refused: Some("no-session".to_string()),
            remaining_ms: None,
        });
    }

    if profile.bailout_used_date.as_deref() == Some(local_date.as_str()) {
        return Ok(BailoutResult {
            armed: false,
            deadline: None,
            refused: Some("used-today".to_string()),
            remaining_ms: None,
        });
    }

    let fuse = if is_dev_mode(app.clone()) { BAILOUT_FUSE_DEV_MS } else { BAILOUT_FUSE_MS };
    let deadline = now + fuse;
    profile.bailout_deadline = Some(deadline);
    profile.bailout_used_date = Some(local_date);
    persist_profile(&profile, &app_state.state_path);
    println!("[Enforcer] bail-out armed — fuse {} ms, deadline {}", fuse, deadline);

    Ok(BailoutResult {
        armed: true,
        deadline: Some(deadline),
        refused: None,
        remaining_ms: Some(fuse),
    })
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
    "bailout-recorded-late",
    "quit-refused",
    "autostart-set",
    "autostart-error",
    "start-apps-only",
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
    /// the operator commits, and DEV_MODE shortens it, so it cannot be a
    /// constant on the webview side.
    bailout_fuse_ms: u64,
    /// See LockProfile::unrecorded_bailout. The webview writes the entry, then
    /// calls ack_bailout_recorded.
    unrecorded_bailout: Option<u64>,
    close_to_tray: bool,
    session_asleep_ms: u64,
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
            bailout_fuse_ms: if is_dev_mode(app.clone()) { BAILOUT_FUSE_DEV_MS } else { BAILOUT_FUSE_MS },
            unrecorded_bailout: profile.unrecorded_bailout,
            close_to_tray: profile.close_to_tray,
            session_asleep_ms: profile.session_asleep_ms,
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

// ─── IPC Command: session_asleep_ms ──────────────────────────────────────────
// Asked once as a session ends, so its minutes leave out the time asleep.
#[tauri::command]
fn session_asleep_ms(app_state: State<AppState>) -> Result<u64, String> {
    let mut profile = app_state
        .profile
        .lock()
        .map_err(|e| format!("Mutex lock failed: {}", e))?;
    if profile.note_clock(now_millis()) {
        persist_profile(&profile, &app_state.state_path);
    }
    Ok(profile.session_asleep_ms)
}

// ─── IPC Command: ack_bailout_recorded ───────────────────────────────────────
// Firebase acknowledged the bailed-out history entry, so nothing is owed.
#[tauri::command]
fn ack_bailout_recorded(app_state: State<AppState>) -> Result<(), String> {
    let mut profile = app_state
        .profile
        .lock()
        .map_err(|e| format!("Mutex lock failed: {}", e))?;
    if profile.unrecorded_bailout.take().is_some() {
        persist_profile(&profile, &app_state.state_path);
    }
    Ok(())
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
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let (cleared_session, cleared_permanent) = wipe_all_blocks(&mut profile);
            persist_profile(&profile, &app_state.state_path);
            emit_stood_down(&app, "clear-all-blocks", 0);
            println!("🧹 CLEAR ALL BLOCKS: session + permanent wiped (latch armed)");
            Ok(format!(
                "Cleared {} session target(s) and {} permanent block(s)",
                cleared_session, cleared_permanent
            ))
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

// ─── IPC Command: confirm_pending_permanent ──────────────────────────────────
// F4: promote locally-approved pending permanent blocks into the enforced set.
#[tauri::command]
fn confirm_pending_permanent(app_state: State<AppState>) -> Result<String, String> {
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let promoted: Vec<String> = profile.permanent_pending.drain().collect();
            for name in &promoted {
                profile.permanent_exe.insert(name.clone());
            }
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
fn reject_pending_permanent(app_state: State<AppState>) -> Result<String, String> {
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let n = profile.permanent_pending.len();
            profile.permanent_pending.clear();
            persist_profile(&profile, &app_state.state_path);
            println!("[Permanent] rejected {} pending block(s)", n);
            Ok(format!("Rejected {} pending permanent block(s)", n))
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

// ─── IPC Command: confirm_pending_exe ────────────────────────────────────────
// G1: promote locally-approved session apps into the approved set. If a session
// is live, arm them immediately so approval takes effect without a restart.
#[tauri::command]
fn confirm_pending_exe(app_state: State<AppState>) -> Result<String, String> {
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let promoted: Vec<String> = profile.exe_pending.drain().collect();
            for name in &promoted {
                profile.exe_approved.insert(name.clone());
            }
            if profile.focus_active {
                profile.exe_blacklist = profile.exe_approved.clone();
            }
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
fn reject_pending_exe(app_state: State<AppState>) -> Result<String, String> {
    match app_state.profile.lock() {
        Ok(mut profile) => {
            let n = profile.exe_pending.len();
            profile.exe_pending.clear();
            persist_profile(&profile, &app_state.state_path);
            println!("[Blocklist] rejected {} pending app(s)", n);
            Ok(format!("Rejected {} pending session app(s)", n))
        }
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
}

/// Open the extension's store page in the default browser. The URL is fixed
/// here, so this can't be used to open anything else.
#[tauri::command]
fn open_web_guard_store() -> Result<(), String> {
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", WEB_GUARD_STORE_URL])
        .creation_flags(0x08000000)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
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
        web_blacklist: HashSet::new(),
        permanent_exe: HashSet::new(),
        permanent_pending: HashSet::new(),
        focus_active: false,
        disarm_latch: false,
        session_end_time: None,
        bailout_deadline: None,
        bailout_used_date: None,
        unrecorded_bailout: None,
        close_to_tray: true,
        session_asleep_ms: 0,
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
        })
        // Every one is also listed in app_commands.in, and only a window whose
        // capability grants it can call it: "main" alone (see build.rs).
        .invoke_handler(tauri::generate_handler![sync_lock_state, update_enforcement, check_sniper, resolve_shortcut, get_running_apps, sync_blocklist, sync_permanent_exe, toggle_autostart, get_autostart_state, get_enforcer_state, clear_disarm_latch, classify_block_entry, clear_all_blocks, confirm_pending_permanent, reject_pending_permanent, confirm_pending_exe, reject_pending_exe, append_ui_event, is_dev_mode, arm_bailout, ack_bailout_recorded, set_close_to_tray, open_web_guard_store, session_asleep_ms, read_snapshot, write_snapshot, clear_snapshot, is_store_build])
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

            app.manage(AppState {
                profile: Arc::clone(&profile_for_setup),
                state_path: state_path.clone(),
                persist_error,
            });

            // ── Tray ───────────────────────────────────────────────────────
            // Driven from Rust only, so no capability is needed for it.
            let open_item = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &quit_item])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Lock-In")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "quit" => tray_quit(app),
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
            // a time rather than as a taskkill /T tree. The only remaining
            // taskkill call is the dormant Task Manager kill gated on is_locked.
            thread::spawn(move || {
                println!("[Enforcer] Background thread STARTED");
                // One long-lived process table, refreshed in place only on ticks
                // that actually have something to kill (S3).
                let mut sys = System::new();
                loop {
                    println!("[Enforcer] Tick...");
                    thread::sleep(std::time::Duration::from_secs(2));

                    // Session expiry — a session that survived a restart has no
                    // JS timer left to end it, so the enforcer ends it itself.
                    if let Ok(mut profile) = profile_for_sniper.lock() {
                        // Before expiry, or waking past the deadline would end
                        // the session with its sleep uncounted.
                        if profile.note_clock(now_millis()) {
                            println!("[Enforcer] slept during the session — {} ms so far", profile.session_asleep_ms);
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
                                    if bailing {
                                        stand_down_voided(&mut profile, end);
                                    } else {
                                        profile.focus_active = false;
                                        profile.session_end_time = None;
                                        profile.bailout_deadline = None;
                                    }
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

                    // Read state — drop lock immediately after clone
                    let (is_locked, lock_mode, exe_list, focus_active, permanent_exe_list) =
                        match profile_for_sniper.lock() {
                            Ok(profile) => (
                                profile.is_locked,
                                profile.lock_mode.clone(),
                                profile.exe_blacklist.clone(),
                                profile.focus_active,
                                profile.permanent_exe.clone(),
                            ),
                            Err(_) => continue,
                        };

                    println!("[Enforcer] Loop tick — focus_active: {}, is_locked: {}, exe_blacklist: {:?}", 
                             focus_active, is_locked, exe_list);

                    let enforcer_active = is_locked || focus_active;

                    // Protected-process list, rebuilt per tick so the kill pass
                    // below always carries the current binary name.
                    let protected = protected_process_names();

                    // NOTE: is_locked is currently UNREACHABLE — permanently false.
                    // sync_lock_state is its only writer, and its only caller
                    // (syncWithRustEngine in useOmniSync.ts) passes the hardcoded
                    // literal `isLocked: false`. Nothing in the app sets it true.
                    // This branch, the lock_mode soft/hard split below, and the
                    // Task Manager kill are all dormant. Do not assume they run.
                    if is_locked {
                        let output = std::process::Command::new("taskkill")
                            .args(["/F", "/T", "/IM", "taskmgr.exe"])
                            .creation_flags(0x08000000)
                            .output();
                        if let Ok(out) = output {
                            if out.status.success() {
                                println!("[Sniper] 💀 Terminated: Task Manager");
                                let now = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs();
                                let _ = handle.emit("process-killed", KillPayload {
                                    name: "Task Manager".to_string(),
                                    timestamp: now,
                                });
                            }
                        }
                    }

                    // ── Kill pass ──────────────────────────────────────────
                    // Permanent blocks always apply; session targets only while
                    // the enforcer is armed. Both are re-validated here as well
                    // as at the IPC boundary, because a state file written by an
                    // older build could hold terms that predate the guards.
                    let mut terms: Vec<String> = Vec::new();
                    for blocked in &permanent_exe_list {
                        if let Some(t) = sanitize_block_entry(blocked) {
                            terms.push(t);
                        }
                    }
                    if enforcer_active {
                        for blocked in &exe_list {
                            if let Some(t) = sanitize_block_entry(blocked) {
                                terms.push(t);
                            }
                        }
                    }
                    terms.sort();
                    terms.dedup();

                    if !terms.is_empty() {
                        // One cheap refresh per tick, not one process spawn per
                        // term. ProcessRefreshKind::new() collects names and pids
                        // only — no CPU, memory, disk or user lookups.
                        sys.refresh_processes_specifics(ProcessRefreshKind::new());
                        for term in &terms {
                            let killed = kill_processes_matching(&sys, term, &protected);
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
            if silent {
                println!("[Boot] silent launch — staying in the tray");
            }
            if let (false, Some(boot_window)) = (silent, app.get_webview_window("main")) {
                thread::spawn(move || {
                    thread::sleep(std::time::Duration::from_secs(3));
                    let _ = boot_window.show();
                    let _ = boot_window.set_focus();
                    println!("[Boot] Window shown after 3 s network delay");
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
    use super::{arm_refusal, asleep_in_gap, close_hides, enforcement_decision, is_silent_launch, iso8601_utc, stand_down_voided, wipe_all_blocks, EnforcementDecision, LockProfile};

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
        let src = include_str!("lib.rs");
        let open = "generate_handler![";
        let start = src.find(open).unwrap() + open.len();
        let end = start + src[start..].find(']').unwrap();
        let mut handler: Vec<&str> = src[start..end].split(',').map(str::trim).collect();
        let mut listed = APP_COMMANDS.to_vec();
        handler.sort();
        listed.sort();
        assert_eq!(handler, listed);
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
                assert!(granted.iter().any(|p| p == &permission.as_str()), "{} missing", permission);
            }
        }
    }

    const MIN: u64 = 60_000;

    #[test]
    fn a_normal_tick_is_not_sleep() {
        assert_eq!(asleep_in_gap(1_000, 3_000, Some(100 * MIN)), 0);
        assert_eq!(asleep_in_gap(1_000, 1_000 + 29_999, Some(100 * MIN)), 0);
    }

    #[test]
    fn a_long_gap_counts_up_to_the_sessions_end() {
        // Slept 10 min inside the session.
        assert_eq!(asleep_in_gap(5 * MIN, 15 * MIN, Some(25 * MIN)), 10 * MIN);
        // Slept from minute 10 for two hours: only the last 15 were session time.
        assert_eq!(asleep_in_gap(10 * MIN, 130 * MIN, Some(25 * MIN)), 15 * MIN);
    }

    #[test]
    fn a_backward_clock_is_not_sleep() {
        assert_eq!(asleep_in_gap(10 * MIN, 5 * MIN, Some(25 * MIN)), 0);
    }

    #[test]
    fn sleep_is_only_counted_during_a_session() {
        let mut p: LockProfile = serde_json::from_str("{}").unwrap();
        p.note_clock(MIN);
        assert!(!p.note_clock(60 * MIN));
        assert_eq!(p.session_asleep_ms, 0);

        p.focus_active = true;
        p.session_end_time = Some(200 * MIN);
        assert!(!p.note_clock(60 * MIN + 2_000));
        assert!(p.note_clock(70 * MIN + 2_000));
        assert_eq!(p.session_asleep_ms, 10 * MIN);
        // Asked again straight after, the same gap isn't counted twice.
        assert!(!p.note_clock(70 * MIN + 2_100));
        assert_eq!(p.session_asleep_ms, 10 * MIN);
    }

    #[test]
    fn a_running_session_always_hides_on_close() {
        assert!(close_hides(true, false));
        assert!(close_hides(true, true));
        assert!(close_hides(false, true));
        assert!(!close_hides(false, false));
    }

    #[test]
    fn keep_running_defaults_on_for_old_state_files() {
        let p: LockProfile = serde_json::from_str("{}").unwrap();
        assert!(p.close_to_tray);
    }

    #[test]
    fn silent_launch_is_only_the_exact_flag() {
        assert!(is_silent_launch(&["app.exe", "--silently"]));
        assert!(!is_silent_launch(&["app.exe"]));
        assert!(!is_silent_launch(&["app.exe", "--silent"]));
    }

    #[test]
    fn a_voided_stand_down_leaves_the_entry_owed() {
        let mut p = profile_with_fuse();
        stand_down_voided(&mut p, 1_000);
        assert!(!p.focus_active);
        assert_eq!(p.session_end_time, None);
        assert_eq!(p.bailout_deadline, None);
        assert_eq!(p.unrecorded_bailout, Some(1_000));
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
