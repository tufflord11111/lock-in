//! The browsers lockdown knows, by exact process name.
//!
//! Never by substring, which is what the blocklist's kill pass uses: "msedge" would
//! hit msedgewebview2, which is Lock-In's own window as well as Teams and Outlook;
//! "tor" would hit editor and monitor; "arc" would hit search and archive.
//!
//! Verified on the build PC (HKLM StartMenuInternet, 4 Nov 2026): chrome, msedge,
//! and Opera GX as opera.exe under "Opera GX". The rest come from each browser's
//! usual install and are checked in the laptop test where that browser exists.

pub struct Browser {
    pub id: &'static str,
    pub name: &'static str,
}

pub const KNOWN: &[Browser] = &[
    Browser { id: "chrome", name: "Chrome" },
    Browser { id: "edge", name: "Edge" },
    Browser { id: "brave", name: "Brave" },
    Browser { id: "vivaldi", name: "Vivaldi" },
    Browser { id: "opera", name: "Opera" },
    Browser { id: "opera_gx", name: "Opera GX" },
    Browser { id: "arc", name: "Arc" },
    Browser { id: "firefox", name: "Firefox" },
    Browser { id: "tor", name: "Tor Browser" },
    Browser { id: "librewolf", name: "LibreWolf" },
    Browser { id: "waterfox", name: "Waterfox" },
    Browser { id: "whale", name: "Whale" },
];

pub fn name_of(id: &str) -> &'static str {
    KNOWN.iter().find(|b| b.id == id).map_or("this browser", |b| b.name)
}

/// Which known browser this process is, if any. `stem` is the lowercased file name
/// without .exe, `path` the lowercased full path if it could be read. A name that
/// could belong to anything only counts with a path that proves it.
pub fn identify(stem: &str, path: Option<&str>) -> Option<&'static str> {
    let under = |folder: &str| path.map_or(false, |p| p.contains(folder));
    let opera = || if under("\\opera gx\\") { "opera_gx" } else { "opera" };
    match stem {
        "chrome" => Some("chrome"),
        "msedge" => Some("edge"),
        "brave" => Some("brave"),
        "vivaldi" => Some("vivaldi"),
        "opera" => Some(opera()),
        "launcher" if under("\\opera") => Some(opera()),
        "arc" => Some("arc"),
        // Tor Browser's browser process is firefox.exe.
        "firefox" => Some(if under("\\tor browser\\") { "tor" } else { "firefox" }),
        "tor" if under("\\tor browser\\") => Some("tor"),
        "librewolf" => Some("librewolf"),
        "waterfox" => Some("waterfox"),
        "whale" => Some("whale"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_identified_browser_is_in_the_table() {
        for stem in ["chrome", "msedge", "brave", "vivaldi", "opera", "arc", "firefox", "librewolf", "waterfox", "whale"] {
            let id = identify(stem, None).unwrap();
            assert!(KNOWN.iter().any(|b| b.id == id), "{}", id);
        }
    }

    #[test]
    fn names_that_only_contain_a_browser_never_match() {
        for stem in [
            "msedgewebview2", "msedge_proxy", "msedgeupdate", "editor", "monitor", "vector",
            "tortoisegit", "search", "archive", "arcgis", "operagxsetup", "chromedriver",
            "firefoxsetup", "bravesoftware", "whalesong", "app", "lock-in",
        ] {
            assert_eq!(identify(stem, Some("c:\\program files\\x\\y.exe")), None, "{}", stem);
            assert_eq!(identify(stem, None), None, "{}", stem);
        }
    }

    #[test]
    fn opera_and_opera_gx_are_told_apart_by_folder() {
        let gx = "c:\\users\\c\\appdata\\local\\programs\\opera gx\\opera.exe";
        let plain = "c:\\users\\c\\appdata\\local\\programs\\opera\\opera.exe";
        assert_eq!(identify("opera", Some(gx)), Some("opera_gx"));
        assert_eq!(identify("opera", Some(plain)), Some("opera"));
    }

    #[test]
    fn a_generic_launcher_is_only_operas_inside_operas_folder() {
        assert_eq!(identify("launcher", Some("c:\\games\\launcher.exe")), None);
        assert_eq!(identify("launcher", None), None);
        let gx = "c:\\users\\c\\appdata\\local\\programs\\opera gx\\launcher.exe";
        assert_eq!(identify("launcher", Some(gx)), Some("opera_gx"));
    }

    #[test]
    fn tor_browser_is_told_apart_from_firefox_and_from_any_other_tor() {
        let tor = "c:\\users\\c\\desktop\\tor browser\\browser\\firefox.exe";
        assert_eq!(identify("firefox", Some(tor)), Some("tor"));
        assert_eq!(identify("firefox", Some("c:\\program files\\mozilla firefox\\firefox.exe")), Some("firefox"));
        assert_eq!(identify("tor", Some("c:\\users\\c\\desktop\\tor browser\\browser\\torbrowser\\tor\\tor.exe")), Some("tor"));
        assert_eq!(identify("tor", Some("c:\\tools\\tor.exe")), None);
        assert_eq!(identify("tor", None), None);
    }
}
