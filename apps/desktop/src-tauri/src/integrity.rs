//! Session integrity: the rules that decide what may change while a session is
//! armed. Pure functions over LockProfile, so every rule is unit-tested without
//! a webview, a window or a process table. The Tauri commands in lib.rs are thin
//! wrappers that lock the profile, call one of these, persist and emit.
//!
//! The principle (1.3.1, B1): once a session is armed, nothing the webview or
//! Firebase says can make it end sooner or block less. Additions apply at once;
//! removals, stops, clears and re-arms wait for the session's own end or its
//! bail-out fuse. The webview is treated as untrusted for anything that weakens
//! a running session.

use super::{sanitize_block_entry, BailoutResult, LockProfile, SessionRecord, BAILOUT_FUSE_MS};
use std::collections::HashSet;

/// The longest session the app offers is 90 minutes; this leaves headroom.
pub(crate) const MAX_SESSION_MINUTES: u64 = 240;
const MIN_MS: u64 = 60_000;
/// The UI countdown reads its own clock and rounds, so it can reach zero a
/// moment before Rust's deadline. A stop this close to the end is the end.
pub(crate) const END_GRACE_MS: u64 = 2_000;
/// How far ahead of this PC's clock a stored time may be before it is treated
/// as forged.
const FUTURE_SLACK_MS: u64 = 5 * MIN_MS;
const MAX_OBJECTIVE_CHARS: usize = 500;

/// What a refused stop, clear or re-arm says. The UI shows it as is.
pub(crate) const SESSION_RUNNING: &str = "A session is running. Use Bail out to end it early.";
pub(crate) const OTHER_ACCOUNT: &str =
    "Ignored a block list from a different account than the one running this session.";

fn sanitized(list: &[String]) -> HashSet<String> {
    list.iter().filter_map(|s| sanitize_block_entry(s)).collect()
}

/// While armed, only the account that started the session may change its lists.
/// A session from before uids were stored (session_uid None) accepts any.
fn account_check(p: &LockProfile, uid: Option<&str>) -> Result<(), String> {
    if !p.focus_active {
        return Ok(());
    }
    match (p.session_uid.as_deref(), uid) {
        (None, _) => Ok(()),
        (Some(a), Some(b)) if a == b => Ok(()),
        _ => Err(OTHER_ACCOUNT.to_string()),
    }
}

/// sync_blocklist's rule. `blocked` is every entry in blockedApps, `approved` the
/// subset the webview vouches for as this device's own. Returns the names newly
/// staged for local approval.
///
/// While a session is armed its kill list only grows: an app removed in the
/// Blocks tab leaves exe_approved now (so the next session won't block it) but
/// stays in exe_blacklist until this session ends.
pub(crate) fn apply_session_sync(
    p: &mut LockProfile,
    blocked: &[String],
    approved: &[String],
    remote: bool,
    uid: Option<&str>,
) -> Result<HashSet<String>, String> {
    account_check(p, uid)?;
    let all = sanitized(blocked);
    let mine = sanitized(approved);
    let pending = if remote {
        // Approved = anything already approved OR vouched as this-device origin,
        // that still exists in blockedApps. A NEW entry with a different or
        // absent origin is STAGED for local approval (G1), never armed.
        let approved_kept: HashSet<String> = p
            .exe_approved
            .union(&mine).filter(|&n| all.contains(n)).cloned()
            .collect();
        let pending: HashSet<String> = all.difference(&approved_kept).cloned().collect();
        p.exe_approved = approved_kept;
        p.exe_pending = pending.clone();
        pending
    } else {
        p.exe_approved = all;
        p.exe_pending.clear();
        HashSet::new()
    };
    if p.focus_active {
        let grown: HashSet<String> = p.exe_blacklist.union(&p.exe_approved).cloned().collect();
        p.exe_blacklist = grown;
    }
    Ok(pending)
}

