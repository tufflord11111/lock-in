# Browser lockdown — Phase A (design only)

Written 3 Nov 2026 against `0998e51`, for after 1.2.9. **Nothing here is
implemented.** It builds on `docs/browser-blocking/PHASE_A.md` §2 (23 Oct,
"Layer 1") and changes it in two ways: a browser with a live Web Guard is allowed
even if it isn't Chrome, and closing is warned about first.

Anything not checked on a real machine or against a source is marked
**UNVERIFIED**.

§7 (v2) has been re-checked against
[WEB_BLOCKING_PLAN_26OCT.md](WEB_BLOCKING_PLAN_26OCT.md) and that plan's sources.
Only §7 was re-checked; the UNVERIFIED marks elsewhere stand.

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
says so plainly.** v2 might, but that's still unconfirmed (§7).

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

## 7. How v2 replaces it

Checked on 3 Nov 2026 against [WEB_BLOCKING_PLAN_26OCT.md](WEB_BLOCKING_PLAN_26OCT.md)
and the sources it lists. The plan describes itself as "docs say", not "tested", and
so does this section: no mark means **documented**, not that it works on a laptop.
**UNVERIFIED** means neither the plan's sources nor a check here support it.

Browser policies block at the browser and need no extension.

### What the sources back

| Claim | Basis |
|---|---|
| Edge: `SOFTWARE\Policies\Microsoft\Edge\URLBlocklist`, values `1, 2, 3…`, 1,000 entries, Windows 77+ | [Microsoft](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/urlblocklist), read directly |
| Firefox: `Software\Policies\Mozilla\Firefox\WebsiteFilter\Block\1`, or `policies.json`, 1,000 entries, since 60 | [Mozilla](https://firefox-admin-docs.mozilla.org/reference/policies/websitefilter/), read directly |
| Chrome: `Software\Policies\Google\Chrome\URLBlocklist`, values `1, 2, 3…`, 1,000 entries, Windows since 86, "Applied to browser without restart" | The plan's quotes of [Google's page](https://chromeenterprise.google/policies/#URLBlocklist). That page doesn't render for my fetch tool, so these are second-hand |
| Most policies work on home PCs; only a few protected ones need a managed machine | [Eric Lawrence](https://textslashplain.com/2022/03/22/edge-chrome-policy-registry-entries), read directly |
| Reload happens on restart, about every 15 min, Reload Policies, or a Group Policy notice. The registry watcher was backed out | Same page |
| WebView2 isn't covered: "The vast majority of Edge policies do not apply to the WebView2 control" | Same page. Plan §6 draws the same conclusion for Discord and Electron |

### What stays UNVERIFIED

| Claim | Why |
|---|---|
| `URLBlocklist` specifically isn't one of the protected policies | The plan says so. The page I read only gives the general rule. Check `chrome://policy` on a home PC |
| **Incognito, Guest and other profiles stop being holes** | The plan's table says "all profiles", but it quotes only "Applied at Chrome profile level", and its own spike step 3 still asks the question. No source I could read says it. **This is v2's main benefit, so it needs the spike before anything else** |
| Brave, Vivaldi and other Chromium builds read these policies, and at which keys | The plan lists them, but none of its sources mention either browser |
| `IncognitoModeAvailability`, `BrowserGuestModeEnabled` do what's needed | The plan names them. Their Google pages don't render for my tool, so only the first page's title is confirmed |
| `BrowserAddProfileEnabled` | **Mine, not in the plan.** My guess at its URL returned 404 |
| Chrome and Edge show "Managed by your organization" | Plan §6 states it, with no source |
| Opera, Opera GX, Arc and Tor ignore policy | The plan says "no evidence". Its [Opera link](https://forums.opera.com/post/9759) is an undated feature request, which suggests no support but doesn't establish it. Arc and Tor have no source. Closing them is the safe assumption either way |
| Firefox applies a change without a restart | Mozilla's page doesn't say. Spike step 6 |
| MSIX can write these keys | Plan §6 says it "may" be virtualised, and spike step 9 is untested. My earlier "likely NSIS only" and "much harder review" had no source, so treat them as opinion |

### Where the sources disagree with the plan or with this doc

1. **"HKCU: no admin" looks wrong.** The plan's table says it, and none of its sources
   do. On this PC, `HKCU\Software\Policies` grants the signed-in user `ReadKey` only;
   `FullControl` is for Administrators and SYSTEM, and this session's Administrators
   group is deny-only. So an unelevated Lock-In can't create these keys, and spike
   step 1's PowerShell should fail unless run elevated. I read the access rules and
   didn't attempt a write. It's one PC, on Windows 11 Home. If it holds, **every
   policy route needs admin**, and the plan's no-admin version doesn't exist.
2. **"Instant" isn't, for an open browser.** The plan's table says instant, but its §4
   calls reload timing the risk. "Without restart" doesn't say when: the only
   documented triggers are the ones above, so a running browser may take up to 15
   minutes.
   - At session start, the plan closes browsers once, which works around it.
   - **At session end nothing does, and the plan doesn't cover this.** Sites could
     stay blocked for up to 15 minutes after the session is over, which breaks "The
     session ends when the timer does". Spike step 4 measures it. The Group Policy
     notice may be the answer; nobody has tested it.
3. **Edge may skip the profile most home users have.** Microsoft's page says "Applies to
   a profile that is signed in with a Microsoft account: No". The plan quotes the two
   rows above it and omits this one. What it means on an unmanaged PC is unclear, so it
   goes in spike step 5.
4. **In-page navigation.** Microsoft: the policy "doesn't prevent the page from updating
   dynamically through JavaScript". A page already open can move to a blocked path
   without a reload. Whole-domain entries, which is what Lock-In uses, make this
   mostly harmless.

### What v2 costs

- **Admin.** HKLM needs it, and per point 1 above HKCU probably does too. That means a
  UAC prompt or an elevated service, and the plan notes this breaks the Store's
  "doesn't need admin rights" line.
- **A crash must not leave sites blocked for good.** My requirement, not the plan's: its
  step 5 only deletes the values at session end or when the fuse fires. Policies
  outlive the app, so they also need removing on next launch and on uninstall,
  including after End task. The FAQ's End task promise depends on this.
- **A second block page.** Policy-blocked pages show the browser's own page. The plan
  keeps the extension for a "nicer block page", no longer as the safety net.

### Migration

The plan's Web Shield maps onto v1 like this:

- Its Layer 2 kill list is this doc's exe table (§3), and it needs the same exact-match
  function. v1 work carries over.
- Lockdown's rule becomes "no policy support, so close", and the heartbeat stops deciding
  who gets closed. It stays for telling whether Web Guard is healthy.
- New at Start: write the policy, then close browsers once so they read it.

**Run the plan's spike (§7 there) before designing v2 further.** Steps 1, 3, 4 and 9
decide whether it's viable. Add the Microsoft-account profile to step 5.

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
8. **v2:** is admin elevation acceptable? On this PC even the HKCU policy key needs it
   (§7), which contradicts the plan's "HKCU: no admin". That, the Store's "doesn't need
   admin rights" line, and up to 15 minutes of blocking after a session ends decide
   whether v2 happens at all. Recommendation: run the plan's spike first.

**STOP. Phase A ends here.**
