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

/// Browser windows per process: visible, titled, top-level windows that
/// nothing owns, of the class every Chromium browser window has. Left out:
/// tool windows, always-on-top ones (picture in picture) and cloaked ones
/// (another virtual desktop). Leaving one out can only miss a window, never
/// close a browser that Web Guard fully covers.
pub fn chromium_windows_by_pid() -> HashMap<u32, u32> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowThreadProcessId,
        IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    };
    unsafe extern "system" fn add(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let counts = unsafe { &mut *(lparam.0 as *mut HashMap<u32, u32>) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
                return BOOL(1);
            }
            if GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid()) {
                return BOOL(1);
            }
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if ex & (WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0) != 0 {
                return BOOL(1);
            }
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), 4);
            if cloaked != 0 {
                return BOOL(1);
            }
            let mut class = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut class) as usize;
            if String::from_utf16_lossy(&class[..n]) != "Chrome_WidgetWin_1" {
                return BOOL(1);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            *counts.entry(pid).or_default() += 1;
        }
        BOOL(1)
    }
    let mut counts = HashMap::new();
    unsafe {
        let _ = EnumWindows(Some(add), LPARAM(&mut counts as *mut HashMap<u32, u32> as isize));
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
}