/// sync_permanent_exe's rule. Returns the names newly staged for local approval.
/// A permanent block removed while a session is armed keeps being killed until
/// the session ends (session_held_permanent).
pub(crate) fn apply_permanent_sync(
    p: &mut LockProfile,
    blocked: &[String],
    remote: bool,
    uid: Option<&str>,
) -> Result<HashSet<String>, String> {
    account_check(p, uid)?;
    let names = sanitized(blocked);
    let before = p.permanent_exe.clone();
    let pending = if remote {
        // F4: a remote write may keep/remove already-approved entries, but a NEW
        // permanent block cannot start killing until it is approved here.
        let enforced: HashSet<String> = names.intersection(&p.permanent_exe).cloned().collect();
        let pending: HashSet<String> = names.difference(&p.permanent_exe).cloned().collect();
        p.permanent_exe = enforced;
        p.permanent_pending = pending.clone();
        pending
    } else {
        p.permanent_exe = names;
        p.permanent_pending.clear();
        HashSet::new()
    };
    if p.focus_active {
        for removed in before.difference(&p.permanent_exe) {
            p.session_held_permanent.insert(removed.clone());
        }
    }
    Ok(pending)
}

/// Every term the enforcer kills this tick: permanent blocks always; session
/// targets and permanent blocks removed mid-session while armed. Re-validated
/// here as well as at the IPC boundary, because a state file written by an
/// older build could hold terms that predate the guards.
pub(crate) fn kill_terms(p: &LockProfile) -> Vec<String> {
    let mut terms: Vec<String> = p
        .permanent_exe
        .iter()
        .filter_map(|b| sanitize_block_entry(b))
        .collect();
    if p.is_locked || p.focus_active {
        terms.extend(p.exe_blacklist.iter().filter_map(|b| sanitize_block_entry(b)));
    }
    if p.focus_active {
        terms.extend(p.session_held_permanent.iter().filter_map(|b| sanitize_block_entry(b)));
    }
    terms.sort();
    terms.dedup();
    terms
}

/// Blocks removed mid-session that the enforcer still applies until it ends,
/// for the Blocks tab's "Removes after this session". Sorted.
pub(crate) fn held_removals(p: &LockProfile) -> Vec<String> {
    if !p.focus_active {
        return Vec::new();
    }
    let mut held: Vec<String> = p
        .exe_blacklist
        .difference(&p.exe_approved)
        .chain(p.session_held_permanent.difference(&p.permanent_exe))
        .cloned()
        .collect();
    held.sort();
    held.dedup();
    held
}

/// May the local webview stand the running session down now? Only once it has
/// reached its deadline (within END_GRACE_MS) or its fuse has burned down. The
/// way out before that is Bail out, whose fuse Rust ends on its own.
pub(crate) fn local_stop(p: &LockProfile, now: u64) -> Result<(), String> {
    if !p.focus_active {
        return Ok(());
    }
    let at_deadline = p.session_end_time.map_or(true, |end| now + END_GRACE_MS >= end);
    let fuse_done = p.bailout_deadline.is_some_and(|d| now >= d);
    if at_deadline || fuse_done {
        Ok(())
    } else {
        Err(SESSION_RUNNING.to_string())
    }
}

/// When a stop allowed by local_stop ends the session: at its deadline if the
/// countdown got there a moment early, so a finished session reads completed.
pub(crate) fn stop_time(p: &LockProfile, now: u64) -> u64 {
    match p.session_end_time {
        Some(end) if now < end && now + END_GRACE_MS >= end => end,
        _ => now,
    }
}

/// May the local webview arm a session now? Not over a running one: re-arming
/// would replace its deadline.
pub(crate) fn local_arm(p: &LockProfile, now: u64) -> Result<(), String> {
    if !p.focus_active {
        return Ok(());
    }
    if p.bailout_deadline.is_some_and(|d| d > now) {
        return Err("Refused to arm: a bail-out is burning".to_string());
    }
    if p.session_end_time.map_or(true, |end| end > now) {
        return Err(SESSION_RUNNING.to_string());
    }
    Ok(())
}

/// The deadline a session armed now gets: the webview's end time, never later
/// than now plus the planned duration, which must be given and be at most
/// MAX_SESSION_MINUTES.
pub(crate) fn session_end(now: u64, end_time: Option<u64>, planned_minutes: Option<u64>) -> Result<u64, String> {
    let planned = match planned_minutes {
        Some(m) if (1..=MAX_SESSION_MINUTES).contains(&m) => m,
        Some(m) => return Err(format!("Refused to arm: a {}-minute session is not allowed", m)),
        None => return Err("Refused to arm: the session has no planned duration".to_string()),
    };
    if let Some(reason) = super::arm_refusal(end_time, now) {
        return Err(format!("Refused to arm: {}", reason));
    }
    Ok(end_time.unwrap_or(now).min(now + planned * MIN_MS))
}

