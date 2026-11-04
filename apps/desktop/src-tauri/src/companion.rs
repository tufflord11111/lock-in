//! The parrot overlay's native side.
//!
//! Read-only geometry and timestamps only: no hooks, no other process touched,
//! no window titles or process names read. The session state comes from the
//! enforcer's existing profile, read and never written.

use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
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

/// Full screen, not merely large. A maximised window's frame overhangs the monitor
/// by a few pixels, which with an auto-hide taskbar means it covers every side too;
/// a full-screen one fits exactly, even if (like a browser on F11) it stays flagged
/// as maximised. A borderless game can overhang and is still full screen.
fn is_fullscreen(window: ScreenRect, monitor: ScreenRect, zoomed: bool) -> bool {
    covers_monitor(window, monitor) && !(zoomed && window != monitor)
}

/// Whether the foreground window is full screen. Neither the desktop nor our own
/// windows count; those are told apart by process id, and no name is read.
fn foreground_is_fullscreen() -> bool {
    unsafe {
        if let Ok(state) = SHQueryUserNotificationState() {
            if state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE {
                return true;
            }
        }
        let foreground = GetForegroundWindow();
        if foreground.is_invalid() {
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
        is_fullscreen(window.into(), info.rcMonitor.into(), IsZoomed(foreground).as_bool())
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

const LABEL: &str = "parrot";
/// Rule: hit-test at no more than 10 Hz, and only while the bird is visible.
const HIT_TEST_EVERY: Duration = Duration::from_millis(100);
const POLL_AWAKE: Duration = Duration::from_millis(500);
/// Asleep nothing speaks, so only full screen and the work area matter.
const POLL_ASLEEP: Duration = Duration::from_secs(2);
const USER_IDLE_AFTER_MS: u32 = 5 * 60 * 1000;
/// The page normally says it has painted. Show it regardless after this long.
const READY_FALLBACK: Duration = Duration::from_secs(3);
/// Slack around the hitboxes, because the bird moves between hit-tests.
const HIT_PAD: f64 = 8.0;
const MAX_HITBOXES: usize = 4;

/// Physical pixels, relative to the overlay's top-left corner.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct Hitbox {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn cursor_hits(cursor: (f64, f64), boxes: &[Hitbox]) -> bool {
    boxes.iter().any(|b| {
        cursor.0 >= b.x - HIT_PAD
            && cursor.0 <= b.x + b.w + HIT_PAD
            && cursor.1 >= b.y - HIT_PAD
            && cursor.1 <= b.y + b.h + HIT_PAD
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Fit {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// The overlay's rectangle: the work area. Where that is the whole monitor (an
/// auto-hide taskbar), one pixel less, so Windows doesn't take an always-on-top
/// window for a full-screen app and keep the taskbar down.
fn overlay_fit(work: Fit, monitor: Fit) -> Fit {
    if work == monitor {
        Fit { y: work.y + 1, height: work.height.saturating_sub(1), ..work }
    } else {
        work
    }
}

/// What the page needs to know. No process or app names, by construction.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct World {
    session_active: bool,
    fullscreen: bool,
    user_idle: bool,
}

#[derive(Default)]
struct Shared {
    /// Main says: signed in, and the companion is on.
    active: bool,
    page_ready: bool,
    created_at: Option<Instant>,
    hitboxes: Vec<Hitbox>,
    dragging: bool,
    world: World,
}

/// Its own managed state: nothing here shares a lock with the enforcer.
#[derive(Default)]
pub struct CompanionState {
    shared: Mutex<Shared>,
    wake: Condvar,
}

fn primary_fit(app: &AppHandle) -> Option<Fit> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let work = monitor.work_area();
    Some(overlay_fit(
        Fit {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
            height: work.size.height,
        },
        Fit {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        },
    ))
}

fn apply_fit(window: &WebviewWindow, fit: Fit) {
    let _ = window.set_position(PhysicalPosition::new(fit.x, fit.y));
    let _ = window.set_size(PhysicalSize::new(fit.width, fit.height));
}

fn build_overlay(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("parrot.html".into()))
        .title("Lock-In parrot")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        .focused(false)
        .resizable(false)
        .visible(false)
        .devtools(false)
        .build()?;
    window.set_ignore_cursor_events(true)?;
    if let Some(fit) = primary_fit(app) {
        apply_fit(&window, fit);
    }
    Ok(())
}

/// Reads the session from the enforcer's profile. Never blocks it: if the lock
/// is busy, this poll keeps what it last saw.
fn session_active(app: &AppHandle, previous: bool) -> bool {
    app.try_state::<crate::AppState>()
        .and_then(|s| s.profile.try_lock().ok().map(|p| p.armed()))
        .unwrap_or(previous)
}

fn run(app: AppHandle) {
    let state = app.state::<CompanionState>();
    let mut shown = false;
    let mut ignoring = true;
    let mut clear_polls = 0u8;
    let mut next_poll = Instant::now();
    let mut fit: Option<Fit> = None;

    loop {
        {
            let mut shared = state.shared.lock().unwrap_or_else(|e| e.into_inner());
            if !shared.active {
                shown = false;
                ignoring = true;
                clear_polls = 0;
                fit = None;
                while !shared.active {
                    shared = state.wake.wait(shared).unwrap_or_else(|e| e.into_inner());
                }
                next_poll = Instant::now();
            }
        }
        let Some(window) = app.get_webview_window(LABEL) else {
            thread::sleep(HIT_TEST_EVERY);
            continue;
        };

        if Instant::now() >= next_poll {
            let (previous, ready) = {
                let shared = state.shared.lock().unwrap_or_else(|e| e.into_inner());
                let ready = shared.page_ready
                    || shared.created_at.is_some_and(|t| t.elapsed() >= READY_FALLBACK);
                (shared.world, ready)
            };
            // Hide at once; come back only after two clear polls, so alt-tab
            // doesn't flicker it.
            let over_fullscreen = foreground_is_fullscreen();
            clear_polls = if over_fullscreen { 0 } else { clear_polls.saturating_add(1) };
            let world = World {
                session_active: session_active(&app, previous.session_active),
                fullscreen: over_fullscreen || (previous.fullscreen && clear_polls < 2),
                user_idle: user_idle_ms() > USER_IDLE_AFTER_MS,
            };
            if world != previous {
                state.shared.lock().unwrap_or_else(|e| e.into_inner()).world = world;
                let _ = app.emit_to(LABEL, "parrot-world", world);
            }

            // A moved taskbar, a new resolution or a DPI change.
            if let Some(wanted) = primary_fit(&app).filter(|w| Some(*w) != fit) {
                apply_fit(&window, wanted);
                fit = Some(wanted);
            }

            let show = ready && !world.fullscreen;
            if show != shown {
                let _ = if show { window.show() } else { window.hide() };
                shown = show;
            }
            // "Show desktop" and the like minimise it too, and nothing else brings it back.
            if shown && window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
                if let Some(f) = fit {
                    apply_fit(&window, f);
                }
            }
            let every = if world.session_active && !world.fullscreen { POLL_ASLEEP } else { POLL_AWAKE };
            next_poll = Instant::now() + every;
        }

        if shown {
            if let (Ok(cursor), Some(f)) = (app.cursor_position(), fit) {
                let inside = {
                    let shared = state.shared.lock().unwrap_or_else(|e| e.into_inner());
                    shared.dragging
                        || cursor_hits((cursor.x - f.x as f64, cursor.y - f.y as f64), &shared.hitboxes)
                };
                if ignoring == inside {
                    let _ = window.set_ignore_cursor_events(!inside);
                    ignoring = !inside;
                }
            }
            thread::sleep(HIT_TEST_EVERY);
        } else {
            thread::sleep(next_poll.saturating_duration_since(Instant::now()).max(HIT_TEST_EVERY));
        }
    }
}

/// Starts the thread, parked until main turns the companion on.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || run(app));
}

/// Main only: signed in and switched on creates the overlay; anything else
/// destroys it. Async because a sync command building a webview deadlocks on Windows.
#[tauri::command]
pub async fn companion_set_enabled(enabled: bool, app: AppHandle, state: State<'_, CompanionState>) -> Result<(), String> {
    let exists = app.get_webview_window(LABEL);
    if enabled == exists.is_some() {
        return Ok(());
    }
    if enabled {
        build_overlay(&app).map_err(|e| e.to_string())?;
        let mut shared = state.shared.lock().map_err(|e| e.to_string())?;
        *shared = Shared { active: true, created_at: Some(Instant::now()), ..Shared::default() };
        state.wake.notify_all();
    } else {
        state.shared.lock().map_err(|e| e.to_string())?.active = false;
        if let Some(window) = exists {
            window.destroy().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Main only: Start 25 needs the window after all.
#[tauri::command]
pub fn companion_show_main(app: AppHandle) {
    crate::show_main_window(&app);
}

/// The page has painted its first frame.
#[tauri::command]
pub fn companion_ready(state: State<'_, CompanionState>) -> Result<(), String> {
    state.shared.lock().map_err(|e| e.to_string())?.page_ready = true;
    Ok(())
}

#[tauri::command]
pub fn companion_set_hitbox(boxes: Vec<Hitbox>, state: State<'_, CompanionState>) -> Result<(), String> {
    let mut shared = state.shared.lock().map_err(|e| e.to_string())?;
    shared.hitboxes = boxes;
    shared.hitboxes.truncate(MAX_HITBOXES);
    Ok(())
}

/// Pins the overlay clickable, or a fast drag outruns the 10 Hz hit-test.
#[tauri::command]
pub fn companion_set_dragging(dragging: bool, state: State<'_, CompanionState>) -> Result<(), String> {
    state.shared.lock().map_err(|e| e.to_string())?.dragging = dragging;
    Ok(())
}

/// One line per menu open with what triggered it, so a menu that opened by
/// itself would show up. Local only. Pointer facts, nothing about other apps.
#[tauri::command]
pub fn companion_log_menu(trigger: String, app: AppHandle) -> Result<(), String> {
    use std::io::Write;
    let clean: String = trigger
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || " =.,-_".contains(*c))
        .take(120)
        .collect();
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("parrot-menu.log"))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{} {}", crate::iso8601_utc(crate::now_millis()), clean).map_err(|e| e.to_string())
}

/// What the page reads at boot and on its slow backstop.
#[tauri::command]
pub fn companion_state(app: AppHandle, state: State<'_, CompanionState>) -> Result<World, String> {
    let world = state.shared.lock().map_err(|e| e.to_string())?.world;
    Ok(World { session_active: session_active(&app, world.session_active), ..world })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HITBOX: Hitbox = Hitbox { x: 100.0, y: 200.0, w: 96.0, h: 96.0 };

    #[test]
    fn the_cursor_hits_a_box_and_its_slack_only() {
        assert!(cursor_hits((150.0, 250.0), &[HITBOX]));
        assert!(cursor_hits((92.0, 200.0), &[HITBOX]));
        assert!(!cursor_hits((91.0, 200.0), &[HITBOX]));
        assert!(!cursor_hits((150.0, 305.0), &[HITBOX]));
        assert!(!cursor_hits((150.0, 250.0), &[]));
    }

    #[test]
    fn the_overlay_is_the_work_area() {
        let monitor = Fit { x: 0, y: 0, width: 1920, height: 1080 };
        let work = Fit { height: 1032, ..monitor };
        assert_eq!(overlay_fit(work, monitor), work);
        let left_taskbar = Fit { x: 62, width: 1858, ..monitor };
        assert_eq!(overlay_fit(left_taskbar, monitor), left_taskbar);
    }

    #[test]
    fn with_an_auto_hide_taskbar_it_stops_a_pixel_short() {
        let monitor = Fit { x: 0, y: 0, width: 1920, height: 1080 };
        let fit = overlay_fit(monitor, monitor);
        assert_eq!(fit, Fit { x: 0, y: 1, width: 1920, height: 1079 });
        assert_eq!(fit.y + fit.height as i32, 1080);
    }

    #[test]
    fn the_overlay_capability_reaches_nothing_else() {
        let nsis = include_str!("../capabilities/nsis/parrot.json");
        let store = include_str!("../capabilities/store/parrot.json");
        assert_eq!(nsis, store);
        let cap: serde_json::Value = serde_json::from_str(nsis).unwrap();
        assert_eq!(cap["windows"], serde_json::json!(["parrot"]));
        let mut granted: Vec<&str> =
            cap["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
        granted.sort_unstable();
        assert_eq!(
            granted,
            [
                "allow-companion-log-menu",
                "allow-companion-ready",
                "allow-companion-set-dragging",
                "allow-companion-set-hitbox",
                "allow-companion-state",
                "core:event:allow-emit-to",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
            ]
        );
    }

    #[test]
    fn the_world_the_page_sees_carries_no_names() {
        let json = serde_json::to_value(World::default()).unwrap();
        assert!(json.as_object().unwrap().values().all(|v| v.is_boolean()));
    }

    const MONITOR: ScreenRect = ScreenRect { left: 0, top: 0, right: 1920, bottom: 1080 };

    #[test]
    fn a_maximised_window_is_not_full_screen() {
        // Measured: Edge maximised with an auto-hide taskbar.
        let r = ScreenRect { left: -13, top: -13, right: 2893, bottom: 1813 };
        let monitor = ScreenRect { left: 0, top: 0, right: 2880, bottom: 1800 };
        assert!(covers_monitor(r, monitor));
        assert!(!is_fullscreen(r, monitor, true));
    }

    #[test]
    fn maximised_above_a_normal_taskbar_is_not_full_screen() {
        let r = ScreenRect { left: -8, top: -8, right: 1928, bottom: 1040 };
        assert!(!is_fullscreen(r, MONITOR, true));
    }

    #[test]
    fn f11_is_full_screen_though_flagged_maximised() {
        // Measured: Edge on F11 keeps WS_MAXIMIZE and fits the monitor exactly.
        assert!(is_fullscreen(MONITOR, MONITOR, true));
    }

    #[test]
    fn a_borderless_window_is_full_screen_with_or_without_overhang() {
        let over = ScreenRect { left: -8, top: -8, right: 1928, bottom: 1088 };
        assert!(is_fullscreen(MONITOR, MONITOR, false));
        assert!(is_fullscreen(over, MONITOR, false));
    }

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
