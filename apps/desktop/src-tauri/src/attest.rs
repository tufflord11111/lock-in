//! Which process is on the other end of a loopback connection.
//!
//! A heartbeat's headers are whatever the sender typed: `curl -H "Origin:
//! chrome-extension://<Web Guard's id>"` passed every check heartbeat.rs had.
//! Windows knows who owns each TCP connection (GetExtendedTcpTable), so a beat
//! counts only when that process is the browser it claims to come from.
//!
//! Also here: each browser's instances (one top process per user-data-dir) and
//! how many windows each one has, for the per-instance check in coverage.rs.

use crate::browsers;
use crate::heartbeat::Attested;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use sysinfo::{Pid, ProcessRefreshKind, System, UpdateKind};

/// The PID owning the client end of an IPv4 loopback connection to `server`.
pub fn owning_pid(client: SocketAddr, server: SocketAddr) -> Option<u32> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows::Win32::Networking::WinSock::AF_INET;
    let (IpAddr::V4(cip), IpAddr::V4(sip)) = (client.ip(), server.ip()) else {
        return None;
    };
    let mut size = 0u32;
    unsafe {
        let _ = GetExtendedTcpTable(None, &mut size, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0);
    }
    if size == 0 {
        return None;
    }
    // Rows are u32s, so a u32 buffer keeps them aligned.
    let mut buf = vec![0u32; (size as usize).div_ceil(4) + 16];
    let mut len = (buf.len() * 4) as u32;
    let rc = unsafe {
        GetExtendedTcpTable(Some(buf.as_mut_ptr().cast()), &mut len, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0)
    };
    if rc != 0 {
        return None;
    }
    let table = unsafe { &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
    let rows: &[MIB_TCPROW_OWNER_PID] =
        unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
    // Addresses are in network byte order; ports in the low 16 bits, also network order.
    let port = |p: u32| u16::from_be((p & 0xffff) as u16);
    let addr = |a: u32| std::net::Ipv4Addr::from(u32::from_be(a));
    rows.iter()
        .find(|r| {
            port(r.dwLocalPort) == client.port()
                && addr(r.dwLocalAddr) == cip
                && port(r.dwRemotePort) == server.port()
                && addr(r.dwRemoteAddr) == sip
        })
        .map(|r| r.dwOwningPid)
}

/// The browser id of a process, from its own name and path.
fn browser_of(sys: &System, pid: u32) -> Option<&'static str> {
    let p = sys.process(Pid::from_u32(pid))?;
    let name = p.name().to_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name).to_string();
    let path = p.exe().map(|e| e.to_string_lossy().to_lowercase());
    browsers::identify(&stem, path.as_deref())
}

/// Climb from `pid` while the parent is the same browser. The top one is the
/// browser process of that instance: Chromium starts one per user-data-dir,
/// and every renderer, GPU and network process sits under it.
pub fn root_of(pid: u32, parent_of: &dyn Fn(u32) -> Option<u32>, browser_of: &dyn Fn(u32) -> Option<&'static str>) -> u32 {
    let Some(brand) = browser_of(pid) else { return pid };
    let mut at = pid;
    // A parent loop can't happen on Windows, but a reused PID could fake one.
    for _ in 0..16 {
        match parent_of(at) {
            Some(parent) if parent != at && browser_of(parent) == Some(brand) => at = parent,
            _ => break,
        }
    }
    at
}

fn refreshed() -> System {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessRefreshKind::new().with_exe(UpdateKind::OnlyIfNotSet));
    sys
}

/// Who owns this loopback connection, if it is a known browser.
pub fn who(client: SocketAddr, server: SocketAddr) -> Option<Attested> {
    let pid = owning_pid(client, server)?;
    let sys = refreshed();
    let browser = browser_of(&sys, pid)?;
    let parent_of = |p: u32| sys.process(Pid::from_u32(p)).and_then(|x| x.parent()).map(|x| x.as_u32());
    let brand_of = |p: u32| browser_of(&sys, p);
    Some(Attested { browser, root: root_of(pid, &parent_of, &brand_of) })
}

/// The instances (top processes) of each running browser, from a process list
/// already refreshed with exe paths.
pub fn instances(sys: &System) -> HashMap<&'static str, Vec<u32>> {
    let parent_of = |p: u32| sys.process(Pid::from_u32(p)).and_then(|x| x.parent()).map(|x| x.as_u32());
    let brand_of = |p: u32| browser_of(sys, p);
    let mut out: HashMap<&'static str, Vec<u32>> = HashMap::new();
    for pid in sys.processes().keys() {
        let pid = pid.as_u32();
        if let Some(brand) = brand_of(pid) {
            if root_of(pid, &parent_of, &brand_of) == pid {
                out.entry(brand).or_default().push(pid);
            }
        }
    }
    out
}

/// What Lock-In knows about one top-level window, read from Windows.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowFacts {
    pub visible: bool,
    pub title_len: i32,
    /// Has an owner window: bubbles, menus, dialogs, extension popups.
    pub owned: bool,
    pub style: u32,
    pub ex_style: u32,
    /// DWM cloaked: on another virtual desktop, or hidden by the shell.
    pub cloaked: bool,
    pub class: String,
}

