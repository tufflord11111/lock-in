//! Tray icon: the [•] mark, grey dot while idle, red dot while a session runs.
//!
//! Swapped only at session start (update_enforcement) and at every stand-down
//! (emit_stood_down). No polling: the taskbar theme is read once when the tray
//! is built and again at each swap, from a single HKCU registry value.

use tauri::image::Image;
use tauri::AppHandle;

/// The id the tray is built with in lib.rs.
pub const TRAY_ID: &str = "main";

const DARK_IDLE: &[u8] = include_bytes!("../icons/tray/dark-taskbar-idle.ico");
const DARK_LOCKED: &[u8] = include_bytes!("../icons/tray/dark-taskbar-locked.ico");
const LIGHT_IDLE: &[u8] = include_bytes!("../icons/tray/light-taskbar-idle.ico");
const LIGHT_LOCKED: &[u8] = include_bytes!("../icons/tray/light-taskbar-locked.ico");

/// True when the taskbar is light (ink brackets). Missing value or any read
/// failure means dark, the Windows default.
fn light_taskbar() -> bool {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: data/size point at a live u32 and its size; RRF_RT_REG_DWORD
    // makes the call fail rather than write anything that is not a DWORD.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("SystemUsesLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut core::ffi::c_void),
            Some(&mut size),
        )
    };
    status.is_ok() && data == 1
}

fn image(light: bool, locked: bool) -> Option<Image<'static>> {
    let bytes = match (light, locked) {
        (false, false) => DARK_IDLE,
        (false, true) => DARK_LOCKED,
        (true, false) => LIGHT_IDLE,
        (true, true) => LIGHT_LOCKED,
    };
    match Image::from_bytes(bytes) {
        Ok(img) => Some(img),
        Err(e) => {
            eprintln!("[Tray] icon decode failed: {}", e);
            None
        }
    }
}

/// The icon to build the tray with at startup.
pub fn initial(locked: bool) -> Option<Image<'static>> {
    image(light_taskbar(), locked)
}

/// Swap the tray to idle or locked. Never blocks: callers hold the profile
/// mutex, and TrayIcon::set_icon waits on the main thread, which may itself be
/// waiting on that mutex. So the swap is posted and runs on the main thread.
/// Before the tray exists (restore at startup) this is a no-op; the tray is
/// then built from `initial`.
pub fn set_locked(app: &AppHandle, locked: bool) {
    let light = light_taskbar();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Some(img)) = (handle.tray_by_id(TRAY_ID), image(light, locked)) {
            if let Err(e) = tray.set_icon(Some(img)) {
                eprintln!("[Tray] set_icon failed: {}", e);
            }
        }
    });
}