/// clear_all_blocks' rule. Returns (session targets cleared, permanent cleared).
/// Refused while a session runs. If it ends one that has just reached its end
/// (before the enforcer's tick), that session is recorded aborted, never
/// completed.
pub(crate) fn clear_all(p: &mut LockProfile, now: u64) -> Result<(usize, usize), String> {
    local_stop(p, now)?;
    if p.focus_active {
        p.note_clock(now);
        p.end_session_as(stop_time(p, now), true);
    }
    Ok(super::wipe_all_blocks(p))
}

/// Today's local calendar date, "YYYY-MM-DD", from this PC's clock. The
/// one-bail-out-a-day rule uses this, never a date the webview sends.
pub(crate) fn local_today() -> String {
    // SAFETY: GetLocalTime only writes the SYSTEMTIME it returns.
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay)
}

/// Drop every WEBVIEW2_* variable from this process before the webview starts.
/// WebView2 reads them at creation: extra browser arguments (a remote debugging
/// port among them), another runtime or another profile folder would hand the
/// main window's IPC to whoever set them. Called first thing in main().
pub fn scrub_webview2_env() {
    let names: Vec<std::ffi::OsString> = std::env::vars_os()
        .map(|(k, _)| k)
        .filter(|k| k.to_string_lossy().to_ascii_uppercase().starts_with("WEBVIEW2_"))
        .collect();
    for name in names {
        std::env::remove_var(name);
    }
}

/// arm_bailout's rule, for a given local calendar day and fuse length.
pub(crate) fn arm_bailout_at(p: &mut LockProfile, now: u64, today: &str, fuse_ms: u64) -> BailoutResult {
    // A fuse already burning is reported, never restarted: restarting it would
    // be a way to extend the session, which is the opposite of the point.
    if let Some(deadline) = p.bailout_deadline {
        if deadline > now {
            return BailoutResult {
                armed: false,
                deadline: Some(deadline),
                refused: Some("already-burning".to_string()),
                remaining_ms: Some(deadline - now),
            };
        }
    }
    if !p.focus_active {
        return BailoutResult { armed: false, deadline: None, refused: Some("no-session".to_string()), remaining_ms: None };
    }
    if p.bailout_used_date.as_deref() == Some(today) {
        return BailoutResult { armed: false, deadline: None, refused: Some("used-today".to_string()), remaining_ms: None };
    }
    let deadline = now + fuse_ms;
    p.bailout_deadline = Some(deadline);
    p.bailout_used_date = Some(today.to_string());
    BailoutResult { armed: true, deadline: Some(deadline), refused: None, remaining_ms: Some(fuse_ms) }
}

/// A session this PC started, as Firebase still has it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerSession {
    pub started_at: u64,
    pub end_time: u64,
    pub objective: Option<String>,
    pub uid: Option<String>,
}

/// Re-arm a session that is still live on the server but not here: the state
/// file was lost, corrupted or edited while the app was closed. Never re-arms a
/// session this PC already ended (bailed out, finished, or a stop that never
/// reached Firebase), an expired one, or over a running one (a no-op).
pub(crate) fn rearm_from_server(p: &mut LockProfile, s: &ServerSession, now: u64) -> Result<(), String> {
    if p.focus_active {
        return Ok(());
    }
    if s.started_at > now + FUTURE_SLACK_MS {
        return Err("Not re-armed: the server session starts in the future".to_string());
    }
    if p.last_session_ended_at.is_some_and(|ended| ended >= s.started_at) {
        return Err("Not re-armed: this session already ended on this PC".to_string());
    }
    let end = s.end_time.min(s.started_at + MAX_SESSION_MINUTES * MIN_MS);
    if end <= now {
        return Err("Not re-armed: the server session has ended".to_string());
    }
    p.disarm_latch = false;
    p.exe_blacklist = p.exe_approved.clone();
    p.focus_active = true;
    p.start_session(now, Some(end), s.objective.clone(), s.uid.clone(), false, false);
    p.session_started_at = Some(s.started_at);
    Ok(())
}

