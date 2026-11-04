# Lock-In companion: roaming African grey parrot. Research, 26 Oct 2026
(Copied from the Project doc claude/LOCK-IN_PARROT_COMPANION_26OCT.md on 3 Nov 2026.)

## The idea (the owner)
A cute African grey parrot that roams the screen, perches on things (icons, the taskbar), can be dragged and clicked, and nudges you when you're not locked in, e.g. every 15 min without a session: "What are you doing?", plus the occasional joke or drink-water reminder. Start with one animal; more later.

## Where it lives
Build it in the desktop app first (reaches every user, only place "sit on the taskbar" is possible, works offline, Rust knows session state). Extension in-page companion later, sharing the same settings. Prior art: WindowPet (MIT, Tauri + React) — study code; its art is not reusable.

## Why
Finch (self-care app with a bird): reported D1/D7 54%/37% vs Duolingo 51%/35%. Lesson: tie the parrot's state to your sessions (happy and calm after a session, restless when you skip), not random jokes.

## Design rules
- Opt-in toggle, DEFAULT ON, easy to mute: "quiet for 1 hour", "quiet today", off in settings.
- Nudges: interval configurable, default 15 min without a session during the user's chosen hours; max one per interval; quiet hours; never during a session — during a session the parrot sleeps or cheers quietly.
- Every nudge has an action: "Start 25 min" (the 45+ hold rule still applies), "Not now", "Quiet 1h".
- Distraction spotting stays local (foreground app/site vs blocklist, outside a session). Nothing uploaded; privacy page says so.
- Content mix: ~70% focus nudges, ~20% care (water, stretch, sleep at night), ~10% jokes. Short, written by us, never guilt-tripping.
- Physics: walks on the taskbar's top edge; flies between window title bars (EnumWindows rects); falls when dropped; click → small menu; drag anywhere; click-through except on the bird.
- Respect reduced motion; hide during full-screen video, games, presentations.
- Performance: sprite sheet, requestAnimationFrame ≤30 fps, <~1% CPU idle, pause animation when nothing moved for N seconds.
- Art: original African grey sprites in the Notebook sticker style: idle, walk, fly, perch, peck, talk, sleep, happy, sad.
- Brand: signature line "Lock in! Lock in!". Later: friends' parrots visit when a Pack friend starts a session.

## Scope
- v0.1 (after 1.2.9 tray mode): one parrot; walks and perches on the taskbar; drag; click menu (Start 25 / Quiet 1h / Hide); 15-min nudge outside sessions; sleeps during sessions; settings toggle.
- v0.2: title-bar perching; distraction-aware nudges; jokes/care lines; mood tied to streak.
- v0.3: extension in-page companion; friends' parrots via The Pack; more animals (possible Pack Pro cosmetic).

## Decisions from the owner (3 Nov) on PHASE_A.md's five questions
1. Default ON, easy off in Settings.
2. Asleep and visible during sessions (not hidden).
3. Yes to vitest, scoped to the animator/state machine.
4. v0.1 walks the bottom edge of the primary work area even if the taskbar is on another edge.
5. Ships in 1.3.x, after 1.2.9 tray mode. "Any window can call any Rust command" goes into 1.2.9 as a security item.
