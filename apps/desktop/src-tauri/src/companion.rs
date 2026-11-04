//! The parrot overlay's native side.
//!
//! Read-only geometry and timestamps only: no hooks, no other process touched,
//! no window titles or process names read. The session state comes from the
//! enforcer's existing profile, read and never written.
#![allow(dead_code)] // The window code in the next commit uses all of this.

use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetShellWindow, GetWindowRect, GetWindowThreadProcessId, IsZoomed,
};

#[derive(Clone, Copy, Debug, PartialEq)]
struct ScreenRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl From<RECT> for ScreenRect {
    fn from(r: RECT) -> Self {
        ScreenRect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    }
}

/// A window at least as large as the monitor, on every side.
fn covers_monitor(window: ScreenRect, monitor: ScreenRect) -> bool {
    window.left <= monitor.left
        && window.top <= monitor.top
        && window.right >= monitor.right
        && window.bottom >= monitor.bottom
}

/// Whether the foreground window is full screen. A maximised window isn't: with
/// an auto-hide taskbar its frame overhangs the monitor by a few pixels. Neither
/// is the desktop, nor our own windows; those are told apart by process id, and
/// no name is read.
fn foreground_is_fullscreen() -> bool {
    unsafe {
        if let Ok(state) = SHQueryUserNotificationState() {
            if state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE {
                return true;
            }
        }
        let foreground = GetForegroundWindow();
        if foreground.is_invalid() || IsZoomed(foreground).as_bool() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(foreground, Some(&mut pid));
        let mut shell_pid = 0u32;
        GetWindowThreadProcessId(GetShellWindow(), Some(&mut shell_pid));
        if pid == std::process::id() || pid == shell_pid {
            return false;
        }
        let mut window = RECT::default();
        if GetWindowRect(foreground, &mut window).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }
        covers_monitor(window.into(), info.rcMonitor.into())
    }
}

/// Milliseconds since the last keyboard or mouse input. When, never what.
fn user_idle_ms() -> u32 {
    unsafe {
        let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info).as_bool() {
            GetTickCount().wrapping_sub(info.dwTime)
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: ScreenRect = ScreenRect { left: 0, top: 0, right: 1920, bottom: 1080 };

    #[test]
    fn exact_cover_counts() {
        assert!(covers_monitor(MONITOR, MONITOR));
    }

    #[test]
    fn larger_than_the_monitor_counts() {
        let r = ScreenRect { left: -8, top: -8, right: 1928, bottom: 1088 };
        assert!(covers_monitor(r, MONITOR));
    }

    #[test]
    fn one_pixel_short_does_not() {
        let r = ScreenRect { bottom: 1079, ..MONITOR };
        assert!(!covers_monitor(r, MONITOR));
    }

    #[test]
    fn a_window_on_another_monitor_does_not() {
        let r = ScreenRect { left: 1920, top: 0, right: 3840, bottom: 1080 };
        assert!(!covers_monitor(r, MONITOR));
    }
}
