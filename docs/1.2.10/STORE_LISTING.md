# Microsoft Store listing — 1.2.10

For Partner Center. Store policy 10.1.1 needs the listing to describe important
limitations, and browser lockdown force-closes other apps.

## Disclosure line (paste into the description)

Optional browser lockdown closes browsers that can't block sites during a session, after a 10 second warning. They are closed by force, so unsent typing in them is lost.

## Listing line

No pause button. The session ends when the timer does, or early if you Bail out (which voids it).

## Notes

- Policy text wasn't re-read for this file. The 10.1.1 wording comes from
  `docs/browser-blocking/PHASE_A.md` §4.2, checked on 23 Oct 2026.
- The Chrome Web Store listing line is separate, in `apps/extension/STORE_SUBMISSION.md`.
