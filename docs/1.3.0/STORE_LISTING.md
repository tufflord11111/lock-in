# Microsoft Store listing — 1.3.0

For Partner Center. Store policy 10.1.1 needs the listing to describe important
limitations, and browser lockdown force-closes other apps.

## Description line about the parrot (add to the description)

A parrot companion walks along the bottom of your screen, naps on its branch while you focus, and now and then suggests a session. It's on by default, and you can turn it off in parrot settings or from the tray.

## Disclosure line (paste into the description, replacing 1.2.10's)

During every session that blocks websites, Lock-In closes your browsers that aren't running Web Guard signed in to your account, after a 10 second warning. They are closed by force, so unsent typing in them is lost. Sessions that block only apps close no browsers.

## Listing line (unchanged)

No pause button. The session ends when the timer does, or early if you Bail out (which voids it).

## What's new (paste into "What's new in this version")

Changes since 1.2.8, the current Store version:

- A parrot companion walks along the bottom of your screen, naps on its branch during sessions and now and then suggests one. On by default; turn it off in parrot settings or from the tray.
- New: every session that blocks websites closes browsers that can't block them, after a 10 second warning. Browsers running Web Guard (Chrome, Edge or Brave) signed in to your account stay open. Sessions that block only apps close none.
- Lock-In lives in the tray. Closing the window keeps it running; during a session, closing hides it and Quit points you to Bail out.
- Lock-In ends and records sessions even with the window closed, and credits only the minutes your PC was awake. Another device can no longer start or stop a session on this PC.
- A clearer Block Registry: type "youtube" and it blocks youtube.com, with plain labels for "during focus sessions" and "always".
- The dashboard opens when Lock-In starts with Windows, without taking the keyboard.
- Fixes: a session voided after a bail-out, a block like "msedge" closing Lock-In's own window, the offline indicator, calendar links, and more.

## What changed in the disclosure

The live listing is 1.2.8's, from before browser lockdown existed, so it has no lockdown line. The
1.2.10 draft line ("Optional browser lockdown…") was never published. From 1.3.0 every session
that blocks websites closes browsers without a live Web Guard signed in to the session's account.
Chrome, Edge and Brave can run Web Guard (from the Chrome Web Store); every other browser, Firefox
included, is closed. So the disclosure line above is new, has no "Optional", and names the browser
closing in site-blocking sessions. A session can still block apps only, and then no browser is
closed.

## Notes

- Policy text wasn't re-read for this file. The 10.1.1 wording comes from
  `docs/browser-blocking/PHASE_A.md` §4.2, checked on 23 Oct 2026.
- The Chrome Web Store listing line is separate, in `apps/extension/STORE_SUBMISSION.md`.
- The MSIX manifest's own description (`Package.appxmanifest`, "Force-closes the apps and sites
  on your list…") is unchanged.
