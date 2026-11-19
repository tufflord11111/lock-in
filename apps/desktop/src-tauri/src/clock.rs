//! Telling a changed clock from time passing.
//!
//! Session deadlines are wall-clock times (epoch ms), so moving the clock
//! forward used to end a session early and burn a Bail out fuse early, and
//! changing the time zone across midnight gave a second bail-out "today".
//!
//! GetTickCount64 counts milliseconds since boot and keeps counting through
//! sleep and hibernation, and changing the clock or the time zone doesn't touch
//! it. So between two looks, (wall change) - (tick change) is how far the clock
//! itself was moved; sleep moves both alike and reads as zero. Not
//! QueryUnbiasedInterruptTime or Instant: they stop while asleep, so a night's
//! sleep would read as the clock jumping forward by the night.
//!
//! Pure apart from tick64() and utc_offset_min(), so the rules are testable.

use serde::{Deserialize, Serialize};

/// A difference this big is the clock being changed, not drift or the 2 s tick
/// running late. An NTP correction under this is simply absorbed.
pub const JUMP_MS: i64 = 10_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Watch {
    /// The wall clock and tick count at the last look. Saved with the state
    /// file, so a clock moved while Lock-In was closed is caught at the next
    /// start, unless the PC restarted (the tick count starts again at boot).
    #[serde(default)]
    last_wall: Option<u64>,
    #[serde(default)]
    last_tick: Option<u64>,
    /// Every jump caught so far, added up: how far this PC's clock is from
    /// the time that really passed. Positive: the clock is ahead.
    #[serde(default)]
    pub skew_ms: i64,
}

impl Watch {
    /// Look at both clocks. Returns how far the wall clock was moved since the
    /// last look (0 for none, or for sleep), and remembers it in skew_ms.
    pub fn observe(&mut self, wall: u64, tick: u64) -> i64 {
        let jump = match (self.last_wall, self.last_tick) {
            // A smaller tick count means the PC restarted: nothing to compare.
            (Some(w), Some(t)) if tick >= t => (wall as i64 - w as i64) - (tick as i64 - t as i64),
            _ => 0,
        };
        self.last_wall = Some(wall);
        self.last_tick = Some(tick);
        if jump.abs() >= JUMP_MS {
            self.skew_ms += jump;
            jump
        } else {
            0
        }
    }

    /// The wall clock with every caught jump taken back out.
    pub fn true_now(&self, wall: u64) -> u64 {
        (wall as i64 - self.skew_ms).max(0) as u64
    }
}

/// Move a wall-clock time by a jump, for a deadline that must stay the same
/// distance away in real time.
pub fn shifted(t: u64, jump: i64) -> u64 {
    (t as i64 + jump).max(0) as u64
}

/// The calendar date ("YYYY-MM-DD") at epoch ms `ms` in a zone `offset_min`
/// minutes ahead of UTC.
pub fn day_at(ms: u64, offset_min: i32) -> String {
    let local_ms = ms as i64 + offset_min as i64 * 60_000;
    let days = local_ms.div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Howard Hinnant's days-to-civil.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Minutes from one (y, m, d, h, min) to another.
pub fn minutes_between(a: (i64, u32, u32, u32, u32), b: (i64, u32, u32, u32, u32)) -> i32 {
    let at = |t: (i64, u32, u32, u32, u32)| days_from_civil(t.0, t.1, t.2) * 1_440 + t.3 as i64 * 60 + t.4 as i64;
    (at(b) - at(a)) as i32
}

/// Milliseconds since boot, sleep and hibernation included.
pub fn tick64() -> u64 {
    // SAFETY: no arguments, no side effects.
    unsafe { windows::Win32::System::SystemInformation::GetTickCount64() }
}

/// This PC's current offset from UTC in minutes (Singapore: +480), from the
/// local and UTC clocks read together.
pub fn utc_offset_min() -> i32 {
    use windows::Win32::System::SystemInformation::{GetLocalTime, GetSystemTime};
    // SAFETY: both only return a SYSTEMTIME.
    let (l, u) = unsafe { (GetLocalTime(), GetSystemTime()) };
    let t = |s: windows::Win32::Foundation::SYSTEMTIME| (s.wYear as i64, s.wMonth as u32, s.wDay as u32, s.wHour as u32, s.wMinute as u32);
    minutes_between(t(u), t(l))
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: u64 = 3_600_000;

    #[test]
    fn steady_ticking_is_no_jump() {
        let mut w = Watch::default();
        assert_eq!(w.observe(1_000_000, 50_000), 0, "first look");
        assert_eq!(w.observe(1_002_000, 52_000), 0);
        assert_eq!(w.observe(1_004_900, 54_000), 0, "a late tick is not a jump");
        assert_eq!(w.skew_ms, 0);
    }

    #[test]
    fn sleep_and_hibernate_move_both_clocks_so_they_are_no_jump() {
        let mut w = Watch::default();
        w.observe(10 * H, 1_000);
        // Asleep for 8 hours: GetTickCount64 kept counting.
        assert_eq!(w.observe(18 * H, 1_000 + 8 * H), 0);
        assert_eq!(w.true_now(18 * H), 18 * H);
    }

    #[test]
    fn a_forward_change_is_caught_with_its_size() {
        let mut w = Watch::default();
        w.observe(10 * H, 1_000);
        assert_eq!(w.observe(13 * H + 2_000, 3_000), 3 * H as i64);
        assert_eq!(w.true_now(13 * H + 2_000), 10 * H + 2_000);
    }

    #[test]
    fn a_backward_change_is_caught_too() {
        let mut w = Watch::default();
        w.observe(10 * H, 1_000);
        assert_eq!(w.observe(9 * H + 2_000, 3_000), -(H as i64));
        assert_eq!(w.true_now(9 * H + 2_000), 10 * H + 2_000);
    }

    #[test]
    fn a_restart_of_the_pc_compares_nothing() {
        let mut w = Watch::default();
        w.observe(10 * H, 5 * H);
        assert_eq!(w.observe(20 * H, 1_000), 0, "tick count went back: rebooted");
    }

    #[test]
    fn days_and_offsets() {
        // 2026-11-19 15:30 UTC
        let t = days_from_civil(2026, 11, 19) as u64 * 86_400_000 + 15 * H + 30 * 60_000;
        assert_eq!(day_at(t, 0), "2026-11-19");
        assert_eq!(day_at(t, 480), "2026-11-19", "23:30 in Singapore");
        assert_eq!(day_at(t, 540), "2026-11-20", "00:30 in Tokyo");
        assert_eq!(day_at(t, -960), "2026-11-18");
        assert_eq!(minutes_between((2026, 11, 19, 15, 30), (2026, 11, 19, 23, 30)), 480);
        assert_eq!(minutes_between((2026, 12, 31, 20, 0), (2027, 1, 1, 4, 0)), 480, "across a year");
        assert_eq!(minutes_between((2026, 11, 19, 15, 30), (2026, 11, 19, 5, 30)), -600);
    }

    #[test]
    fn this_pcs_offset_reads_sensibly() {
        let off = utc_offset_min();
        assert!((-14 * 60..=14 * 60).contains(&off), "{off}");
        assert!(tick64() > 0);
    }
}
