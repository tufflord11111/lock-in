//! B1 (1.3.1) session-integrity tests. Each one reproduces an audit finding
//! against the 1.3.0 behaviour; see docs/1.3.1 for the mapping.

use super::*;
use crate::SessionRecord;

const MIN: u64 = 60_000;
const T0: u64 = 1_800_000_000_000;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn set(v: &[&str]) -> HashSet<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn idle() -> LockProfile {
    serde_json::from_str("{}").unwrap()
}

/// A 25-minute session armed at T0 for uid1, blocking discord and steam, with
/// fortnite blocked permanently.
fn armed() -> LockProfile {
    let mut p = idle();
    p.exe_approved = set(&["discord", "steam"]);
    p.permanent_exe = set(&["fortnite"]);
    p.exe_blacklist = p.exe_approved.clone();
    p.focus_active = true;
    p.start_session(T0, Some(T0 + 25 * MIN), Some("Write".into()), Some("uid1".into()), false, false);
    p.session_started_at = Some(T0);
    p
}

// ── H1: the session's blocklists are frozen while it runs ───────────────────

#[test]
fn h1_an_app_removed_mid_session_is_still_killed_until_the_session_ends() {
    let mut p = armed();
    // The Blocks tab removed discord: blockedApps now holds only steam.
    apply_session_sync(&mut p, &s(&["steam"]), true, Some("uid1")).unwrap();
    assert!(kill_terms(&p).contains(&"discord".to_string()), "removal applied mid-session");
    assert_eq!(p.exe_approved, set(&["steam"]), "the removal is still recorded for after");
    assert_eq!(held_removals(&p), s(&["discord"]));
    // Same through the local path.
    let mut q = armed();
    apply_session_sync(&mut q, &s(&["steam"]), false, Some("uid1")).unwrap();
    assert!(kill_terms(&q).contains(&"discord".to_string()));
    // After the session the removal applies.
    p.end_session(T0 + 25 * MIN);
    assert!(!kill_terms(&p).contains(&"discord".to_string()));
    assert!(held_removals(&p).is_empty());
}

#[test]
fn h1_an_app_added_mid_session_is_killed_at_once() {
    let mut p = armed();
    note_added_here(&mut p, "roblox");
    apply_session_sync(&mut p, &s(&["discord", "steam", "roblox"]), true, Some("uid1")).unwrap();
    assert!(kill_terms(&p).contains(&"roblox".to_string()));
}

#[test]
fn h1_a_permanent_block_removed_mid_session_is_still_killed_until_the_session_ends() {
    let mut p = armed();
    apply_permanent_sync(&mut p, &[], true, Some("uid1")).unwrap();
    assert!(kill_terms(&p).contains(&"fortnite".to_string()), "permanent removal applied mid-session");
    assert!(p.permanent_exe.is_empty(), "the removal is still recorded for after");
    assert_eq!(held_removals(&p), s(&["fortnite"]));
    p.end_session(T0 + 25 * MIN);
    assert!(!kill_terms(&p).contains(&"fortnite".to_string()));
}

#[test]
fn h1_a_sync_from_another_account_is_refused_while_armed() {
    let mut p = armed();
    assert!(apply_session_sync(&mut p, &[], true, Some("uid2")).is_err());
    assert!(apply_session_sync(&mut p, &[], true, None).is_err());
    assert!(apply_permanent_sync(&mut p, &[], true, Some("uid2")).is_err());
    assert_eq!(p.exe_approved, set(&["discord", "steam"]), "nothing changed");
    assert_eq!(p.permanent_exe, set(&["fortnite"]));
    // With no session, the signed-in account's list is taken as before.
    let mut q = idle();
    assert!(apply_session_sync(&mut q, &s(&["steam"]), true, Some("uid2")).is_ok());
}

// ── H2: Rust enforces the commitment, not the webview ───────────────────────

#[test]
fn h2_a_local_stop_is_refused_while_the_session_runs() {
    let p = armed();
    assert!(local_stop(&p, T0 + 5 * MIN).is_err());
    // With a fuse burning the session still runs until the fuse ends it.
    let mut f = armed();
    f.bailout_deadline = Some(T0 + 10 * MIN);
    assert!(local_stop(&f, T0 + 6 * MIN).is_err());
    // At the deadline (the countdown reaching zero) it is allowed.
    assert!(local_stop(&p, T0 + 25 * MIN).is_ok());
    assert!(local_stop(&p, T0 + 25 * MIN - 1_000).is_ok(), "the UI countdown may land a second early");
    // No session: nothing to refuse.
    assert!(local_stop(&idle(), T0).is_ok());
}

