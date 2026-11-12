# Microsoft Store listing — 1.3.0

For Partner Center. Store policy 10.1.1 needs the listing to describe important
limitations, and browser lockdown force-closes other apps.

## Disclosure line (paste into the description)

During a session that blocks websites, Lock-In closes browsers that can't block sites, after a 10 second warning. They are closed by force, so unsent typing in them is lost.

## Listing line

No pause button. The session ends when the timer does, or early if you Bail out (which voids it).

## What changed from 1.2.10

1.2.10's line said "Optional browser lockdown": lockdown only ran if it was picked when the
session started. From 1.3.0 every session that blocks websites closes browsers without a live
Web Guard (Chrome, Edge, Brave and Firefox can run it; every other browser is closed), so the
word "Optional" is gone. A session can still block apps only, and then no browser is closed.

## Notes

- Policy text wasn't re-read for this file. The 10.1.1 wording comes from
  `docs/browser-blocking/PHASE_A.md` §4.2, checked on 23 Oct 2026.
- The Chrome Web Store listing line is separate, in `apps/extension/STORE_SUBMISSION.md`.
