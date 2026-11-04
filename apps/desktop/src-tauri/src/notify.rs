//! Getting a warning in front of someone whose window is hidden. An in-app toast
//! in a hidden webview is never seen.

/// How a warning reaches the operator.
#[derive(Debug, PartialEq)]
pub enum Route {
    /// They're looking at the window, and the toast is enough.
    InApp,
    Notification,
    ShowWindow,
}

/// A notification only counts if Windows will actually show it. Do Not Disturb,
/// a full-screen app or notifications switched off for us would swallow it
/// without an error, and this warning is about losing unsaved typing.
pub fn route(window_focused: bool, windows_will_show_it: bool) -> Route {
    if window_focused {
        Route::InApp
    } else if windows_will_show_it {
        Route::Notification
    } else {
        Route::ShowWindow
    }
}

pub fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Try to show it. Err means show the window instead.
pub fn show_windows_notification(title: &str, body: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager};
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_ACCEPTS_NOTIFICATIONS};

    let state = unsafe { SHQueryUserNotificationState() }.map_err(|e| e.to_string())?;
    if state != QUNS_ACCEPTS_NOTIFICATIONS {
        return Err(format!("Windows isn't showing notifications now ({:?})", state));
    }
    // The Store package has its identity. The direct download's Start menu
    // shortcut carries this id (Get-StartApps lists it as com.lockin.app).
    let notifier = if cfg!(feature = "store") {
        ToastNotificationManager::CreateToastNotifier()
    } else {
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from("com.lockin.app"))
    }
    .map_err(|e| e.to_string())?;
    let setting = notifier.Setting().map_err(|e| e.to_string())?;
    if setting != NotificationSetting::Enabled {
        return Err(format!("notifications are off for Lock-In ({:?})", setting));
    }
    let xml = format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape_xml(title),
        escape_xml(body)
    );
    let doc = XmlDocument::new().map_err(|e| e.to_string())?;
    doc.LoadXml(&HSTRING::from(xml)).map_err(|e| e.to_string())?;
    let toast = ToastNotification::CreateToastNotification(&doc).map_err(|e| e.to_string())?;
    notifier.Show(&toast).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looking_at_the_window_the_toast_is_enough() {
        assert_eq!(route(true, true), Route::InApp);
        assert_eq!(route(true, false), Route::InApp);
    }

    #[test]
    fn hidden_it_notifies_and_falls_back_to_showing_the_window() {
        assert_eq!(route(false, true), Route::Notification);
        assert_eq!(route(false, false), Route::ShowWindow);
    }

    #[test]
    fn notification_text_cant_break_the_xml() {
        assert_eq!(escape_xml("you've <b> & \"x\""), "you&apos;ve &lt;b&gt; &amp; &quot;x&quot;");
    }
}
