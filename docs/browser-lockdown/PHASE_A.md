# Browser lockdown — Phase A (design only)

Written 3 Nov 2026 against `0998e51`, for after 1.2.9. **Nothing here is
implemented.** It builds on `docs/browser-blocking/PHASE_A.md` §2 (23 Oct,
"Layer 1") and changes it in two ways: a browser with a live Web Guard is allowed
even if it isn't Chrome, and closing is warned about first.

Anything not checked on a real machine or against a source is marked
**UNVERIFIED**.

**Missing input:** the brief cites a "26 Oct web-blocking plan" for v2. Nothing
under `C:\dev` mentions `URLBlocklist` or `WebsiteFilter`, and the only 26 Oct
doc is the parrot design. §7 is written from what I know of those policies and is
**UNVERIFIED** throughout. If that plan exists elsewhere, §7 should be redone
against it.

---

## 1. The rule

While a session that blocks websites is running **and the operator chose
lockdown**:

- A known browser with a fresh Web Guard heartbeat **on this PC** keeps running.
- Every other known browser gets a 10 s warning toast, then is closed.
- Relaunches are closed again for the rest of the session.

It stops when the session stops. Apps-only sessions never trigger it.

Lockdown is switched on by the third button in the 1.2.9 soft gate, "Start and
close other browsers", which is hidden until this ships. **Note the gap this
leaves:** the gate only appears when Web Guard is quiet. With Web Guard healthy in
Chrome and Firefox also open, nothing would ask. See decision 1.

## 2. How the heartbeat identifies the browser

Today's signal can't do this. `users/{uid}/extension_state/last_seen` is one
value per **account**: no browser name, and a Chrome on another PC keeps this
desktop "not stale" (`docs/1.2.9/PHASE_A.md` §5).

### Naming the browser

The extension already runs in each Chromium browser it's installed in. It reads,
in its service worker:

| Browser | Signal | Status |
|---|---|---|
| Chrome | `navigator.userAgentData.brands` has "Google Chrome" | UNVERIFIED in a worker |
| Edge | brands has "Microsoft Edge" | UNVERIFIED |
| Opera / GX | brands has "Opera" / "Opera GX" | UNVERIFIED |
| Brave | brands has "Brave" on recent versions; older ones show only "Chromium". `navigator.brave` is the fallback | UNVERIFIED |
| Vivaldi, Arc | Report plain "Chromium" | UNVERIFIED |

A browser that can't be named reports `chromium`, which allows nothing. It's
treated as no heartbeat. Being wrongly closed is the safe failure here, and the
copy says so (§6).

### Tying it to this PC

The heartbeat has to prove it came from this machine. Options:

| | How | Cost |
|---|---|---|
| **A. Loopback (recommended)** | Rust listens on `127.0.0.1:<fixed port>`. The extension POSTs `{browser, version, installId, incognitoAllowed}` every 30 s and on `onStartup`. `<all_urls>` already covers it, so no new permission | A local listener. Must accept only `Origin: chrome-extension://<our ids>` and do nothing but record the beat. Chrome's Local Network Access rules for extensions are UNVERIFIED |
| B. Native messaging | Chrome starts a host we register | `nativeMessaging` is a new install warning, which **disables the extension on update until re-approved**. MSIX registry writes are virtualised, so the browser wouldn't find the host without a restricted capability |
| C. Firebase key per browser | `extension_state/browsers/{installId}` | Still can't tell which PC, and needs a connection |

A also works offline, and C doesn't. Under C an offline session would have to
close every browser or none. The existing `last_seen` write stays for the soft
gate, or moves to A in the same release (decision 2).

**Rust side:** an in-memory `HashMap<browser, last_beat>`, not persisted and not
synced. Fresh means under 60 s old, matching `useExtensionPresence`.

**Other users of the PC:** any extension on the machine could spoof a beat, but
only to keep a browser open, on the operator's own PC. Accepted.

## 3. The exe list

### Exact match only

**`kill_processes_matching` is a substring test (`lib.rs`), and it can't be reused
for this.** Under it:

- `msedge` matches `msedgewebview2`: **Lock-In's own webview**, and Teams, Outlook
  and Widgets.
- `arc` matches `search…` and `archive…`.
- `tor` matches `editor`, `monitor`, `vector`.
- `opera` matches `operagxsetup`.

Lockdown needs its own function: exact stem, plus a path check where a stem is
generic. It must also refuse anything in `protected_process_names()`.

| Browser | Stem | Extra check | Status |
|---|---|---|---|
| Chrome | `chrome` | — | verified on this PC (23 Oct) |
| Edge | `msedge` | Never `msedgewebview2` or `msedge_proxy` | verified on this PC |
| Firefox | `firefox` | — | UNVERIFIED |
| Tor Browser | `firefox` + `tor` | Tor Browser's browser process is `firefox.exe`, so it's closed with Firefox. `tor` needs a path containing `Tor Browser` | UNVERIFIED |
| Brave | `brave` | — | UNVERIFIED |
| Opera / Opera GX | `opera` | Same stem: told apart by path (`opera_gx` folder), and `launcher` only with a path under `\Opera`. **Never `launcher` alone** | UNVERIFIED |
| Vivaldi | `vivaldi` | — | UNVERIFIED |
| Arc | `arc` | Exact stem only, packaged under `WindowsApps` | UNVERIFIED |

