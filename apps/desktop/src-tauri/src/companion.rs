//! The parrot overlay's native side.
//!
//! Read-only geometry and timestamps only: no hooks, no window titles or process names
//! read. The one thing it writes outside this process is the no-activate style on
//! WebView2's own child windows. The session state comes from the enforcer's existing
//! profile, read and never written.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::CheckMenuItem;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Wry,
};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, IsWindowEnabled, LASTINPUTINFO};
use windows::Win32::UI::Shell::{
    DefSubclassProc, RemoveWindowSubclass, SHQueryUserNotificationState, SetWindowSubclass, QUNS_PRESENTATION_MODE,
    QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetAncestor, GetForegroundWindow, GetShellWindow, GetSystemMetrics, GetWindowLongPtrW,
    GetWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed,
    KillTimer, PostMessageW, SetForegroundWindow, SetTimer, SetWindowLongPtrW, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, GW_HWNDNEXT,
    MA_NOACTIVATE, SM_CMONITORS, STYLESTRUCT, SWP_NOACTIVATE, WINDOWPOS, WM_ACTIVATE, WM_APP, WM_MOUSEACTIVATE,
    WM_NCDESTROY, WM_STYLECHANGING, WM_TIMER, WM_WINDOWPOSCHANGING, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
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

/// What full screen needs to know about a window. No title, no process name.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Seen<M> {
    rect: ScreenRect,
    zoomed: bool,
    monitor: M,
}

/// Whether a full-screen window is on the bird's monitor. Windows reports a running
/// game or presentation for the whole machine and doesn't say where, so that only
/// decides it when there is one monitor. Otherwise the windows themselves do: the
/// foreground one, and the one on top at the monitor's centre, which is still the
/// slideshow while you work in presenter view on another monitor.
fn bird_is_covered<M: PartialEq + Copy>(
    system_says_full_screen: bool,
    monitor_count: i32,
    foreground: Option<Seen<M>>,
    on_top_at_centre: Option<Seen<M>>,
    bird_monitor: M,
    bird_monitor_rect: ScreenRect,
) -> bool {
    if system_says_full_screen && monitor_count <= 1 {
        return true;
    }
    [foreground, on_top_at_centre]
        .into_iter()
        .flatten()
        .any(|w| w.monitor == bird_monitor && is_fullscreen(w.rect, bird_monitor_rect, w.zoomed))
}

/// A click-through or never-activated window sits over the screen without being what's
/// on it: a glow, a capture frame, an indicator. Measured: Claude's overlay is exactly
/// screen-sized and not maximised, like an F11 window, and only these bits differ.
fn is_passive_overlay(ex_style: u32) -> bool {
    ex_style & (WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0) != 0
}

/// Neither the desktop, nor our own windows, nor one Windows has cloaked (a suspended
/// app, another virtual desktop), nor a passive overlay count; told apart by process id
/// and flag.
unsafe fn seen(window: HWND) -> Option<Seen<HMONITOR>> {
    if window.is_invalid() {
        return None;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(window, Some(&mut pid));
    let mut shell_pid = 0u32;
    GetWindowThreadProcessId(GetShellWindow(), Some(&mut shell_pid));
    if pid == std::process::id() || pid == shell_pid {
        return None;
    }
    if is_passive_overlay(GetWindowLongPtrW(window, GWL_EXSTYLE) as u32) {
        return None;
    }
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(window, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, size_of::<u32>() as u32).is_ok()
        && cloaked != 0
    {
        return None;
    }
    let mut rect = RECT::default();
    GetWindowRect(window, &mut rect).ok()?;
    Some(Seen {
        rect: rect.into(),
        zoomed: IsZoomed(window).as_bool(),
        monitor: MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST),
    })
}