#[test]
fn h2_re_arming_over_a_running_session_is_refused() {
    assert!(local_arm(&armed(), T0 + 5 * MIN).is_err());
    assert!(local_arm(&idle(), T0).is_ok());
}

#[test]
fn h2_clear_all_blocks_is_refused_while_the_session_runs() {
    let mut p = armed();
    assert!(clear_all(&mut p, T0 + 5 * MIN).is_err());
    assert!(p.focus_active);
    assert_eq!(p.permanent_exe, set(&["fortnite"]));
    assert!(!p.disarm_latch);
}

#[test]
fn h2_clear_all_blocks_outside_a_session_is_unchanged() {
    let mut p = idle();
    p.exe_approved = set(&["discord"]);
    p.permanent_exe = set(&["fortnite"]);
    assert_eq!(clear_all(&mut p, T0).unwrap(), (1, 1));
    assert!(p.exe_approved.is_empty() && p.permanent_exe.is_empty());
    assert!(p.disarm_latch);
    assert!(p.pending_records.is_empty());
}

#[test]
fn h2_clear_all_blocks_that_ends_a_session_records_it_aborted() {
    // At the deadline, before the enforcer's tick has ended it.
    let mut p = armed();
    p.session_awake_ms = 25 * MIN;
    clear_all(&mut p, T0 + 25 * MIN).unwrap();
    assert!(!p.focus_active);
    assert_eq!(p.pending_records.len(), 1);
    assert_eq!(p.pending_records[0].status, "aborted");
}

#[test]
fn h2_the_deadline_is_capped_to_the_planned_duration() {
    // A webview asking for ten hours on a 25-minute session gets 25 minutes.
    assert_eq!(session_end(T0, Some(T0 + 600 * MIN), Some(25)).unwrap(), T0 + 25 * MIN);
    // A shorter deadline than planned is kept.
    assert_eq!(session_end(T0, Some(T0 + 10 * MIN), Some(25)).unwrap(), T0 + 10 * MIN);
    // A plan is required, and bounded.
    assert!(session_end(T0, Some(T0 + 25 * MIN), None).is_err());
    assert!(session_end(T0, Some(T0 + 25 * MIN), Some(0)).is_err());
    assert!(session_end(T0, Some(T0 + 600 * MIN), Some(600)).is_err());
    // Past or missing deadlines are still refused.
    assert!(session_end(T0, Some(T0), Some(25)).is_err());
    assert!(session_end(T0, None, Some(25)).is_err());
}

#[test]
fn h2_the_bail_out_day_comes_from_this_pc_not_the_webview() {
    let today = local_today();
    assert_eq!(today.len(), 10, "YYYY-MM-DD, got {:?}", today);
    assert!(today
        .chars()
        .enumerate()
        .all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() }));
    // arm_bailout takes no date from the webview and asks local_today().
    let src = include_str!("lib.rs").replace("\r\n", "\n");
    let cmd = &src[src.find("fn arm_bailout(").unwrap()..];
    let cmd = &cmd[..cmd.find("\n}\n").unwrap()];
    assert!(!cmd.contains("local_date"), "arm_bailout still takes the webview's date");
    assert!(cmd.contains("integrity::local_day(profile.clock.true_now(now))"));
}

#[test]
fn h2_webview2_variables_are_removed_before_the_webview_starts() {
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--x");
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", "x");
    std::env::set_var("LOCKIN_B1_TEST_KEEP", "1");
    scrub_webview2_env();
    assert!(std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none());
    assert!(std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none());
    assert_eq!(std::env::var("LOCKIN_B1_TEST_KEEP").as_deref(), Ok("1"));
    // And main() does it first, before run() builds any webview.
    let main = include_str!("main.rs").replace("\r\n", "\n");
    let body = &main[main.find("fn main()").unwrap()..];
    let scrub = body.find("scrub_webview2_env()").expect("main() never scrubs WEBVIEW2_*");
    assert!(scrub < body.find("run()").unwrap());
}

// ── M7: a restored state file is checked, never trusted ─────────────────────

fn restored(p: &LockProfile) -> LockProfile {
    serde_json::from_str(&serde_json::to_string(p).unwrap()).unwrap()
}

// Rule (b), B1 review: a session that ran out while Lock-In was closed is
// "completed" only if Lock-In was awake and enforcing for at least the planned
// duration minus 60 s; otherwise "aborted" with the minutes it earned.

