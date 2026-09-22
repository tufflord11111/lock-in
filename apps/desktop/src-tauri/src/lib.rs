use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State, Emitter};
use tauri_plugin_autostart::ManagerExt;
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
}

// "soft" everywhere by default — "hard" seizes the screen (fullscreen,
// always-on-top, no decorations) and no user has opted into that.
fn default_lock_mode() -> String {
    "soft".to_string()
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
    state_path: PathBuf,
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
    profile.disarm_latch = true;
    (cleared_session, cleared_permanent)
}

/// Write the profile to disk. MUST be called while holding the profile lock so
/// the file can never disagree with memory.
///
/// Writes to a sibling .tmp then renames — a process killed mid-write leaves the
/// previous good file intact rather than a truncated one.
fn persist_profile(profile: &LockProfile, path: &PathBuf) {
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
        println!("[Persist] restored with disarm latch SET — forced disarmed, all blocks cleared");
    }

    // Expire a session whose deadline passed while the app was closed, so it
    // never arms even for the first 2 s tick.
    if p.focus_active {
        match p.session_end_time {
            Some(end) if now_millis() >= end => {
                // focus_active=false is what prevents arming; the list stays.
                p.focus_active = false;
                p.session_end_time = None;
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
                println!("[Persist] restored session has NO deadline — standing down");
                emit_stood_down(app, "restored-no-deadline", p.exe_blacklist.len());
            }
        }
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
    // A mirrored session from another device is NOT deliberate local action, so
    // it may neither lift the disarm latch nor arm through it.
    let remote = from_remote.unwrap_or(false);
    match app_state.profile.lock() {
        Ok(mut profile) => {
            if is_active {
                // Never arm a session that can't be running. With no deadline it
                // would never expire on its own; with a past one the loop could
                // run a kill pass before its next expiry check. The webview
                // filters these too — this is the backstop.
                if let Some(reason) = arm_refusal(end_time, now_millis()) {
                    println!("[Enforcer] REFUSED arm — {} (remote = {})", reason, remote);
                    return Err(format!("Refused to arm: {}", reason));
                }
                if remote && profile.disarm_latch {
                    println!("[Enforcer] disarm latch ACTIVE — refusing REMOTE session arm");
                    return Ok("Remote arm refused — disarm latch active".to_string());
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
    "reconcile-write",
    "name-repair",
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
}

#[tauri::command]
fn get_enforcer_state(app_state: State<AppState>) -> Result<EnforcerState, String> {
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
        }),
        Err(e) => Err(format!("Mutex lock failed: {}", e)),
    }
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

#[tauri::command]
fn get_autostart_state(app: tauri::AppHandle) -> Result<bool, String> {
    let manager = app.autolaunch();
    manager.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_autostart(
    enable: bool,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let manager = app.autolaunch();
    if enable {
        manager.enable().map_err(|e| e.to_string())?;
        println!("[AutoStart] Enabled via toggle");
        Ok("Autostart enabled".to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())?;
        println!("[AutoStart] Disabled via toggle");
        Ok("Autostart disabled".to_string())
    }
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
    }));

    let profile_for_sniper = Arc::clone(&profile);
    let profile_for_setup = Arc::clone(&profile);

    tauri::Builder::default()
        // Expose ALL commands so any JS call succeeds
        .invoke_handler(tauri::generate_handler![sync_lock_state, update_enforcement, check_sniper, resolve_shortcut, get_running_apps, sync_blocklist, sync_permanent_exe, toggle_autostart, get_autostart_state, get_enforcer_state, clear_disarm_latch, classify_block_entry, clear_all_blocks, confirm_pending_permanent, reject_pending_permanent, confirm_pending_exe, reject_pending_exe, append_ui_event])
        .setup(move |app| {
            let handle = app.handle().clone();

            // ── Restore persisted enforcer state ───────────────────────────
            // MUST complete before the sniper thread starts, otherwise the
            // first ticks would run against a blank profile.
            let state_path = match app.path().app_data_dir() {
                Ok(dir) => dir.join("enforcer_state.json"),
                Err(e) => {
                    println!("[Persist] app_data_dir unavailable ({}) — using cwd", e);
                    PathBuf::from("enforcer_state.json")
                }
            };
            println!("[Persist] state file: {:?}", state_path);
            restore_profile(&profile_for_setup, &state_path, &handle);

            app.manage(AppState {
                profile: Arc::clone(&profile_for_setup),
                state_path: state_path.clone(),
            });

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
                        if profile.focus_active {
                            if let Some(end) = profile.session_end_time {
                                if now_millis() >= end {
                                    // Stand down without touching exe_blacklist —
                                    // standing config, gated by enforcer_active.
                                    profile.focus_active = false;
                                    profile.session_end_time = None;
                                    persist_profile(&profile, &sniper_state_path);
                                    emit_stood_down(&handle, "deadline-expired", profile.exe_blacklist.len());
                                    println!(
                                        "⏱ [Enforcer] session deadline reached — auto stand-down, {} target(s) retained",
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
            if let Some(boot_window) = app.get_webview_window("main") {
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
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{arm_refusal, iso8601_utc};

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
