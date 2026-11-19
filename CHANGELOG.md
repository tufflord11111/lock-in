# Changelog

## [1.3.1] — unreleased

How a session works, unchanged and now harder to get round:
- No pause button. Bail out ends a session early, and voids the whole session.
- Bail out takes five minutes, and your blocks stay on until then.
- One bail-out a day.
- Closing the window doesn't end a session. Lock-In stays in the tray and picks the session back up when reopened.
- Sessions of 45 minutes or more take a two-second hold to start.

Lock-In is still an ordinary Windows app: End task or uninstalling stops it.

Changes:
- Fixed: a program on this PC could pretend to be Web Guard and keep a browser open. Lock-In now checks with Windows that each Web Guard check-in really comes from that browser.
- Fixed: a Guest window, a second browser profile, or a browser started with its own profile folder stayed open without Web Guard. Lock-In now checks each one; a window Web Guard can't see gets the usual 10-second warning, and the browser closes.
- Browsers whose Web Guard isn't allowed in Incognito, or whose site access is limited, now get the same warning and close. The warning says which setting to change.
- If Web Guard stops answering during a session, the warning now comes after 35 seconds instead of 60.
- Web Guard 1.3.1: blocking YouTube also blocks youtube-nocookie.com and known Invidious sites; any blocked site is also blocked through Google Translate's proxy and in the Wayback Machine (web.archive.org). The list is a data file, updated with each release.
- Web Guard 1.3.1 also blocks for a session Lock-In on this PC tells it about, even if it can't reach Firebase.
- Fixed: moving the PC's clock forward ended a session and its Bail out early, and changing the time zone across midnight gave a second bail-out the same day. Sleep is unaffected.
- Fixed: a running session's block lists could be shortened mid-session; removals now wait for the session's end. Sessions started by this version can't be switched off from the account's data in Firebase; they end at their own end or when Bail out's five minutes are up.
- The Pack: adding someone sends them a request; they see it and can add you back. Your online status is visible only to people you've added.
- Delete account waits until no session is running, and removes you from your friends' lists.
- Lock-In Pro isn't built. There's now a "Pro — not available yet" row in Settings, and once after your first completed session a card asks whether you'd like to hear when it is. Nothing is sold; blocking, sessions of any length, Bail out, history and the weekly goal stay free.
- Optional, off unless you turn it on in Settings: share your hours-lost answers, focus minutes, focus days and how often you bail out, counted only in totals and averages, to help find out whether Lock-In helps. If it's on, the hours-lost question comes back once, two weeks later.
- The app's file no longer contains the Windows user name of the PC it was built on.

## [1.3.0] — 2026-11-16

- A parrot companion on the desktop: it walks along the bottom of the screen, perches on a branch on the right edge, naps there during sessions, and now and then suggests one (at most every 30 minutes by default, never in quiet hours). Click it for its menu, drag it, or rub it with the right button to pet it. On by default; Show the parrot in parrot settings or Show parrot in the tray turns it off. Its settings are saved to the account (`config/companion`); the branch height slider is kept on this PC.
- Every session that blocks websites now closes browsers without Web Guard signed in to the session's account, after a 10 second warning. 1.2.10 did this only if picked at the start. Apps-only sessions close no browsers. If the browser check can't start, the session falls back to apps-only and says so.
- Web Guard from the Chrome Web Store keeps Edge and Brave open too. The warning and the start dialog say "Install Web Guard in this browser to keep using it during sessions", with a button that opens the store page in that browser, or that Web Guard is signed out or on another account.
- The web blocker takes "youtube", "YouTube.com" or a full link and shows what it will block. Labels are "During focus sessions" and "Always (even without a session)". The blocked-sites count includes always-blocked sites.
- Starting with Windows now shows the dashboard, without taking focus.
- Fixed: a session whose only blocked sites were always-blocked counted as blocking no sites.
- Fixed: Block Registry rows and buttons flickered at their bottom edge on hover; long links ran off the edge of notices.

## [1.2.10] — 2026-11-04

- Browser lockdown. If you start a session that blocks websites while Web Guard isn't answering, or another browser is open, Lock-In offers to close the browsers it can't block. They get a 10 second warning, by Windows notification if the window is hidden, then close, and close again if reopened. Anything typed and not sent in them is lost. Browsers with a working Web Guard stay open.
- It isn't airtight, and we'd rather say so. A browser Lock-In doesn't know about stays open, a second Chrome profile or a Guest window without Web Guard isn't blocked, and Incognito is only covered if you've allowed Web Guard there; Lock-In warns you when you haven't. End task still stops Lock-In, and lockdown with it.
- If Web Guard stops answering in a browser during a session that blocks sites, while online, Lock-In warns you and closes that browser until the session ends.
- "Install Web Guard" now opens Chrome rather than your default browser.
- Fixed: a blocklist term like "msedge" could also close Lock-In's own window, and apps using the same web component. It now closes Edge and nothing of Lock-In's.
- The line under Hold to Start no longer says you can't stop a session early. Bail out ends it early, and voids the whole session.
- Fixed: Web Guard blocked sites and showed LOCKED with no session running, once the app had been open for 6 hours that day. That was a leftover daily limit nothing showed or explained, and keeping Lock-In in the tray made it far easier to hit. Blocking now follows sessions only.
- Chrome extension 1.2.5 tells Lock-In on the same PC that it's running and which browser it's in. That stays on your PC.

