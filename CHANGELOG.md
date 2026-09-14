# Changelog

## [1.2.1] — 2026-09-14

- Handles containing a dot no longer fail silently on sign-up — the app now accepts only letters, numbers and underscores, and says so when you type something else.
- Blocked apps are now closed by Lock-In itself instead of launching a PowerShell process every two seconds, so enforcement is faster and no console window flashes on screen.
- Signing up with a handle someone already has now tells you it's taken and cleans up, instead of leaving you signed in to a half-created account you can't fix.
- Background saves that fail now raise a visible notice naming exactly what didn't save — your session minutes, your history, your handle — instead of disappearing into the console.
- Delete Account now removes every handle an account owns and works even while an emergency unlock is active; previously it could silently delete nothing at all.
- Handles are stored in one canonical lowercase form, so the same name can no longer be claimed twice with different capitalisation.
- Handles are capped at 20 characters, checked before anything is saved rather than rejected afterwards.