/// Whether something full screen is on the monitor this overlay is on.
fn fullscreen_on_birds_monitor(overlay: &WebviewWindow) -> bool {
    let Ok(overlay) = overlay.hwnd() else { return false };
    unsafe {
        let system_says_full_screen = SHQueryUserNotificationState()
            .is_ok_and(|state| state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE);
        let bird_monitor = MonitorFromWindow(HWND(overlay.0), MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(bird_monitor, &mut info).as_bool() {
            return false;
        }
        let m = info.rcMonitor;
        let centre = POINT { x: m.left + (m.right - m.left) / 2, y: m.top + (m.bottom - m.top) / 2 };
        bird_is_covered(
            system_says_full_screen,
            GetSystemMetrics(SM_CMONITORS),
            seen(GetForegroundWindow()),
            seen(GetAncestor(WindowFromPoint(centre), GA_ROOT)),
            bird_monitor,
            m.into(),
        )
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

/// While perched: a cursor in the fade zone (the bird and the branch, grown by 120 CSS px,
/// sent by the page) fades both and makes the bird click-through, so whatever is under
/// them at the screen's edge can be used. Back after the cursor has been out of the zone
/// FADE_AWAY_MS. Resting still on the faded bird for FADE_HOLD_MS brings it back solid,
/// to be picked up, until the cursor leaves the zone. Never during a drag. Decided on the
/// hit-test's own polls, so no hooks.
const FADE_AWAY_MS: u64 = 1_000;
const FADE_HOLD_MS: u64 = 500;
/// How far the cursor may wander between polls and still count as resting, physical px.
const FADE_STILL_PX: f64 = 3.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Fade {
    faded: bool,
    /// Rested on the bird: solid and clickable until the cursor leaves the zone.
    held: bool,
    /// Since when the cursor has been out of the zone, faded.
    away_since: Option<u64>,
    /// Since when it has rested on the faded bird.
    still_since: Option<u64>,
    last: Option<(f64, f64)>,
}

fn inside(cursor: (f64, f64), b: &Hitbox) -> bool {
    cursor.0 >= b.x && cursor.0 <= b.x + b.w && cursor.1 >= b.y && cursor.1 <= b.y + b.h
}

/// One poll's step. `zone` is None unless the bird is perched; `bird` is its box.
fn step_fade(f: Fade, now_ms: u64, cursor: (f64, f64), zone: Option<Hitbox>, bird: Option<Hitbox>, dragging: bool) -> Fade {
    let Some(zone) = zone.filter(|_| !dragging) else { return Fade::default() };
    let near = inside(cursor, &zone);
    let rested = f.last.is_some_and(|l| (l.0 - cursor.0).hypot(l.1 - cursor.1) <= FADE_STILL_PX);
    let last = Some(cursor);
    if f.held {
        return if near { Fade { last, ..f } } else { Fade { last, ..Fade::default() } };
    }
    if !f.faded {
        return if near { Fade { faded: true, last, ..Fade::default() } } else { Fade { last, ..Fade::default() } };
    }
    if !near {
        let away_since = f.away_since.unwrap_or(now_ms);
        if now_ms - away_since >= FADE_AWAY_MS {
            return Fade { last, ..Fade::default() };
        }
        return Fade { away_since: Some(away_since), still_since: None, last, ..f };
    }
    let on_bird = bird.is_some_and(|b| cursor_hits(cursor, &[b]));
    if on_bird && rested {
        let still_since = f.still_since.unwrap_or(now_ms);
        if now_ms - still_since >= FADE_HOLD_MS {
            return Fade { held: true, last, ..Fade::default() };
        }
        return Fade { away_since: None, still_since: Some(still_since), last, ..f };
    }
    Fade { away_since: None, still_since: None, last, ..f }
}

/// The bird and the cards take the cursor where they are, unless faded; a drag always does.
fn takes_cursor(cursor: (f64, f64), boxes: &[Hitbox], faded: bool, dragging: bool) -> bool {
    dragging || (!faded && cursor_hits(cursor, boxes))
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
    /// When the running session is due to end, to tell finishing from stopping early.
    session_end_at: Option<u64>,
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
    /// The page's fade zone while the bird is perched.
    fade_zone: Option<Hitbox>,
    dragging: bool,
    world: World,
}

/// Its own managed state: nothing here shares a lock with the enforcer.
#[derive(Default)]
pub struct CompanionState {
    shared: Mutex<Shared>,
    wake: Condvar,
    tray_item: Mutex<Option<CheckMenuItem<Wry>>>,
}

pub const TRAY_ITEM_ID: &str = "parrot";

/// The tray's "Show parrot". Ticked only while the bird exists.
pub fn tray_item(app: &AppHandle) -> tauri::Result<CheckMenuItem<Wry>> {
    let item = CheckMenuItem::with_id(app, TRAY_ITEM_ID, "Show parrot", true, false, None::<&str>)?;
    let state = app.state::<CompanionState>();
    *state.tray_item.lock().unwrap_or_else(|e| e.into_inner()) = Some(item.clone());
    Ok(item)
}

/// The tray flips the account's setting, as the Block Registry toggle does. Main owns
/// that write and works while hidden; it answers through companion_set_enabled, which
/// sets the tick. The bird's existence decides, so a tick that Windows flipped on the
/// click can't send the wrong answer.
pub fn tray_item_clicked(app: &AppHandle) {
    let enabled = app.get_webview_window(LABEL).is_none();
    let _ = app.emit_to("main", "companion:tray-toggle", enabled);
}

fn sync_tray_item(state: &CompanionState, enabled: bool) {
    let item = state.tray_item.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(item) = item {
        let _ = item.set_checked(enabled);
    }
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

/// The overlay's extended style, whatever else is being set: never activated, and a
/// tool window, so Windows has no reason to hand it the focus when another window
/// closes. APPWINDOW would ask for the opposite.
fn overlay_ex_style(ex: u32) -> u32 {
    (ex | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0
}

const SUBCLASS_ID: usize = 1;
const GIVE_FOCUS_BACK: u32 = WM_APP + 1;
const GIVE_BACK_TIMER: usize = 1;
/// The page normally says when the interaction ended. Regardless, after this long.
const GIVE_BACK_FALLBACK_MS: u32 = 1_500;
static FOCUS_CAME_FROM: AtomicIsize = AtomicIsize::new(0);
static AWAITING_GIVE_BACK: AtomicBool = AtomicBool::new(false);
static DRAGGING: AtomicBool = AtomicBool::new(false);

/// Runs before tao's own window procedure. Setting the style once wouldn't last: tao
/// rewrites all of it whenever click-through toggles. It also shows and restores with
/// calls that activate, and a click on the webview asks to activate too.
unsafe extern "system" fn never_activate(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match message {
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        // Windows still activates it after a click, with main in front: WebView2's input
        // windows belong to the browser process, whose input queue is attached to this
        // thread, and nothing here can stop that. Giving the focus back during the press
        // would cancel the webview's pointer capture: a drag stops dead and a button never
        // gets its click. So it waits for the page to say the interaction ended.
        WM_ACTIVATE if wparam.0 & 0xFFFF != 0 => {
            // lParam is the window being deactivated, captured now. It can be null.
            if !AWAITING_GIVE_BACK.swap(true, Ordering::Relaxed) {
                FOCUS_CAME_FROM.store(lparam.0, Ordering::Relaxed);
            }
            let _ = SetTimer(Some(window), GIVE_BACK_TIMER, GIVE_BACK_FALLBACK_MS, None);
            // A named window that can no longer take focus was just hidden or closed, and
            // Windows handed activation to us. Nobody is pressing the bird, so don't wait.
            if lparam.0 != 0 && !window_can_take_focus(HWND(lparam.0 as *mut _)) {
                let _ = PostMessageW(Some(window), GIVE_FOCUS_BACK, WPARAM(0), LPARAM(0));
            }
        }
        // Someone else took it: it isn't ours to give back any more.
        WM_ACTIVATE => {
            AWAITING_GIVE_BACK.store(false, Ordering::Relaxed);
            let _ = KillTimer(Some(window), GIVE_BACK_TIMER);
        }
        GIVE_FOCUS_BACK => {
            give_focus_back(window);
            return LRESULT(0);
        }
        WM_TIMER if wparam.0 == GIVE_BACK_TIMER => {
            // A long drag outlasts the fallback. The page's own word, not the mouse's state.
            if DRAGGING.load(Ordering::Relaxed) {
                let _ = SetTimer(Some(window), GIVE_BACK_TIMER, GIVE_BACK_FALLBACK_MS, None);
            } else {
                give_focus_back(window);
            }
            return LRESULT(0);
        }
        WM_STYLECHANGING if wparam.0 as i32 == GWL_EXSTYLE.0 => {
            let change = &mut *(lparam.0 as *mut STYLESTRUCT);
            change.styleNew = overlay_ex_style(change.styleNew);
        }
        WM_WINDOWPOSCHANGING => {
            let position = &mut *(lparam.0 as *mut WINDOWPOS);
            position.flags |= SWP_NOACTIVATE;
        }
        WM_NCDESTROY => {
            let _ = RemoveWindowSubclass(window, Some(never_activate), SUBCLASS_ID);
        }
        _ => {}
    }
    DefSubclassProc(window, message, wparam, lparam)
}

/// Must run on the thread that owns the window. Only ever our own overlay.
fn keep_from_activating(window: &WebviewWindow) -> tauri::Result<()> {
    let overlay = window.clone();
    window.run_on_main_thread(move || {
        let Ok(hwnd) = overlay.hwnd() else { return };
        let hwnd = HWND(hwnd.0);
        unsafe {
            let _ = SetWindowSubclass(hwnd, Some(never_activate), SUBCLASS_ID, 0);
            // Goes through the subclass, which corrects it.
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
        }
    })
}

/// WebView2's child windows stand between the click and the overlay, so the overlay's
/// own WM_MOUSEACTIVATE answer never gets a say: measured, it isn't even called, and the
/// root comes up WA_CLICKACTIVE. With the no-activate style on the children that stops.
/// The ones in the browser process can't be subclassed, so they only get the style. Only
/// this overlay's descendants.
unsafe extern "system" fn child_never_activates(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match message {
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_NCDESTROY => {
            let _ = RemoveWindowSubclass(window, Some(child_never_activates), SUBCLASS_ID);
        }
        _ => {}
    }
    DefSubclassProc(window, message, wparam, lparam)
}

unsafe extern "system" fn harden_child(child: HWND, _: LPARAM) -> BOOL {
    let ex = GetWindowLongPtrW(child, GWL_EXSTYLE);
    if ex & WS_EX_NOACTIVATE.0 as isize == 0 {
        SetWindowLongPtrW(child, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize);
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(child, Some(&mut pid));
    if pid == std::process::id() {
        let _ = SetWindowSubclass(child, Some(child_never_activates), SUBCLASS_ID, 0);
    }
    BOOL(1)
}

/// The children exist only once the webview does, so this runs when the page says it
/// has painted. Must run on the thread that owns the overlay.
fn keep_children_from_activating(window: &WebviewWindow) {
    let overlay = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(hwnd) = overlay.hwnd() else { return };
        unsafe {
            let _ = EnumChildWindows(Some(HWND(hwnd.0)), Some(harden_child), LPARAM(0));
        }
    });
}

/// Whether a window can take the focus back: what Windows itself looks for when the
/// active window closes. Pure, so it can be tested.
fn can_take_focus(visible: bool, minimized: bool, cloaked: bool, enabled: bool, ex_style: u32) -> bool {
    visible
        && !minimized
        && !cloaked
        && enabled
        && ex_style & WS_EX_NOACTIVATE.0 == 0
        && ex_style & WS_EX_TOOLWINDOW.0 == 0
}

unsafe fn window_can_take_focus(window: HWND) -> bool {
    if window.is_invalid() || !IsWindow(Some(window)).as_bool() {
        return false;
    }
    let mut cloaked = 0u32;
    let is_cloaked = DwmGetWindowAttribute(window, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, size_of::<u32>() as u32).is_ok()
        && cloaked != 0;
    can_take_focus(
        IsWindowVisible(window).as_bool(),
        IsIconic(window).as_bool(),
        is_cloaked,
        IsWindowEnabled(window).as_bool(),
        GetWindowLongPtrW(window, GWL_EXSTYLE) as u32,
    )
}

unsafe fn is_ours(window: HWND) -> bool {
    let mut pid = 0u32;
    GetWindowThreadProcessId(window, Some(&mut pid));
    pid == std::process::id()
}

/// The next window down from the overlay that could take the focus and isn't this
/// app's, as Windows would pick when the active window closes.
unsafe fn next_down(overlay: HWND) -> Option<HWND> {
    let mut next = GetWindow(overlay, GW_HWNDNEXT).ok();
    while let Some(window) = next {
        if !is_ours(window) && window_can_take_focus(window) {
            return Some(window);
        }
        next = GetWindow(window, GW_HWNDNEXT).ok();
    }
    None
}

/// Back to the window WM_ACTIVATE named when the overlay took the focus. If Windows named
/// none, or it has gone, hidden, minimised or been cloaked since, the next one down.
unsafe fn give_focus_back(overlay: HWND) {
    let _ = KillTimer(Some(overlay), GIVE_BACK_TIMER);
    if !AWAITING_GIVE_BACK.swap(false, Ordering::Relaxed) {
        return;
    }
    let previous = HWND(FOCUS_CAME_FROM.load(Ordering::Relaxed) as *mut _);
    let target = if previous != overlay && window_can_take_focus(previous) { Some(previous) } else { next_down(overlay) };
    if let Some(window) = target {
        let _ = SetForegroundWindow(window);
    }
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
    keep_from_activating(&window)?;
    window.set_ignore_cursor_events(true)?;
    if let Some(fit) = primary_fit(app) {
        apply_fit(&window, fit);
    }
    Ok(())
}

/// Reads the session from the enforcer's profile. Never blocks it: if the lock
/// is busy, this poll keeps what it last saw.
fn session_read(app: &AppHandle, previous: World) -> (bool, Option<u64>) {
    app.try_state::<crate::AppState>()
        .and_then(|s| s.profile.try_lock().ok().map(|p| (p.armed(), p.session_end_time)))
        .unwrap_or((previous.session_active, previous.session_end_at))
}

fn run(app: AppHandle) {
    let state = app.state::<CompanionState>();
    let mut shown = false;
    let mut ignoring = true;
    let mut clear_polls = 0u8;
    let mut next_poll = Instant::now();
    let mut fit: Option<Fit> = None;
    let mut fade = Fade::default();
    let started = Instant::now();
    #[cfg(debug_assertions)]
    let mut last_probe = Instant::now();

    loop {
        {
            let mut shared = state.shared.lock().unwrap_or_else(|e| e.into_inner());
            if !shared.active {
                shown = false;
                ignoring = true;
                clear_polls = 0;
                fit = None;
                fade = Fade::default();
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
            let over_fullscreen = fullscreen_on_birds_monitor(&window);
            clear_polls = if over_fullscreen { 0 } else { clear_polls.saturating_add(1) };
            let (session_active, session_end_at) = session_read(&app, previous);
            let world = World {
                session_active,
                session_end_at,
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
                let at = (cursor.x - f.x as f64, cursor.y - f.y as f64);
                let inside = {
                    let shared = state.shared.lock().unwrap_or_else(|e| e.into_inner());
                    let now_ms = started.elapsed().as_millis() as u64;
                    let next = step_fade(fade, now_ms, at, shared.fade_zone, shared.hitboxes.first().copied(), shared.dragging);
                    let changed = next.faded != fade.faded;
                    fade = next;
                    if changed {
                        let _ = app.emit_to(LABEL, "parrot-fade", fade.faded);
                    }
                    takes_cursor(at, &shared.hitboxes, fade.faded, shared.dragging)
                };
                if ignoring == inside {
                    let _ = window.set_ignore_cursor_events(!inside);
                    ignoring = !inside;
                    #[cfg(debug_assertions)]
                    debug_log(&app, if inside { "rust clickthrough off (cursor on the bird)" } else { "rust clickthrough on" });
                }
                // Debug builds, PARROT_PROBE_TOGGLE=1: the same toggle every 10 s, only while nobody
                // has touched the mouse or keyboard for 5 s, clickable for 150 ms.
                #[cfg(debug_assertions)]
                if ignoring
                    && std::env::var("PARROT_PROBE_TOGGLE").as_deref() == Ok("1")
                    && user_idle_ms() > 5_000
                    && last_probe.elapsed() >= Duration::from_secs(10)
                {
                    last_probe = Instant::now();
                    debug_log(&app, "rust probe clickthrough off");
                    let _ = window.set_ignore_cursor_events(false);
                    thread::sleep(Duration::from_millis(150));
                    let _ = window.set_ignore_cursor_events(true);
                    debug_log(&app, "rust probe clickthrough on");
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
        sync_tray_item(&state, enabled);
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
    sync_tray_item(&state, enabled);
    Ok(())
}

/// Main only: Start 25 needs the window after all.
#[tauri::command]
pub fn companion_show_main(app: AppHandle) {
    crate::show_main_window(&app);
}

/// The page has painted its first frame.
#[tauri::command]
pub fn companion_ready(app: AppHandle, state: State<'_, CompanionState>) -> Result<(), String> {
    state.shared.lock().map_err(|e| e.to_string())?.page_ready = true;
    if let Some(window) = app.get_webview_window(LABEL) {
        keep_children_from_activating(&window);
    }
    Ok(())
}

/// The bird's box first, then any cards. `fade` is the fade zone, only while perched.
#[tauri::command]
pub fn companion_set_hitbox(boxes: Vec<Hitbox>, fade: Option<Hitbox>, state: State<'_, CompanionState>) -> Result<(), String> {
    let mut shared = state.shared.lock().map_err(|e| e.to_string())?;
    shared.hitboxes = boxes;
    shared.hitboxes.truncate(MAX_HITBOXES);
    shared.fade_zone = fade;
    Ok(())
}

/// Pins the overlay clickable, or a fast drag outruns the 10 Hz hit-test.
#[tauri::command]
pub fn companion_set_dragging(dragging: bool, state: State<'_, CompanionState>) -> Result<(), String> {
    DRAGGING.store(dragging, Ordering::Relaxed);
    state.shared.lock().map_err(|e| e.to_string())?.dragging = dragging;
    Ok(())
}

/// The page's word that a press on the overlay is over: pointer up or cancelled, a drag
/// ended, or a menu or bubble action done. Carries nothing, and does nothing unless the
/// overlay is holding the focus.
#[tauri::command]
pub fn companion_interaction_ended(app: AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        let _ = PostMessageW(Some(HWND(hwnd.0)), GIVE_FOCUS_BACK, WPARAM(0), LPARAM(0));
    }
}

/// One line per menu open with what triggered it, so a menu that opened by
/// itself would show up. Local only. Pointer facts, nothing about other apps.
/// Debug builds only: a release build has no such command and writes no such file.
#[cfg(debug_assertions)]
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

/// Debug builds only: lines from the page's frame check, appended to parrot-debug.log
/// with the time they arrived. Local only; a release build has no such command.
#[cfg(debug_assertions)]
#[tauri::command]
pub fn companion_debug_log(lines: Vec<String>, app: AppHandle) -> Result<(), String> {
    for line in lines.iter().take(200) {
        debug_log(&app, line);
    }
    Ok(())
}

#[cfg(debug_assertions)]
fn debug_log(app: &AppHandle, line: &str) {
    use std::io::Write;
    let clean: String = line.chars().filter(|c| !c.is_control()).take(300).collect();
    let Ok(dir) = app.path().app_data_dir() else { return };
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("parrot-debug.log")) {
        let _ = writeln!(file, "{} {}", crate::now_millis(), clean);
    }
}

/// What the page reads at boot and on its slow backstop.
#[tauri::command]
pub fn companion_state(app: AppHandle, state: State<'_, CompanionState>) -> Result<World, String> {
    let world = state.shared.lock().map_err(|e| e.to_string())?.world;
    let (session_active, session_end_at) = session_read(&app, world);
    Ok(World { session_active, session_end_at, ..world })
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

    const ZONE: Hitbox = Hitbox { x: 1000.0, y: 300.0, w: 500.0, h: 400.0 };
    const BIRD_BOX: Hitbox = Hitbox { x: 1250.0, y: 450.0, w: 168.0, h: 152.0 };
    const AT_NEAR: (f64, f64) = (1100.0, 350.0);
    const AT_BIRD: (f64, f64) = (1300.0, 500.0);
    const AT_FAR: (f64, f64) = (200.0, 200.0);

    fn poll(f: Fade, t: u64, at: (f64, f64)) -> Fade {
        step_fade(f, t, at, Some(ZONE), Some(BIRD_BOX), false)
    }

    #[test]
    fn a_cursor_near_the_perched_bird_fades_it_at_once_and_makes_it_click_through() {
        let f = poll(Fade::default(), 0, AT_FAR);
        assert!(!f.faded);
        let f = poll(f, 100, AT_NEAR);
        assert!(f.faded);
        // Faded, even the bird's own box lets the click through.
        assert!(!takes_cursor(AT_BIRD, &[BIRD_BOX], f.faded, false));
        assert!(takes_cursor(AT_BIRD, &[BIRD_BOX], false, false));
    }

    #[test]
    fn it_comes_back_after_the_cursor_has_been_away_a_second() {
        let mut f = poll(Fade::default(), 0, AT_NEAR);
        f = poll(f, 100, AT_FAR);
        for t in (200..1_100).step_by(100) {
            f = poll(f, t, AT_FAR);
            assert!(f.faded, "still faded at {t} ms");
        }
        f = poll(f, 1_100, AT_FAR);
        assert!(!f.faded);
    }

    #[test]
    fn coming_back_near_within_the_second_starts_the_wait_again() {
        let mut f = poll(Fade::default(), 0, AT_NEAR);
        f = poll(f, 100, AT_FAR);
        f = poll(f, 900, AT_NEAR);
        f = poll(f, 1_000, AT_FAR);
        f = poll(f, 1_500, AT_FAR);
        assert!(f.faded);
        f = poll(f, 2_000, AT_FAR);
        assert!(!f.faded);
    }

    #[test]
    fn resting_on_the_faded_bird_half_a_second_brings_it_back_to_be_picked_up() {
        let mut f = poll(Fade::default(), 0, AT_NEAR);
        f = poll(f, 100, AT_BIRD);
        // Resting from the poll at 200 ms, when it was where it had been at 100 ms.
        for t in (200..700).step_by(100) {
            f = poll(f, t, AT_BIRD);
            assert!(f.faded, "still faded at {t} ms");
        }
        f = poll(f, 700, AT_BIRD);
        assert!(!f.faded && f.held);
        assert!(takes_cursor(AT_BIRD, &[BIRD_BOX], f.faded, false));
        // Held while the cursor stays near; out of the zone it is ready to fade again.
        f = poll(f, 800, AT_NEAR);
        assert!(!f.faded && f.held);
        f = poll(f, 900, AT_FAR);
        assert!(!f.held);
        assert!(poll(f, 1_000, AT_NEAR).faded);
    }

    #[test]
    fn moving_over_the_bird_is_not_resting_on_it() {
        let mut f = poll(Fade::default(), 0, AT_NEAR);
        for (i, t) in (100..2_000).step_by(100).enumerate() {
            f = poll(f, t, (AT_BIRD.0 + (i % 2) as f64 * 10.0, AT_BIRD.1));
        }
        assert!(f.faded && !f.held);
    }

    #[test]
    fn no_fade_unless_perched_and_never_during_a_drag() {
        let f = poll(Fade::default(), 0, AT_NEAR);
        assert!(!step_fade(f, 100, AT_NEAR, None, Some(BIRD_BOX), false).faded);
        assert!(!step_fade(f, 100, AT_NEAR, Some(ZONE), Some(BIRD_BOX), true).faded);
        assert!(takes_cursor(AT_FAR, &[BIRD_BOX], true, true));
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
    fn the_overlay_style_can_never_be_activated_or_ask_for_the_taskbar() {
        // Measured: what tao sets, with click-through on.
        let ex = overlay_ex_style(0x080C_0138);
        assert_eq!(ex & WS_EX_NOACTIVATE.0, WS_EX_NOACTIVATE.0);
        assert_eq!(ex & WS_EX_TOOLWINDOW.0, WS_EX_TOOLWINDOW.0);
        assert_eq!(ex & WS_EX_APPWINDOW.0, 0);
        // Everything else tao set is left alone: transparent, layered, topmost.
        assert_eq!(ex, 0x0808_01B8);
    }

    #[test]
    fn focus_only_goes_back_to_a_window_that_can_take_it() {
        let normal = 0x0000_0100;
        assert!(can_take_focus(true, false, false, true, normal));
        assert!(!can_take_focus(false, false, false, true, normal), "hidden");
        assert!(!can_take_focus(true, true, false, true, normal), "minimised");
        assert!(!can_take_focus(true, false, true, true, normal), "cloaked");
        assert!(!can_take_focus(true, false, false, false, normal), "disabled");
        assert!(!can_take_focus(true, false, false, true, WS_EX_TOOLWINDOW.0), "tool window");
        assert!(!can_take_focus(true, false, false, true, WS_EX_NOACTIVATE.0), "never activated");
    }

    #[test]
    fn the_overlay_style_survives_tao_rewriting_it() {
        assert_eq!(overlay_ex_style(0), WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0);
        assert_eq!(overlay_ex_style(overlay_ex_style(0x080C_0138)), overlay_ex_style(0x080C_0138));
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
                "allow-companion-debug-log",
                "allow-companion-interaction-ended",
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
        let world = World { session_end_at: Some(5), ..World::default() };
        let json = serde_json::to_value(world).unwrap();
        assert!(json.as_object().unwrap().values().all(|v| v.is_boolean() || v.is_number()));
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

        const BIRD: u8 = 1;
    const OTHER: u8 = 2;
    const ON_BIRD: Seen<u8> = Seen { rect: MONITOR, zoomed: false, monitor: BIRD };
    const ON_OTHER: Seen<u8> = Seen { rect: MONITOR, zoomed: false, monitor: OTHER };
    const SMALL_ON_BIRD: Seen<u8> =
        Seen { rect: ScreenRect { left: 100, top: 100, right: 900, bottom: 700 }, zoomed: false, monitor: BIRD };

    fn covered(system: bool, count: i32, foreground: Option<Seen<u8>>, at_centre: Option<Seen<u8>>) -> bool {
        bird_is_covered(system, count, foreground, at_centre, BIRD, MONITOR)
    }

    #[test]
    fn full_screen_on_the_birds_monitor_hides_it() {
        assert!(covered(false, 2, Some(ON_BIRD), Some(ON_BIRD)));
    }

    #[test]
    fn full_screen_on_another_monitor_does_not() {
        assert!(!covered(false, 2, Some(ON_OTHER), Some(SMALL_ON_BIRD)));
        assert!(!covered(false, 2, Some(ON_OTHER), None));
    }

    #[test]
    fn a_game_or_slideshow_on_another_monitor_does_not_with_focus_on_either() {
        assert!(!covered(true, 2, Some(ON_OTHER), Some(SMALL_ON_BIRD)));
        assert!(!covered(true, 2, Some(SMALL_ON_BIRD), Some(SMALL_ON_BIRD)));
    }

    #[test]
    fn a_slideshow_here_stays_hidden_with_focus_on_the_other_monitor() {
        assert!(covered(true, 2, Some(ON_OTHER), Some(ON_BIRD)));
        assert!(covered(false, 2, Some(ON_OTHER), Some(ON_BIRD)));
    }

    #[test]
    fn with_one_monitor_windows_saying_so_is_enough() {
        assert!(covered(true, 1, None, None));
        assert!(covered(true, 1, Some(SMALL_ON_BIRD), None));
    }

    #[test]
    fn nothing_full_screen_leaves_it_visible() {
        assert!(!covered(false, 1, Some(SMALL_ON_BIRD), Some(SMALL_ON_BIRD)));
        assert!(!covered(false, 1, None, None));
    }

    #[test]
    fn a_maximised_window_on_the_birds_monitor_leaves_it_visible() {
        let maximised = Seen { rect: ScreenRect { left: -8, top: -8, right: 1928, bottom: 1088 }, zoomed: true, monitor: BIRD };
        assert!(!covered(false, 2, Some(maximised), Some(maximised)));
    }

    /// Measured on a 2880x1800 screen: (ex style, rect, maximised).
    const SCREEN: ScreenRect = ScreenRect { left: 0, top: 0, right: 2880, bottom: 1800 };
    const OVERHANG: ScreenRect = ScreenRect { left: -13, top: -13, right: 2893, bottom: 1813 };

    #[test]
    fn claudes_screen_sized_overlay_is_not_full_screen() {
        assert!(is_passive_overlay(0x0828_0028));
        // The geometry alone says full screen, which is the bug the style check fixes.
        assert!(is_fullscreen(SCREEN, SCREEN, false));
    }

    #[test]
    fn claudes_maximised_window_is_not_full_screen() {
        assert!(!is_passive_overlay(0x0028_0108));
        assert!(!is_fullscreen(OVERHANG, SCREEN, true));
    }

    #[test]
    fn a_maximised_browser_is_not_full_screen() {
        assert!(!is_passive_overlay(0x0020_0100));
        assert!(!is_fullscreen(OVERHANG, SCREEN, true));
    }

    #[test]
    fn a_browser_in_full_screen_and_a_slideshow_still_are() {
        for ex in [0x0020_0000, 0x0000_0000] {
            assert!(!is_passive_overlay(ex));
            assert!(is_fullscreen(SCREEN, SCREEN, false));
        }
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