/// Window styles (winuser.h).
pub const WS_POPUP: u32 = 0x8000_0000;
pub const WS_CAPTION: u32 = 0x00C0_0000;
pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_TOPMOST: u32 = 0x0000_0008;

/// Does this window count as one browser window, the way Web Guard counts?
///
/// Web Guard counts chrome.windows.getAll({windowTypes: ["normal", "popup",
/// "app", "devtools"]}) in its profile (plus Incognito when it's allowed
/// there): tabbed windows, window.open popups, installed web apps (PWAs) and
/// undocked DevTools, minimized or not. Each of those is a Chromium frame
/// window here: class Chrome_WidgetWin_1, unowned, titled, a captioned frame
/// (fullscreen drops the caption but isn't a popup). Everything else Chromium
/// draws is a WS_POPUP widget with no caption and/or an owner or always on
/// top: extension popups, the downloads and Cast bubbles, menus, the omnibox
/// list, picture in picture, the tab being dragged. System dialogs (print,
/// Save as) are class #32770. None of those count, so none can push this
/// count above a covered browser's check-ins. Leaving a real window out can
/// only miss a window, never close a covered browser.
pub fn counts_as_browser_window(w: &WindowFacts) -> bool {
    w.visible
        && w.title_len > 0
        && !w.owned
        && !w.cloaked
        && w.class == "Chrome_WidgetWin_1"
        && w.ex_style & (WS_EX_TOOLWINDOW | WS_EX_TOPMOST) == 0
        // A popup widget without a caption is a bubble, menu or overlay.
        && !(w.style & WS_POPUP != 0 && w.style & WS_CAPTION == 0)
}

/// Every top-level window with its owning process, read from Windows.
fn top_level_windows() -> Vec<(u32, WindowFacts)> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowThreadProcessId,
        IsWindowVisible, GWL_EXSTYLE, GWL_STYLE, GW_OWNER,
    };
    unsafe extern "system" fn add(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = unsafe { &mut *(lparam.0 as *mut Vec<(u32, WindowFacts)>) };
        unsafe {
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), 4);
            let mut class = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut class) as usize;
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            out.push((
                pid,
                WindowFacts {
                    visible: IsWindowVisible(hwnd).as_bool(),
                    title_len: GetWindowTextLengthW(hwnd),
                    owned: GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid()),
                    style: GetWindowLongW(hwnd, GWL_STYLE) as u32,
                    ex_style: GetWindowLongW(hwnd, GWL_EXSTYLE) as u32,
                    cloaked: cloaked != 0,
                    class: String::from_utf16_lossy(&class[..n]),
                },
            ));
        }
        BOOL(1)
    }
    let mut out = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(add), LPARAM(&mut out as *mut Vec<(u32, WindowFacts)> as isize));
    }
    out
}