fn expired_while_closed(awake_ms: u64) -> SessionRecord {
    let mut p = armed();
    p.session_awake_ms = awake_ms;
    let mut r = restored(&p);
    assert_eq!(settle_restored(&mut r, T0 + 40 * MIN), vec!["restored-expired"]);
    assert!(!r.focus_active);
    assert_eq!(r.pending_records.len(), 1);
    r.pending_records[0].clone()
}

#[test]
fn m7_expired_while_closed_with_the_full_planned_time_is_completed() {
    let r = expired_while_closed(25 * MIN);
    assert_eq!((r.status.as_str(), r.minutes), ("completed", 25));
}

#[test]
fn m7_expired_while_closed_at_exactly_planned_minus_60_s_is_completed() {
    let r = expired_while_closed(25 * MIN - 60_000);
    assert_eq!((r.status.as_str(), r.minutes), ("completed", 24));
}

#[test]
fn m7_expired_while_closed_just_under_planned_minus_60_s_is_aborted_with_its_minutes() {
    let r = expired_while_closed(25 * MIN - 60_000 - 1);
    assert_eq!((r.status.as_str(), r.minutes), ("aborted", 24));
    let r = expired_while_closed(10 * MIN);
    assert_eq!((r.status.as_str(), r.minutes), ("aborted", 10));
}

#[test]
fn m7_expired_while_closed_claiming_more_than_the_session_is_capped_not_completed() {
    let r = expired_while_closed(600 * MIN);
    assert_eq!((r.status.as_str(), r.minutes), ("aborted", 25));
    let r = expired_while_closed(25 * MIN + 1);
    assert_eq!((r.status.as_str(), r.minutes), ("aborted", 25));
}

#[test]
fn m7_an_awake_time_longer_than_the_session_is_rejected() {
    let mut p = armed();
    p.session_awake_ms = 600 * MIN;
    let mut r = restored(&p);
    settle_restored(&mut r, T0 + 5 * MIN);
    assert!(!r.focus_active, "a forged file was restored armed");
    assert!(r.pending_records.iter().all(|x| x.minutes == 0), "forged minutes credited");
    assert!(r.pending_records.iter().all(|x| x.status != "completed"));
}

#[test]
fn m7_a_deadline_that_is_not_after_the_start_is_rejected() {
    let cases = [
        (Some(T0), T0),
        (Some(T0 + 10 * MIN), T0 + 5 * MIN),
        (None, T0 + 25 * MIN),
        (Some(T0), T0 + 600 * MIN),
        (Some(T0 + 60 * MIN), T0 + 80 * MIN),
    ];
    for (start, end) in cases {
        let mut p = armed();
        p.session_started_at = start;
        p.session_end_time = Some(end);
        let mut r = restored(&p);
        settle_restored(&mut r, T0 + MIN);
        assert!(!r.focus_active, "start {:?} end {} restored armed", start, end);
        assert!(r.pending_records.iter().all(|x| x.status != "completed" && x.minutes == 0));
    }
}

#[test]
fn m7_a_valid_live_session_is_restored_armed() {
    let mut p = armed();
    p.session_awake_ms = 5 * MIN;
    let mut r = restored(&p);
    assert!(settle_restored(&mut r, T0 + 6 * MIN).is_empty());
    assert!(r.focus_active);
    assert_eq!(r.session_end_time, Some(T0 + 25 * MIN));
}

#[test]
fn m7_malformed_history_records_are_dropped() {
    let rec = |status: &str, minutes: u64, ended_at: u64| SessionRecord {
        ended_at,
        minutes,
        status: status.into(),
        objective: "x".into(),
        uid: Some("uid1".into()),
    };
    let mut p = idle();
    p.pending_records = vec![
        rec("completed", 25, T0),
        rec("gold", 25, T0),
        rec("completed", 100_000, T0),
        rec("bailed-out", 20, T0),
        rec("aborted", 5, T0 + 900 * MIN),
    ];
    let mut r = restored(&p);
    settle_restored(&mut r, T0 + MIN);
    assert_eq!(r.pending_records.len(), 1, "{:?}", r.pending_records);
    assert_eq!(r.pending_records[0].status, "completed");
}

fn server(started_at: u64, end_time: u64) -> ServerSession {
    ServerSession { started_at, end_time, objective: Some("Write".into()), uid: Some("uid1".into()) }
}

