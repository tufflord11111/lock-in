//! The browsers lockdown knows, by exact process name.
//!
//! Never by substring, which is what the blocklist's kill pass uses: "msedge" would
//! hit msedgewebview2, which is Lock-In's own window as well as Teams and Outlook;
//! "tor" would hit editor and monitor; "arc" would hit search and archive.
//!
//! Verified on the build PC (HKLM StartMenuInternet, 4 Nov 2026): chrome, msedge,
//! and Opera GX as opera.exe under "Opera GX". The rest come from each browser's
//! usual install and are checked in the laptop test where that browser exists.
//!
//! Lockdown closes every browser here that has no live Web Guard heartbeat, and only
//! Chrome, Edge, Brave and Firefox can send one (heartbeat.rs), so the others are
//! always closed during a session that blocks sites. A name that is a common word
//! (browser, dragon, epic, iron, zen, mercury) only counts inside its own folder.

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
    Browser { id: "chromium", name: "Chromium" },
    Browser { id: "yandex", name: "Yandex Browser" },
    Browser { id: "cent", name: "Cent Browser" },
    Browser { id: "thorium", name: "Thorium" },
    Browser { id: "slimjet", name: "Slimjet" },
    Browser { id: "maxthon", name: "Maxthon" },
    Browser { id: "iron", name: "SRWare Iron" },
    Browser { id: "dragon", name: "Comodo Dragon" },
    Browser { id: "epic", name: "Epic Privacy Browser" },
    Browser { id: "avast", name: "Avast Secure Browser" },
    Browser { id: "avg", name: "AVG Secure Browser" },
    Browser { id: "ccleaner", name: "CCleaner Browser" },
    Browser { id: "duckduckgo", name: "DuckDuckGo" },
    Browser { id: "floorp", name: "Floorp" },
    Browser { id: "zen", name: "Zen Browser" },
    Browser { id: "mercury", name: "Mercury" },
    Browser { id: "palemoon", name: "Pale Moon" },
    Browser { id: "basilisk", name: "Basilisk" },
    Browser { id: "seamonkey", name: "SeaMonkey" },
    Browser { id: "ie", name: "Internet Explorer" },
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
        // Chromium builds and Cent Browser ship their own chrome.exe.
        "chrome" if under("\\chromium\\") => Some("chromium"),
        "chrome" if under("\\centbrowser\\") => Some("cent"),
        "chrome" => Some("chrome"),
        "msedge" => Some("edge"),
        "brave" => Some("brave"),
        "vivaldi" => Some("vivaldi"),
        "opera" => Some(opera()),
        "launcher" if under("\\opera") => Some(opera()),
        "opera_gx_splash" => Some("opera_gx"),
        "arc" => Some("arc"),
        // Tor Browser's browser process is firefox.exe.
        "firefox" => Some(if under("\\tor browser\\") { "tor" } else { "firefox" }),
        "tor" if under("\\tor browser\\") => Some("tor"),
        "librewolf" => Some("librewolf"),
        "waterfox" => Some("waterfox"),
        "whale" => Some("whale"),
        "chromium" => Some("chromium"),
        "browser" if under("\\yandex\\") => Some("yandex"),
        "thorium" => Some("thorium"),
        "slimjet" => Some("slimjet"),
        "maxthon" => Some("maxthon"),
        "iron" if under("\\srware iron\\") => Some("iron"),
        "dragon" if under("\\comodo\\") => Some("dragon"),
        "epic" if under("\\epic privacy browser\\") => Some("epic"),
        "avastbrowser" => Some("avast"),
        "avgbrowser" => Some("avg"),
        "ccleanerbrowser" => Some("ccleaner"),
        "duckduckgo" => Some("duckduckgo"),
        "floorp" => Some("floorp"),
        "zen" if under("\\zen browser\\") => Some("zen"),
        "mercury" if under("\\mercury\\") => Some("mercury"),
        "palemoon" => Some("palemoon"),
        "basilisk" => Some("basilisk"),
        "seamonkey" => Some("seamonkey"),
        "iexplore" => Some("ie"),
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

    /// Every browser exe lockdown must catch, where its installer puts it.
    const EXES: &[(&str, &str, &str)] = &[
        ("chrome", "c:\\program files\\google\\chrome\\application\\chrome.exe", "chrome"),
        ("msedge", "c:\\program files (x86)\\microsoft\\edge\\application\\msedge.exe", "edge"),
        ("brave", "c:\\program files\\bravesoftware\\brave-browser\\application\\brave.exe", "brave"),
        ("vivaldi", "c:\\users\\c\\appdata\\local\\vivaldi\\application\\vivaldi.exe", "vivaldi"),
        ("opera", "c:\\users\\c\\appdata\\local\\programs\\opera\\opera.exe", "opera"),
        ("opera", "c:\\users\\c\\appdata\\local\\programs\\opera gx\\opera.exe", "opera_gx"),
        ("launcher", "c:\\users\\c\\appdata\\local\\programs\\opera gx\\launcher.exe", "opera_gx"),
        ("opera_gx_splash", "c:\\users\\c\\appdata\\local\\programs\\opera gx\\opera_gx_splash.exe", "opera_gx"),
        ("arc", "c:\\program files\\windowsapps\\thebrowsercompany.arc_1.0\\arc.exe", "arc"),
        ("firefox", "c:\\program files\\mozilla firefox\\firefox.exe", "firefox"),
        ("firefox", "c:\\users\\c\\desktop\\tor browser\\browser\\firefox.exe", "tor"),
        ("librewolf", "c:\\program files\\librewolf\\librewolf.exe", "librewolf"),
        ("waterfox", "c:\\program files\\waterfox\\waterfox.exe", "waterfox"),
        ("whale", "c:\\program files\\naver\\naver whale\\application\\whale.exe", "whale"),
        ("chrome", "c:\\users\\c\\appdata\\local\\chromium\\application\\chrome.exe", "chromium"),
        ("chromium", "c:\\tools\\ungoogled\\chromium.exe", "chromium"),
        ("browser", "c:\\users\\c\\appdata\\local\\yandex\\yandexbrowser\\application\\browser.exe", "yandex"),
        ("chrome", "c:\\users\\c\\appdata\\local\\centbrowser\\application\\chrome.exe", "cent"),
        ("thorium", "c:\\users\\c\\appdata\\local\\thorium\\application\\thorium.exe", "thorium"),
        ("slimjet", "c:\\program files\\slimjet\\slimjet.exe", "slimjet"),
        ("maxthon", "c:\\users\\c\\appdata\\local\\maxthon\\application\\maxthon.exe", "maxthon"),
        ("iron", "c:\\program files\\srware iron\\iron.exe", "iron"),
        ("dragon", "c:\\program files\\comodo\\dragon\\dragon.exe", "dragon"),
        ("epic", "c:\\users\\c\\appdata\\local\\epic privacy browser\\application\\epic.exe", "epic"),
        ("avastbrowser", "c:\\program files\\avast software\\browser\\application\\avastbrowser.exe", "avast"),
        ("avgbrowser", "c:\\program files\\avg\\browser\\application\\avgbrowser.exe", "avg"),
        ("ccleanerbrowser", "c:\\program files\\ccleaner browser\\application\\ccleanerbrowser.exe", "ccleaner"),
        ("duckduckgo", "c:\\program files\\windowsapps\\duckduckgo.desktopbrowser_1.0\\duckduckgo.exe", "duckduckgo"),
        ("floorp", "c:\\program files\\ablaze floorp\\floorp.exe", "floorp"),
        ("zen", "c:\\program files\\zen browser\\zen.exe", "zen"),
        ("mercury", "c:\\program files\\mercury\\mercury.exe", "mercury"),
        ("palemoon", "c:\\program files\\pale moon\\palemoon.exe", "palemoon"),
        ("basilisk", "c:\\program files\\basilisk\\basilisk.exe", "basilisk"),
        ("seamonkey", "c:\\program files\\seamonkey\\seamonkey.exe", "seamonkey"),
        ("iexplore", "c:\\program files\\internet explorer\\iexplore.exe", "ie"),
    ];

    #[test]
    fn every_browser_exe_is_caught_where_its_installer_puts_it() {
        for (stem, path, id) in EXES {
            assert_eq!(identify(stem, Some(path)), Some(*id), "{} at {}", stem, path);
            assert!(KNOWN.iter().any(|b| b.id == *id), "{} has no name", id);
        }
        // And every browser in the table has an exe that's caught.
        for b in KNOWN {
            assert!(EXES.iter().any(|(_, _, id)| *id == b.id), "{} has no exe in the test", b.id);
        }
    }

    #[test]
    fn a_common_word_only_counts_in_its_own_folder() {
        for stem in ["browser", "dragon", "epic", "iron", "zen", "mercury"] {
            assert_eq!(identify(stem, Some("c:\\program files\\something\\x.exe")), None, "{}", stem);
            assert_eq!(identify(stem, None), None, "{}", stem);
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