fn record_ok(r: &SessionRecord, now: u64) -> bool {
    let status_ok = matches!(r.status.as_str(), "completed" | "aborted" | "bailed-out");
    let uid_ok = r
        .uid
        .as_deref()
        .map_or(true, |u| !u.is_empty() && u.len() <= 128 && u.chars().all(|c| c.is_ascii_alphanumeric()));
    status_ok
        && uid_ok
        && r.minutes <= MAX_SESSION_MINUTES
        && (r.status != "bailed-out" || r.minutes == 0)
        && r.ended_at <= now + FUTURE_SLACK_MS
}

/// Is the armed session in a restored file one this app could have written?
fn session_ok(p: &LockProfile, now: u64) -> bool {
    let (Some(start), Some(end)) = (p.session_started_at, p.session_end_time) else {
        return false;
    };
    end > start
        && end - start <= MAX_SESSION_MINUTES * MIN_MS
        && start <= now + FUTURE_SLACK_MS
}

/// How far short of the planned duration a session that ran out while the app
/// was closed may be and still count as completed (rule b, B1 review).
pub(crate) const COMPLETION_GRACE_MS: u64 = 60_000;

/// The file claims more enforced time than the session lasted.
fn awake_over_claimed(p: &LockProfile) -> bool {
    match (p.session_started_at, p.session_end_time) {
        (Some(start), Some(end)) => p.session_awake_ms > end.saturating_sub(start),
        _ => false,
    }
}

/// Settle a profile just read from enforcer_state.json. Every field is checked;
/// none is trusted. Returns the stand-down reasons to emit, in order.
///
/// A session that ran out while the app was closed is "completed" only if the
/// app was awake and enforcing it for at least its planned duration (end -
/// start) less COMPLETION_GRACE_MS; otherwise "aborted" with the minutes it
/// earned. Awake time is capped at end - start, and a file claiming more than
/// that is never completed. A file that fails the structural checks, or claims
/// more awake time than a still-running session could have, stands the session
/// down with nothing credited; if the session is in fact still running, the
/// webview re-arms it from Firebase on sign-in (rearm_from_server).
pub(crate) fn settle_restored(p: &mut LockProfile, now: u64) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    p.pending_records.retain(|r| record_ok(r, now));
    for r in p.pending_records.iter_mut() {
        if r.objective.chars().count() > MAX_OBJECTIVE_CHARS {
            r.objective = r.objective.chars().take(MAX_OBJECTIVE_CHARS).collect();
        }
    }

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
        p.session_held_permanent.clear();
        p.session_end_time = None;
        p.bailout_deadline = None;
    }

    let live = p.session_end_time.is_some_and(|end| now < end);
    let over_claimed = p.focus_active && awake_over_claimed(p);
    if p.focus_active && (!session_ok(p, now) || (over_claimed && live)) {
        p.session_awake_ms = 0;
        p.bailout_deadline = None;
        p.end_session_as(now, true);
        reasons.push("restored-invalid");
    }

    if p.focus_active {
        // A fuse can be no further off than one full fuse from now.
        if let Some(fuse) = p.bailout_deadline {
            if fuse > now + BAILOUT_FUSE_MS {
                p.bailout_deadline = Some(now + BAILOUT_FUSE_MS);
            }
        }
        // A fuse that burned down while the app was closed still fires: the
        // whole point is that quitting cannot outrun it.
        if let Some(fuse) = p.bailout_deadline {
            if now >= fuse {
                p.end_session_as(fuse, true);
                reasons.push("bailout-expired");
            }
        }
    }
    if p.focus_active {
        if let Some(end) = p.session_end_time {
            if now >= end {
                let planned = end.saturating_sub(p.session_started_at.unwrap_or(end));
                if over_claimed {
                    p.session_awake_ms = planned;
                }
                let completed = !over_claimed && p.session_awake_ms + COMPLETION_GRACE_MS >= planned;
                p.end_session_as(end, !completed);
                reasons.push("restored-expired");
            }
        }
    }
    // A fuse with no session behind it must not void the next session.
    if !p.focus_active {
        p.bailout_deadline = None;
        p.session_held_permanent.clear();
    }
    reasons
}

#[cfg(test)]
#[path = "integrity_tests.rs"]
mod tests;
