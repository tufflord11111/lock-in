//! Browser lockdown: what happens to each known browser during a session.
//!
//! Pure, and driven by the clock it's handed, so the rules can be tested without a
//! browser. Side effects live in lockdown_runner in lib.rs. Runs on its own 1 s
//! tick, because the 2 s kill loop is too coarse for "force after 2 s".

use crate::browsers::KNOWN;
use std::collections::HashMap;

pub const WARN_MS: u64 = 10_000;
pub const FORCE_AFTER_MS: u64 = 2_000;
/// A relaunch gets this long to prove itself, then WM_CLOSE and FORCE_AFTER_MS:
/// gone about 5 s after it appeared.
pub const RELAUNCH_GRACE_MS: u64 = 3_000;
/// The clock jumped this far between ticks: the PC was asleep.
pub const WAKE_GAP_MS: u64 = 30_000;

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Warn { browser: &'static str },
    SoftClose { browser: &'static str },
    ForceClose { browser: &'static str },
    /// Allowed, but Web Guard can't see this browser's private windows. Once.
    IncognitoGap { browser: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    /// Nothing is happening to it: not running, or allowed.
    Clear,
    Warned { close_at: u64 },
    Closing { force_at: u64 },
    /// Closed this session. `relaunched_at` once it's back.
    Closed { relaunched_at: Option<u64> },
}

#[derive(Debug, Clone)]
struct Entry {
    phase: Phase,
    incognito_warned: bool,
}

/// What the rest of the app knows, for one tick.
pub struct Tick<'a> {
    pub now: u64,
    /// Ids of the known browsers running right now.
    pub running: &'a [&'static str],
    /// The browser's latest beat counting for this session's account, if any.
    pub last_beat: &'a dyn Fn(&str) -> Option<u64>,
    /// Its latest beat said Web Guard isn't allowed in Incognito.
    pub incognito_off: &'a dyn Fn(&str) -> bool,
    pub fresh_ms: u64,
}

#[derive(Default)]
pub struct Tracker {
    entries: HashMap<&'static str, Entry>,
    last_tick: Option<u64>,
}

impl Tracker {
    /// A new session starts clean.
    pub fn reset(&mut self) {
        self.entries.clear();
        self.last_tick = None;
    }

    pub fn tick(&mut self, t: &Tick) -> Vec<Action> {
        let woke = self.last_tick.map_or(false, |prev| t.now.saturating_sub(prev) >= WAKE_GAP_MS);
        self.last_tick = Some(t.now);
        let mut actions = Vec::new();
        for browser in KNOWN {
            let entry = self.entries.entry(browser.id).or_insert(Entry { phase: Phase::Clear, incognito_warned: false });
            // Nobody read a warning that ran out while the PC was asleep.
            if woke {
                if let Phase::Warned { .. } = entry.phase {
                    entry.phase = Phase::Warned { close_at: t.now + WARN_MS };
                }
            }
            let beat = (t.last_beat)(browser.id);
            let fresh = beat.map_or(false, |at| t.now.saturating_sub(at) < t.fresh_ms);
            if !t.running.contains(&browser.id) {
                entry.phase = match entry.phase {
                    Phase::Closing { .. } | Phase::Closed { .. } => Phase::Closed { relaunched_at: None },
                    _ => Phase::Clear,
                };
                continue;
            }
            if fresh && !entry.incognito_warned && (t.incognito_off)(browser.id) {
                entry.incognito_warned = true;
                actions.push(Action::IncognitoGap { browser: browser.id });
            }
            match entry.phase {
                Phase::Clear => {
                    if !fresh {
                        entry.phase = Phase::Warned { close_at: t.now + WARN_MS };
                        actions.push(Action::Warn { browser: browser.id });
                    }
                }
                Phase::Warned { close_at } => {
                    if fresh {
                        entry.phase = Phase::Clear;
                    } else if t.now >= close_at {
                        entry.phase = Phase::Closing { force_at: t.now + FORCE_AFTER_MS };
                        actions.push(Action::SoftClose { browser: browser.id });
                    }
                }
                Phase::Closing { force_at } => {
                    if t.now >= force_at {
                        entry.phase = Phase::Closed { relaunched_at: None };
                        actions.push(Action::ForceClose { browser: browser.id });
                    }
                }
                Phase::Closed { relaunched_at } => {
                    let back_at = relaunched_at.unwrap_or(t.now);
                    // A beat since it came back: Web Guard is working in it now.
                    if beat.map_or(false, |at| at > back_at) {
                        entry.phase = Phase::Clear;
                    } else if t.now.saturating_sub(back_at) >= RELAUNCH_GRACE_MS {
                        entry.phase = Phase::Closing { force_at: t.now + FORCE_AFTER_MS };
                        actions.push(Action::SoftClose { browser: browser.id });
                    } else {
                        entry.phase = Phase::Closed { relaunched_at: Some(back_at) };
                    }
                }
            }
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tick every second from `from` through `to`, with these browsers running.
    fn run(
        tracker: &mut Tracker,
        from: u64,
        to: u64,
        running: &[&'static str],
        beats: &dyn Fn(&str) -> Option<u64>,
    ) -> Vec<(u64, Action)> {
        let mut out = Vec::new();
        let mut now = from;
        while now <= to {
            let t = Tick { now, running, last_beat: beats, incognito_off: &|_| false, fresh_ms: 60_000 };
            for a in tracker.tick(&t) {
                out.push((now, a));
            }
            now += 1_000;
        }
        out
    }

    fn no_beats(_: &str) -> Option<u64> {
        None
    }

    #[test]
    fn a_browser_with_a_fresh_beat_is_left_alone() {
        let mut t = Tracker::default();
        let beats = |b: &str| (b == "edge").then_some(0);
        assert!(run(&mut t, 1_000, 30_000, &["edge"], &beats).is_empty());
    }

    #[test]
    fn no_beat_means_warned_then_closed_and_chrome_is_not_exempt() {
        let mut t = Tracker::default();
        let got = run(&mut t, 0, 15_000, &["chrome"], &no_beats);
        assert_eq!(
            got,
            vec![
                (0, Action::Warn { browser: "chrome" }),
                (10_000, Action::SoftClose { browser: "chrome" }),
                (12_000, Action::ForceClose { browser: "chrome" }),
            ]
        );
    }

    #[test]
    fn only_the_browser_without_a_beat_is_touched() {
        let mut t = Tracker::default();
        let beats = |b: &str| (b == "edge").then_some(0);
        let got = run(&mut t, 0, 15_000, &["edge", "firefox"], &beats);
        assert!(!got.is_empty());
        assert!(got.iter().all(|(_, a)| matches!(
            a,
            Action::Warn { browser: "firefox" } | Action::SoftClose { browser: "firefox" } | Action::ForceClose { browser: "firefox" }
        )));
    }

    #[test]
    fn closing_it_yourself_inside_the_warning_ends_it() {
        let mut t = Tracker::default();
        run(&mut t, 0, 5_000, &["firefox"], &no_beats);
        assert!(run(&mut t, 6_000, 20_000, &[], &no_beats).is_empty());
    }

    #[test]
    fn a_beat_arriving_inside_the_warning_saves_it() {
        // This is also how a just-launched browser with Web Guard survives.
        let mut t = Tracker::default();
        run(&mut t, 0, 4_000, &["chrome"], &no_beats);
        let beats = |_: &str| Some(5_000);
        assert!(run(&mut t, 5_000, 30_000, &["chrome"], &beats).is_empty());
    }

    #[test]
    fn a_relaunch_is_closed_in_about_5_s_with_no_new_warning() {
        let mut t = Tracker::default();
        run(&mut t, 0, 12_000, &["firefox"], &no_beats);
        run(&mut t, 13_000, 20_000, &[], &no_beats);
        let got = run(&mut t, 21_000, 30_000, &["firefox"], &no_beats);
        assert_eq!(got[0], (24_000, Action::SoftClose { browser: "firefox" }));
        assert_eq!(got[1], (26_000, Action::ForceClose { browser: "firefox" }));
        assert!(got.iter().all(|(_, a)| !matches!(a, Action::Warn { .. })));
        // 26 - 21: gone about 5 s after it came back.
    }

    #[test]
    fn it_keeps_being_closed_for_the_whole_session() {
        let mut t = Tracker::default();
        run(&mut t, 0, 12_000, &["firefox"], &no_beats);
        for start in [20_000u64, 40_000, 60_000] {
            run(&mut t, start - 1_000, start - 1_000, &[], &no_beats);
            let got = run(&mut t, start, start + 6_000, &["firefox"], &no_beats);
            assert!(got.iter().any(|(_, a)| matches!(a, Action::ForceClose { .. })), "{}", start);
        }
    }

    #[test]
    fn a_relaunch_with_web_guard_working_now_is_allowed() {
        let mut t = Tracker::default();
        run(&mut t, 0, 12_000, &["chrome"], &no_beats);
        run(&mut t, 13_000, 20_000, &[], &no_beats);
        let beats = |_: &str| Some(22_000);
        let got = run(&mut t, 21_000, 40_000, &["chrome"], &beats);
        assert!(got.iter().all(|(_, a)| !matches!(a, Action::ForceClose { .. })));
    }

    #[test]
    fn a_warning_that_ran_out_while_asleep_starts_again() {
        let mut t = Tracker::default();
        run(&mut t, 0, 5_000, &["firefox"], &no_beats);
        // Slept an hour: nothing closes straight away.
        let got = run(&mut t, 3_600_000, 3_609_000, &["firefox"], &no_beats);
        assert!(got.is_empty());
        let got = run(&mut t, 3_610_000, 3_610_000, &["firefox"], &no_beats);
        assert_eq!(got[0].1, Action::SoftClose { browser: "firefox" });
    }

    #[test]
    fn web_guard_without_incognito_stays_open_with_one_warning() {
        let mut t = Tracker::default();
        let beats = |_: &str| Some(0);
        let off = |b: &str| b == "chrome";
        let mut got = Vec::new();
        for now in [1_000u64, 2_000, 30_000] {
            let tick = Tick { now, running: &["chrome", "edge"], last_beat: &beats, incognito_off: &off, fresh_ms: 60_000 };
            got.extend(t.tick(&tick));
        }
        assert_eq!(got, vec![Action::IncognitoGap { browser: "chrome" }]);
    }

    #[test]
    fn a_new_session_starts_clean() {
        let mut t = Tracker::default();
        run(&mut t, 0, 12_000, &["firefox"], &no_beats);
        t.reset();
        let got = run(&mut t, 20_000, 20_000, &["firefox"], &no_beats);
        assert_eq!(got, vec![(20_000, Action::Warn { browser: "firefox" })]);
    }
}