#[test]
fn m7_a_session_still_live_on_the_server_is_re_armed() {
    // The state file was edited to drop the session; Firebase still has it.
    let mut p = idle();
    p.exe_approved = set(&["discord"]);
    p.disarm_latch = true;
    rearm_from_server(&mut p, &server(T0, T0 + 25 * MIN), T0 + 5 * MIN).unwrap();
    assert!(p.focus_active);
    assert_eq!(p.session_end_time, Some(T0 + 25 * MIN));
    assert_eq!(p.session_started_at, Some(T0));
    assert_eq!(p.session_uid.as_deref(), Some("uid1"));
    assert_eq!(p.exe_blacklist, set(&["discord"]));
    assert!(!p.disarm_latch);
    // A forged far-off end on the server is capped like any other deadline.
    let mut q = idle();
    rearm_from_server(&mut q, &server(T0, T0 + 900 * MIN), T0 + 5 * MIN).unwrap();
    assert!(q.session_end_time.unwrap() <= T0 + 240 * MIN);
}

#[test]
fn m7_a_server_session_that_already_ended_here_is_not_re_armed() {
    // Bailed out (or finished) here, but the end never reached Firebase.
    let mut p = armed();
    p.end_session(T0 + 10 * MIN);
    assert!(rearm_from_server(&mut p, &server(T0, T0 + 25 * MIN), T0 + 12 * MIN).is_err());
    assert!(!p.focus_active);
    // An expired server session is not re-armed either.
    let mut q = idle();
    assert!(rearm_from_server(&mut q, &server(T0, T0 + 25 * MIN), T0 + 30 * MIN).is_err());
    // A running session here is left as it is.
    let mut r = armed();
    rearm_from_server(&mut r, &server(T0 - 5 * MIN, T0 + 90 * MIN), T0 + MIN).unwrap();
    assert_eq!(r.session_end_time, Some(T0 + 25 * MIN));
}

// ── B2 M6: Delete account leaves no local copy of the account's lists ────────

#[test]
fn m6_delete_account_forgets_this_accounts_lists_and_records() {
    let mut p = armed();
    p.end_session(T0 + 25 * MIN);
    p.web_blacklist = set(&["youtube.com"]);
    p.exe_pending = set(&["steam"]);
    p.permanent_pending = set(&["roblox"]);
    p.pending_records.push(SessionRecord {
        ended_at: T0 - MIN, minutes: 5, status: "completed".into(), objective: "Other's".into(), uid: Some("uid2".into()),
    });
    p.pending_records.push(SessionRecord {
        ended_at: T0 + 25 * MIN, minutes: 25, status: "completed".into(), objective: "Write".into(), uid: Some("uid1".into()),
    });
    forget_account(&mut p, "uid1", T0 + 30 * MIN).unwrap();
    assert!(p.exe_approved.is_empty() && p.exe_blacklist.is_empty() && p.exe_pending.is_empty());
    assert!(p.web_blacklist.is_empty() && p.permanent_exe.is_empty() && p.permanent_pending.is_empty());
    assert!(p.session_objective.is_none() && p.session_uid.is_none());
    // Another account's unsent record is left for its owner.
    assert_eq!(p.pending_records.len(), 1);
    assert_eq!(p.pending_records[0].uid.as_deref(), Some("uid2"));
    // Not a disarm: the next session starts normally.
    assert!(!p.disarm_latch);
    let saved = serde_json::to_string(&p).unwrap();
    for word in ["discord", "steam", "fortnite", "youtube.com", "roblox", "Write"] {
        assert!(!saved.contains(word), "{word} still in enforcer_state.json");
    }
}

#[test]
fn m6_forget_account_is_refused_while_a_session_runs() {
    let mut p = armed();
    assert!(forget_account(&mut p, "uid1", T0 + MIN).is_err());
    assert!(p.focus_active);
    assert_eq!(p.permanent_exe, set(&["fortnite"]));
    // Nor while a fuse burns.
    let mut q = armed();
    q.bailout_deadline = Some(T0 + 6 * MIN);
    assert!(forget_account(&mut q, "uid1", T0 + 2 * MIN).is_err());
}

// ── M4 / L1: "this device" approval lives in Rust ────────────────────────────

#[test]
fn m4_firebase_cannot_vouch_for_a_block_as_this_devices() {
    // Another device writes blockedApps/evil and blockedApps_meta/evil = this
    // PC's device id (readable in sessionState.originDeviceId). Nothing from
    // Firebase approves it: it is staged.
    let mut p = idle();
    p.exe_approved = set(&["steam"]);
    let pending = apply_session_sync(&mut p, &s(&["steam", "evil"]), true, Some("uid1")).unwrap();
    assert_eq!(pending, set(&["evil"]));
    assert_eq!(p.exe_approved, set(&["steam"]));
    assert_eq!(p.exe_pending, set(&["evil"]));
}