/// Browser windows per process (counts_as_browser_window).
pub fn chromium_windows_by_pid() -> HashMap<u32, u32> {
    let mut counts = HashMap::new();
    for (pid, w) in top_level_windows() {
        if counts_as_browser_window(&w) {
            *counts.entry(pid).or_default() += 1;
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_root_is_the_top_process_of_the_same_browser() {
        // explorer(1) -> chrome(10) -> chrome(11, network) ; chrome(20, --user-data-dir) -> chrome(21)
        let parent = |p: u32| match p {
            10 => Some(1),
            11 => Some(10),
            20 => Some(1),
            21 => Some(20),
            30 => Some(10), // an editor Chrome started: not Chrome's
            _ => None,
        };
        let brand = |p: u32| match p {
            10 | 11 | 20 | 21 => Some("chrome"),
            _ => None,
        };
        assert_eq!(root_of(11, &parent, &brand), 10);
        assert_eq!(root_of(10, &parent, &brand), 10);
        assert_eq!(root_of(21, &parent, &brand), 20, "a second user-data-dir is its own instance");
        assert_eq!(root_of(30, &parent, &brand), 30);
    }

    #[test]
    fn a_connection_from_this_test_is_owned_by_this_test_not_a_browser() {
        use std::net::{TcpListener, TcpStream};
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let server = listener.local_addr().unwrap();
        let client = TcpStream::connect(server).unwrap();
        let (_accepted, peer) = listener.accept().unwrap();
        assert_eq!(peer, client.local_addr().unwrap());
        assert_eq!(owning_pid(peer, server), Some(std::process::id()));
        assert_eq!(who(peer, server), None, "the test runner isn't a browser");
    }

    // Styles below follow Chromium's HWNDMessageHandler: a browser frame is
    // WS_OVERLAPPEDWINDOW-like (caption + thick frame + system menu), a widget
    // that isn't a frame is WS_POPUP with no caption. Only the laptop proves
    // the live values (docs/1.3.1/LAPTOP_CHECKLIST.md).
    const FRAME: u32 = 0x00CF_0000 | 0x1000_0000; // WS_OVERLAPPEDWINDOW | WS_VISIBLE
    const MINIMIZED: u32 = FRAME | 0x2000_0000; // + WS_MINIMIZE
    const FULLSCREEN: u32 = 0x1000_0000; // caption and thick frame removed, not a popup
    const POPUP: u32 = WS_POPUP | 0x1000_0000;

    fn win(title: &str, style: u32, ex: u32, owned: bool, class: &str) -> WindowFacts {
        WindowFacts { visible: true, title_len: title.len() as i32, owned, style, ex_style: ex, cloaked: false, class: class.into() }
    }
    const CW: &str = "Chrome_WidgetWin_1";

    #[test]
    fn windows_web_guard_counts_are_counted_here_too() {
        // getAll's normal, popup, app and devtools windows: all Chromium frames.
        for (what, w) in [
            ("tabbed window", win("YouTube - Google Chrome", FRAME, 0, false, CW)),
            ("minimized window", win("Docs - Google Chrome", MINIMIZED, 0, false, CW)),
            ("fullscreen window", win("Video - Google Chrome", FULLSCREEN, 0, false, CW)),
            ("window.open popup", win("Sign in", FRAME, 0, false, CW)),
            ("installed web app (PWA), Chrome or Edge", win("Spotify", FRAME, 0, false, CW)),
            ("undocked DevTools", win("DevTools - example.com", FRAME, 0, false, CW)),
        ] {
            assert!(counts_as_browser_window(&w), "{what}");
        }
    }

    #[test]
    fn nothing_web_guard_leaves_out_is_counted_here() {
        for (what, w) in [
            ("extension popup (owned bubble)", win("Lock-In Web Guard", POPUP, 0, true, CW)),
            ("downloads bubble", win("Downloads", POPUP, 0, true, CW)),
            ("Cast dialog (bubble)", win("Cast", POPUP, 0, true, CW)),
            ("picture in picture", win("Picture in picture", POPUP, WS_EX_TOPMOST, false, CW)),
            ("document picture in picture", win("Meet", FRAME, WS_EX_TOPMOST, false, CW)),
            ("tab being dragged", win("New Tab", POPUP, WS_EX_TOPMOST | WS_EX_TOOLWINDOW, false, CW)),
            ("unowned popup widget, no caption (menu, overlay)", win("menu", POPUP, 0, false, CW)),
            ("system print dialog", win("Print", POPUP | WS_CAPTION, 0, true, "#32770")),
            ("Save as dialog", win("Save As", POPUP | WS_CAPTION, 0, true, "#32770")),
            ("Edge sidebar as a tool window", win("Copilot", FRAME, WS_EX_TOOLWINDOW, false, CW)),
            ("hidden window (startup boost)", WindowFacts { visible: false, ..win("Edge", FRAME, 0, false, CW) }),
            ("untitled helper", win("", FRAME, 0, false, CW)),
            ("another virtual desktop", WindowFacts { cloaked: true, ..win("Chrome", FRAME, 0, false, CW) }),
            ("not a Chromium window", win("Notepad", FRAME, 0, false, "Notepad")),
        ] {
            assert!(!counts_as_browser_window(&w), "{what}");
        }
    }

    #[test]
    fn a_covered_browser_with_every_extra_surface_open_is_still_covered() {
        // One tabbed window, a PWA and undocked DevTools: Web Guard counts 3.
        // Add every surface it doesn't count: the total here stays 3.
        let all = [
            win("Tab - Google Chrome", FRAME, 0, false, CW),
            win("Spotify", FRAME, 0, false, CW),
            win("DevTools - x", FRAME, 0, false, CW),
            win("Lock-In Web Guard", POPUP, 0, true, CW),
            win("Picture in picture", POPUP, WS_EX_TOPMOST, false, CW),
            win("Cast", POPUP, 0, true, CW),
            win("Print", POPUP | WS_CAPTION, 0, true, "#32770"),
            win("Save As", POPUP | WS_CAPTION, 0, true, "#32770"),
            win("Downloads", POPUP, 0, true, CW),
        ];
        let counted = all.iter().filter(|w| counts_as_browser_window(w)).count() as u32;
        assert_eq!(counted, 3);
        let beat = crate::heartbeat::Beat {
            at: 1_000, incognito_allowed: true, uid: Some("u1".into()), root: 10, profile: Some("p1".into()),
            windows: Some(3), locked: Some(true), host_access: Some(true), told_active: true, replied_active: true,
        };
        let v = crate::coverage::brand(&[crate::coverage::Instance { root: 10, windows: counted }], &[beat], Some("u1"), 2_000, 35_000);
        assert_eq!(v.gap, None);
    }
}

/// Diagnostic for the laptop checklist: `cargo test --lib -- --ignored
/// window_counts_on_this_pc --nocapture` prints, per running browser
/// instance, how many windows Lock-In counts. Counts only, no titles.
#[cfg(test)]
mod diagnostics {
    #[test]
    #[ignore]
    fn window_counts_on_this_pc() {
        let sys = super::refreshed();
        let counts = super::chromium_windows_by_pid();
        for (brand, roots) in super::instances(&sys) {
            for root in roots {
                println!("{brand} instance {root}: {} window(s) counted", counts.get(&root).copied().unwrap_or(0));
            }
        }
    }
}
