# Changelog

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
- To-dos wrap between words instead of mid-word.
- Demo accounts no longer appear on The Pack's leaderboard.
- Only the main window can drive the enforcer.
- The Windows download is now a single installer. If you installed an older MSI and see two Lock-In entries in Apps & Features, uninstall the one dated before 1.2.9. Your blocks and streak are safe either way.
- Chrome extension 1.2.4 blocks a site before it loads, covers blocked iframes, keeps blocking when Firebase or sign-in can't be reached, and stops at the session's end even offline. No pause button. The session ends when the timer does.

## [1.2.7] — 2026-10-13

- Bail out replaces Emergency Abort. During a session you hold the control for two seconds and the session ends five minutes later, voided — no minutes, no streak, however far in you were. Blocking continues until the fuse burns down, it cannot be cancelled or shortened, and quitting the app or signing out will not outrun it. One bail-out per day; a second press tells you how long is left. The instant clear survives only when the app cannot read the enforcer at all, so you can never be trapped by a state we cannot see.
- Sessions of 45 minutes or more now start with a two-second hold rather than a click, under a line saying plainly that they cannot be stopped early. 25-minute and Micro sessions are unchanged.
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