#[test]
fn m4_a_block_added_here_is_approved_by_rust_once() {
    let mut p = idle();
    assert_eq!(note_added_here(&mut p, "Roblox.exe"), Some("roblox".to_string()));
    assert_eq!(note_added_here(&mut p, "x"), None, "too short to be a block");
    let pending = apply_session_sync(&mut p, &s(&["roblox"]), true, Some("uid1")).unwrap();
    assert!(pending.is_empty());
    assert_eq!(p.exe_approved, set(&["roblox"]));
    assert!(p.exe_added_here.is_empty(), "the note is used up when Firebase echoes it");
    // Removed, then added again from another device: staged.
    apply_session_sync(&mut p, &[], true, Some("uid1")).unwrap();
    let again = apply_session_sync(&mut p, &s(&["roblox"]), true, Some("uid1")).unwrap();
    assert_eq!(again, set(&["roblox"]));
}

#[test]
fn m4_a_block_added_here_mid_session_is_killed_at_once() {
    let mut p = armed();
    note_added_here(&mut p, "roblox");
    apply_session_sync(&mut p, &s(&["discord", "steam", "roblox"]), true, Some("uid1")).unwrap();
    assert!(kill_terms(&p).contains(&"roblox".to_string()));
}

#[test]
fn m4_only_a_new_install_trusts_its_first_list() {
    // run() starts with exe_migrated false when there is no state file.
    let mut fresh = idle();
    fresh.exe_migrated = false;
    assert!(apply_session_sync(&mut fresh, &s(&["steam"]), true, Some("uid1")).unwrap().is_empty());
    assert!(fresh.exe_migrated);
    assert_eq!(apply_session_sync(&mut fresh, &s(&["steam", "evil"]), true, Some("uid1")).unwrap(), set(&["evil"]));
    // A state file from before has no field: already migrated, its approvals stand.
    let mut old = idle();
    assert!(old.exe_migrated);
    old.exe_approved = set(&["steam"]);
    assert_eq!(apply_session_sync(&mut old, &s(&["steam", "evil"]), true, Some("uid1")).unwrap(), set(&["evil"]));
}

#[test]
fn m4_delete_account_forgets_what_was_added_here() {
    let mut p = idle();
    note_added_here(&mut p, "roblox");
    forget_account(&mut p, "uid1", T0).unwrap();
    assert!(p.exe_added_here.is_empty());
}

#[test]
fn l1_approve_takes_only_the_names_shown() {
    // The banner showed steam; evil arrived from another device before the click.
    let mut p = idle();
    p.exe_pending = set(&["steam", "evil"]);
    p.permanent_pending = set(&["roblox", "evil2"]);
    assert_eq!(confirm_pending_exe(&mut p, &s(&["steam"])), s(&["steam"]));
    assert_eq!(p.exe_approved, set(&["steam"]));
    assert_eq!(p.exe_pending, set(&["evil"]), "still waiting, still not enforced");
    assert!(confirm_pending_exe(&mut p, &s(&["discord"])).is_empty(), "a name that isn't pending approves nothing");
    assert!(!p.exe_approved.contains("discord"));
    assert_eq!(confirm_pending_permanent(&mut p, &s(&["roblox"])), s(&["roblox"]));
    assert_eq!(p.permanent_exe, set(&["roblox"]));
    assert_eq!(p.permanent_pending, set(&["evil2"]));
}

#[test]
fn l1_an_approval_mid_session_arms_only_the_names_shown_and_keeps_held_removals() {
    let mut p = armed();
    apply_session_sync(&mut p, &s(&["steam"]), true, Some("uid1")).unwrap(); // discord removed: held
    p.exe_pending = set(&["roblox", "evil"]);
    confirm_pending_exe(&mut p, &s(&["roblox"]));
    let kills = kill_terms(&p);
    assert!(kills.contains(&"roblox".to_string()));
    assert!(!kills.contains(&"evil".to_string()));
    assert!(kills.contains(&"discord".to_string()), "a removal held for this session was dropped");
}

#[test]
fn l1_reject_drops_only_the_names_shown() {
    let mut p = idle();
    p.exe_pending = set(&["steam", "evil"]);
    p.permanent_pending = set(&["roblox", "evil2"]);
    assert_eq!(reject_pending_exe(&mut p, &s(&["steam"])), 1);
    assert_eq!(p.exe_pending, set(&["evil"]));
    assert_eq!(reject_pending_permanent(&mut p, &s(&["roblox"])), 1);
    assert_eq!(p.permanent_pending, set(&["evil2"]));
}
