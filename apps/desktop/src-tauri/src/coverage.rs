//! Is every part of a running browser covered by a live Web Guard?
//!
//! A browser is covered when each of its instances (one per user-data-dir,
//! attest.rs) has a fresh beat for this session's account, and, from Web Guard
//! 1.3.1 on, its beats together see at least as many windows as Windows shows
//! for that instance. A Guest window, a second profile without Web Guard, or
//! an Incognito window Web Guard isn't allowed in is a window no beat counts,
//! so the browser isn't covered and lockdown warns and closes it as usual.
//!
//! Pure, so it can be tested without a browser.

use crate::heartbeat::Beat;
use std::collections::HashMap;

/// A window count that stays short this long counts against the browser. Web
/// Guard beats as soon as one of its windows opens, so only a window it can't
/// see stays unaccounted for; a tab being dragged out is gone well within this.
pub const WINDOW_GRACE_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Gap {
    /// An instance with no fresh beat for this account.
    NoBeat,
    /// Web Guard's site access is cut to some sites or "on click".
    SiteAccess,
    /// Web Guard isn't allowed in Incognito, so those windows are unblocked.
    Incognito,
    /// Web Guard was told this session is live and still says it isn't blocking.
    NotLocked,
    /// More windows than Web Guard can see.
    UnseenWindows,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Instance {
    pub root: u32,
    pub windows: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Verdict {
    /// The oldest of each instance's newest counting beat, when every instance has one.
    pub at: Option<u64>,
    pub gap: Option<Gap>,
}

/// The verdict for one browser.
pub fn brand(instances: &[Instance], beats: &[Beat], uid: Option<&str>, now: u64, fresh_ms: u64) -> Verdict {
    if instances.is_empty() {
        return Verdict { at: None, gap: Some(Gap::NoBeat) };
    }
    let mut oldest: Option<u64> = None;
    let mut gap = None;
    for inst in instances {
        let fresh: Vec<&Beat> = beats
            .iter()
            .filter(|b| b.root == inst.root && b.counts_for(uid) && now.saturating_sub(b.at) < fresh_ms)
            .collect();
        let Some(newest) = fresh.iter().map(|b| b.at).max() else {
            return Verdict { at: None, gap: Some(Gap::NoBeat) };
        };
        oldest = Some(oldest.map_or(newest, |o: u64| o.min(newest)));
        if fresh.iter().any(|b| b.host_access == Some(false)) {
            return_first(&mut gap, Gap::SiteAccess);
        }
        if fresh.iter().any(|b| !b.incognito_allowed) {
            return_first(&mut gap, Gap::Incognito);
        }
        // Told about the session by the reply to its last beat, and still not
        // blocking: it can't be relied on (1.3.1 locks as soon as it's told).
        if fresh.iter().any(|b| b.told_active && b.locked == Some(false)) {
            return_first(&mut gap, Gap::NotLocked);
        }
        // Web Guard before 1.3.1 doesn't count windows: the check needs every beat to.
        if fresh.iter().all(|b| b.windows.is_some()) {
            let seen: u32 = fresh.iter().map(|b| b.windows.unwrap_or(0)).sum();
            if inst.windows > seen {
                return_first(&mut gap, Gap::UnseenWindows);
            }
        }
    }
    Verdict { at: oldest, gap }
}

/// Keeps the first gap found: the one that says most about what to fix.
fn return_first(gap: &mut Option<Gap>, g: Gap) {
    if gap.is_none() {
        *gap = Some(g);
    }
}

/// Holds an unseen-window gap back for WINDOW_GRACE_MS before it counts.
#[derive(Default)]
pub struct Grace {
    since: HashMap<&'static str, u64>,
}

impl Grace {
    /// The browser's latest beat time as lockdown should see it: None means
    /// not covered right now.
    pub fn last_beat(&mut self, browser: &'static str, v: Verdict, now: u64) -> Option<u64> {
        match v.gap {
            None => {
                self.since.remove(browser);
                v.at
            }
            Some(Gap::UnseenWindows) => {
                let since = *self.since.entry(browser).or_insert(now);
                if now.saturating_sub(since) < WINDOW_GRACE_MS { v.at } else { None }
            }
            Some(_) => {
                self.since.remove(browser);
                None
            }
        }
    }

    pub fn reset(&mut self) {
        self.since.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRESH: u64 = 35_000;

    fn beat(root: u32, at: u64, uid: &str, profile: Option<&str>, windows: Option<u32>) -> Beat {
        Beat {
            at,
            incognito_allowed: true,
            uid: Some(uid.into()),
            root,
            profile: profile.map(str::to_string),
            windows,
            locked: Some(true),
            host_access: Some(true),
            told_active: true,
            replied_active: true,
        }
    }

    #[test]
    fn one_instance_with_a_beat_that_sees_every_window_is_covered() {
        let v = brand(&[Instance { root: 10, windows: 2 }], &[beat(10, 1_000, "u1", Some("p1"), Some(2))], Some("u1"), 2_000, FRESH);
        assert_eq!(v, Verdict { at: Some(1_000), gap: None });
    }

    #[test]
    fn a_second_user_data_dir_without_web_guard_is_not_covered() {
        let instances = [Instance { root: 10, windows: 1 }, Instance { root: 20, windows: 1 }];
        let v = brand(&instances, &[beat(10, 1_000, "u1", Some("p1"), Some(1))], Some("u1"), 2_000, FRESH);
        assert_eq!(v.gap, Some(Gap::NoBeat));
        assert_eq!(v.at, None);
    }

    #[test]
    fn a_guest_or_second_profile_window_is_a_window_no_beat_counts() {
        // Default profile beats for 1 window; Windows shows 2 (the Guest window).
        let v = brand(&[Instance { root: 10, windows: 2 }], &[beat(10, 1_000, "u1", Some("p1"), Some(1))], Some("u1"), 2_000, FRESH);
        assert_eq!(v.gap, Some(Gap::UnseenWindows));
    }

    #[test]
    fn two_profiles_both_running_web_guard_on_this_account_are_covered() {
        let beats = [beat(10, 1_000, "u1", Some("p1"), Some(1)), beat(10, 1_500, "u1", Some("p2"), Some(1))];
        let v = brand(&[Instance { root: 10, windows: 2 }], &beats, Some("u1"), 2_000, FRESH);
        assert_eq!(v.gap, None);
    }

    #[test]
    fn a_second_profile_signed_in_to_another_account_doesnt_count() {
        let beats = [beat(10, 1_000, "u1", Some("p1"), Some(1)), beat(10, 1_000, "u2", Some("p2"), Some(1))];
        let v = brand(&[Instance { root: 10, windows: 2 }], &beats, Some("u1"), 2_000, FRESH);
        assert_eq!(v.gap, Some(Gap::UnseenWindows));
    }

    #[test]
    fn web_guard_before_1_3_1_counts_for_its_instance_without_a_window_check() {
        let v = brand(&[Instance { root: 10, windows: 3 }], &[beat(10, 1_000, "u1", None, None)], Some("u1"), 2_000, FRESH);
        assert_eq!(v.gap, None);
    }

    #[test]
    fn a_stale_beat_counts_for_nothing() {
        let v = brand(&[Instance { root: 10, windows: 1 }], &[beat(10, 1_000, "u1", Some("p1"), Some(1))], Some("u1"), 1_000 + FRESH, FRESH);
        assert_eq!(v.gap, Some(Gap::NoBeat));
    }

    #[test]
    fn web_guard_not_allowed_in_incognito_leaves_the_browser_uncovered() {
        let mut b = beat(10, 1_000, "u1", Some("p1"), Some(1));
        b.incognito_allowed = false;
        let v = brand(&[Instance { root: 10, windows: 1 }], &[b], Some("u1"), 2_000, FRESH);
        assert_eq!(v.gap, Some(Gap::Incognito));
        // And there is no grace for it.
        assert_eq!(Grace::default().last_beat("chrome", v, 2_000), None);
    }

    #[test]
    fn web_guard_with_site_access_cut_leaves_the_browser_uncovered() {
        let mut b = beat(10, 1_000, "u1", Some("p1"), Some(1));
        b.host_access = Some(false);
        let v = brand(&[Instance { root: 10, windows: 1 }], &[b], Some("u1"), 2_000, FRESH);
        assert_eq!(v.gap, Some(Gap::SiteAccess));
    }

    #[test]
    fn web_guard_told_of_the_session_but_not_blocking_leaves_it_uncovered() {
        let mut b = beat(10, 1_000, "u1", Some("p1"), Some(1));
        b.locked = Some(false);
        let v = brand(&[Instance { root: 10, windows: 1 }], &[b.clone()], Some("u1"), 2_000, FRESH);
        assert_eq!(v.gap, Some(Gap::NotLocked));
        // The first beat of a session, sent before Web Guard was told: fine.
        b.told_active = false;
        let v = brand(&[Instance { root: 10, windows: 1 }], &[b], Some("u1"), 2_000, FRESH);
        assert_eq!(v.gap, None);
    }

    #[test]
    fn an_unseen_window_counts_only_after_the_grace() {
        let mut g = Grace::default();
        let short = Verdict { at: Some(1_000), gap: Some(Gap::UnseenWindows) };
        assert_eq!(g.last_beat("chrome", short, 2_000), Some(1_000));
        assert_eq!(g.last_beat("chrome", short, 2_000 + WINDOW_GRACE_MS - 1), Some(1_000));
        assert_eq!(g.last_beat("chrome", short, 2_000 + WINDOW_GRACE_MS), None);
        // Seen again: the grace starts over next time.
        let ok = Verdict { at: Some(9_000), gap: None };
        assert_eq!(g.last_beat("chrome", ok, 9_000), Some(9_000));
        assert_eq!(g.last_beat("chrome", short, 10_000), Some(1_000));
    }

    #[test]
    fn no_beat_is_never_held_back() {
        let mut g = Grace::default();
        assert_eq!(g.last_beat("edge", Verdict { at: None, gap: Some(Gap::NoBeat) }, 1_000), None);
    }
}
