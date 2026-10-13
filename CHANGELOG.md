# Changelog

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