Before Phase B, each UNVERIFIED row is confirmed on a machine that has that
browser, from `HKLM:\SOFTWARE\Clients\StartMenuInternet` and Task Manager.

Path checks need `exe` in the process refresh. Today's `ProcessRefreshKind::new()`
collects names and pids only, so this adds a little cost, only on ticks with
lockdown on. To be measured.

**Not listed:** Electron apps, WebView2 hosts and lesser browsers (LibreWolf,
Waterfox, Whale are in the 23 Oct list; decision 3). A browser not on the list is
simply open, and the FAQ says so.

## 4. Enforcement

It doesn't touch the G1 approved set, for the reason in the 23 Oct doc §2.2: this
is a property of the session, never a blocklist entry. Nothing syncs and nothing
is staged.

- **State:** `browser_lockdown: bool` in `LockProfile`, set by a new
  `update_enforcement` argument, cleared on every stand-down, persisted so a
  restart keeps it. Never set from remote.
- **Where:** a pass in the existing 2 s sniper loop, no new thread.
- **Per browser, per session:**

  | State | Meaning | Next |
  |---|---|---|
  | Allowed | Fresh beat | If the beat goes stale: Warned |
  | Warned | Seen with no fresh beat; toast sent, 10 s clock running | Beat arrives: Allowed. 10 s pass: close |
  | Closed once | Has been closed this session | Relaunch with no beat within 5 s: closed again, no new 10 s |

- **Why 10 s is also the grace period:** a browser that has just launched hasn't
  beaten yet. Without this, a browser with Web Guard installed could never start.
  The extension must beat on `onStartup`, so 10 s should be plenty. UNVERIFIED on
  slow machines.
- **Why relaunches get 5 s rather than 10:** a fresh 10 s each time would be usable
  browsing in 10 s slices, by relaunching forever.
- **Mid-session staleness:** one missed beat isn't enough, because stale means
  60 s. A browser whose extension is disabled mid-session is warned then, not
  instantly.
- **How it closes:** `WM_CLOSE` to the main window first, then `TerminateProcess`
  after 2 s. `process.kill()` alone loses typed text and interrupts downloads (23
  Oct doc §2.4).
- **Sleep:** the 10 s clock reads the wall clock, so waking counts as time passed.
  The clock restarts after a wake, using the 1.2.9 gap detection, or nobody gets a
  warning they could read.

### The toast has to reach a hidden window

**In-app toasts don't work for this.** Since tray mode the window is usually
hidden, and a toast in a hidden webview is never seen. Options:

- Native Windows notification (`tauri-plugin-notification`). Works in MSIX.
  Unpackaged NSIS needs an AppUserModelID shortcut (UNVERIFIED that Tauri's NSIS
  sets it).
- Show the main window. Steals focus mid-typing, but impossible to miss.

Recommendation: notification, and fall back to showing the window if it fails
(decision 4).

Text: "Closing Firefox in 10 seconds. Save anything you've typed. Lock-In can't
block sites in it during this session."

## 5. Store / MSIX differences

| | NSIS | MSIX |
|---|---|---|
| Closing other apps | Already ships | Already ships. Per the 23 Oct doc §4.2–4.3, no policy clause forbids it, and it is acceptable on the same footing as app blocking |
| Disclosure | Good practice | **Required by 10.1.1:** first-run experience and listing must say browsers are force-closed. Re-read the policy before submitting; not re-fetched for this doc |
| Reading another process's path | Works | Should work for same-user processes. UNVERIFIED for browsers themselves packaged under `WindowsApps` |
| Loopback listener | Fine | Full-trust apps aren't under AppContainer loopback isolation. UNVERIFIED at runtime. May need a firewall consideration on first listen; 127.0.0.1 normally doesn't prompt |
| Notification | Needs AUMID | Works from package identity |
| Capabilities | One new `allow-` command per folder | Same. No manifest change expected |

No UI Automation in either build, so 10.2.8 isn't touched. This is what Layer 2 in
the 23 Oct doc would have hit.

## 6. The gaps, and FAQ copy

**Incognito.** Extensions don't run there unless the user allows it.
`chrome.extension.isAllowedIncognitoAccess()` tells us whether it's on, with no new
permission, and goes in the beat. Then:

- Off: tell the operator in the gate, and optionally treat that browser as having
  no heartbeat (decision 5).
- The desktop can't see Ctrl+Shift+N. A process's `--incognito` flag only shows a
  launch with that flag.

**Other profiles and Guest.** Extensions are per profile. A beat from Profile A
allows `chrome.exe`, and Profile B and Guest then browse free in the same process
tree. `--profile-directory` is on the command line of some launches, but profile
switching inside the browser leaves no reliable trace. **v1 can't close this. It
says so plainly.** Only v2 can (§7).