## [1.2.9] — 2026-11-03

- Lock-In now lives in the tray, with Open and Quit. Closing the window keeps it running by default; you can turn that off in the Block Registry. During a session, closing always hides it, and Quit says "A session is running. Use Bail out." End task still stops the app.
- Starting Lock-In again shows the hidden window, and starting with Windows no longer opens a window.
- Another device can no longer stop or start a session on this PC. A session here runs until its own end or its fuse. This also ends desktop-to-desktop session mirroring.
- Fixed: a bail-out followed by Clear all blocks, or by a stop from another device, could void your next session on its first tick.
- Fixed: a bail-out fuse that burned down while the app was closed left no record. The bailed-out entry is now written the next time you open the app.
- Starting a session that blocks websites while Web Guard, the Chrome extension, is missing or has been quiet for a minute now asks first: install it, or start apps-only, where Lock-In closes your blocked apps but doesn't block sites. Offline sessions start as usual. The "Web Guard not detected" banner now appears when the extension goes quiet, not only after a restart.
- The launch-on-startup switch now shows what Windows says, and tells you when it can't find out.
- The offline pill rechecks as soon as you reconnect, and has a Retry button.
- The Clear All Blocks button now says plainly what it does.
- Calendar links are checked properly: only Google's Public URL is accepted, and a saved link that isn't one shows the connect screen instead of a broken frame.
- Lock-In itself now ends and credits a session, whether or not the window is open. A session that ends while the window is hidden or the app is closed is still recorded. It earns only the minutes the PC was awake with Lock-In running: time asleep or closed is no longer credited.
- Fixed: in the direct download, apps with "app" in their name, such as WhatsApp, were refused as protected and couldn't be blocked.
- To-dos wrap between words instead of mid-word.
- Demo accounts no longer appear on The Pack's leaderboard.
- Only the main window can drive the enforcer.
- If both the Microsoft Store and direct-download copies are installed, Lock-In now says so and names the one you're in. They don't share sessions or settings.
- The Windows download is now a single installer. If you installed an older MSI and see two Lock-In entries in Apps & Features, uninstall the one dated before 1.2.9. Your blocks and streak are safe either way.
- Chrome extension 1.2.4 blocks a site before it loads and covers blocked iframes. A session it already knows about keeps being blocked when Firebase or sign-in can't be reached, and stops at that session's end; site blocking needs a connection to learn of a session. No pause button. The session ends when the timer does, or early if you Bail out (which voids it).

## [1.2.7] — 2026-10-13

- Bail out replaces Emergency Abort. During a session you hold the control for two seconds and the session ends five minutes later, voided — no minutes, no streak, however far in you were. Blocking continues until the fuse burns down, the app gives no way to cancel or shorten it, and signing out doesn't end it. End task or uninstalling still stops Lock-In. One bail-out per day; a second press tells you how long is left. The instant clear survives only when the app cannot read the enforcer at all, so you can never be trapped by a state we cannot see.
- Sessions of 45 minutes or more now start with a two-second hold rather than a click. The line under the hold said they couldn't be stopped early, which was wrong: Bail out ends a session early, and voids it (corrected in 1.2.10). 25-minute and Micro sessions are unchanged.
- Notebook and Botanical gain a full sticker and line-art layer across all five screens — stickers straddle a card's border or sit faintly behind its content, and never cover text. Operator and Bento are unchanged.
- Fixed: the Block Registry ran off the right of the screen on smaller windows; its two columns now stack below 1100px.
- Fixed: the mission field cut off its own prompt in Botanical, whose wording is a full sentence.

## [1.2.1] — 2026-09-14

- Handles containing a dot no longer fail silently on sign-up — the app now accepts only letters, numbers and underscores, and says so when you type something else.
- Blocked apps are now closed by Lock-In itself instead of launching a PowerShell process every two seconds, so enforcement is faster and no console window flashes on screen.
- Signing up with a handle someone already has now tells you it's taken and cleans up, instead of leaving you signed in to a half-created account you can't fix.
- Background saves that fail now raise a visible notice naming exactly what didn't save — your session minutes, your history, your handle — instead of disappearing into the console.
- Delete Account now removes every handle an account owns and works even while an emergency unlock is active; previously it could silently delete nothing at all.
- Handles are stored in one canonical lowercase form, so the same name can no longer be claimed twice with different capitalisation.
- Handles are capped at 20 characters, checked before anything is saved rather than rejected afterwards.
- Sign-in and registration screens now scroll on small windows; the register button was unreachable at the default window size.