**Other holes:** unlisted browsers, renamed or portable exes, and another PC. All
are accepted in v1.

**FAQ copy (site):**

> **Does it block every browser?**
> Lock-In blocks sites through Web Guard, its browser extension. If you start a
> session with browser lockdown, browsers without a working Web Guard get a 10
> second warning and are then closed, and closed again if they reopen. Anything
> you've typed and not sent in them is lost, so save first.
>
> It isn't airtight. A browser Lock-In doesn't know about stays open. Incognito is
> only covered if you've allowed Web Guard there. A second Chrome profile or a
> Guest window without Web Guard isn't blocked. We'd rather tell you that than
> promise otherwise.

**Gate button:** "Start and close other browsers", with the line "Browsers without
Web Guard close after a 10 second warning. Unsaved typing in them is lost."

## 7. How v2 replaces it (UNVERIFIED; see the note at the top)

Browser policies block at the browser, in every profile, and need no extension:

| Browser | Policy | Where |
|---|---|---|
| Chrome, Brave | `URLBlocklist` | `HKLM\SOFTWARE\Policies\Google\Chrome\URLBlocklist`; Brave has its own key |
| Edge | `URLBlocklist` | `HKLM\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist` |
| Firefox | `WebsiteFilter` | `HKLM\SOFTWARE\Policies\Mozilla\Firefox\WebsiteFilter`, or `policies.json` |
| Gaps | `IncognitoModeAvailability`, `BrowserGuestModeEnabled`, `BrowserAddProfileEnabled` | Same keys |

What changes:

- Incognito, other profiles and Guest stop being holes, because policy applies to
  all of them.
- Lockdown shrinks to browsers with no policy support, and the heartbeat stops
  deciding who gets closed.

What it costs, and why this isn't simply v1:

- **HKLM needs admin.** That means a UAC prompt or an elevated helper, which is a
  big change for an app that installs per-user with no admin rights.
- **A crash must not leave sites blocked for good.** Policies outlive the app. The
  list needs removing on stand-down, on next launch, and on uninstall, including
  after an End task. An FAQ promise depends on this.
- **MSIX:** registry writes are virtualised, and HKLM policy from a Store app with a
  helper is a much harder review. Likely NSIS only, which splits the product.
- Browsers show "Managed by your organization" while a policy is set. The copy must
  warn about that.
- Whether Chrome honours these on non-domain-joined home PCs is to be confirmed.

Migration: v1's exe table, gate button and toast carry over. The heartbeat stays
for telling whether Web Guard is healthy. Lockdown's rule becomes "no policy
support, so close".

## 8. Tests (before Phase B ships)

1. Verify every UNVERIFIED row in §2 and §3 on a machine with that browser.
2. Session with lockdown, Edge with Web Guard and Firefox open: Firefox warned and
   closed at 10 s, Edge untouched. Lock-In's own window and Teams unaffected.
3. Relaunch Firefox: closed within about 5 s, with no new 10 s.
4. Launch Chrome with Web Guard during a session: it stays open.
5. Disable Web Guard mid-session: warned after about 60 s, then closed.
6. Window hidden in the tray: the warning is still seen.
7. Sleep through the 10 s: the warning restarts on wake.
8. Offline: the browser with Web Guard stays open.
9. A blocked-apps-only or apps-only session: no browser touched.
10. Session ends: lockdown stops, nothing else closed. MSIX: repeat 2–6.

## 9. Decisions for Cayden

1. **When is lockdown offered?** The gate only appears when Web Guard is quiet. With
   it healthy in Chrome and Firefox open, nothing asks. Recommendation: also offer it
   at Start whenever another known browser is running.
2. **Heartbeat channel.** Loopback (recommended), or Firebase with no way to tell
   which PC. Loopback adds a local listener.
3. **The exe list.** Your list, or also LibreWolf, Waterfox and Whale from the 23 Oct
   doc? And **Chrome with no heartbeat:** your list names Brave and Edge but not
   Chrome. I've treated it the same as them; say if Chrome should be exempt.
4. **Warning channel when hidden:** native notification with window fallback
   (recommended), or always show the window.
5. **Web Guard installed but Incognito not allowed.** Allow the browser and warn
   (recommended), or treat it as no heartbeat and close it? The second is stricter
   and will close a lot of people's main browser.
6. **Hard close after the soft attempt.** Recommendation: `WM_CLOSE`, then force after
   2 s. Force-only is simpler and loses more typed work.
7. **Web Store listings.** Edge Add-ons has its own listing and extension id, and the
   origin check needs all of them. List on Edge, or rely on Edge's "allow extensions
   from other stores" setting?
8. **v2:** is admin elevation and an NSIS/Store split acceptable? That decides whether
   v2 happens at all. Also, please point me at the 26 Oct plan if it exists.

**STOP. Phase A ends here.**
