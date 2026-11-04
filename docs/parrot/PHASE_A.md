# Parrot companion — Phase A (research and design only)

Written 31 Oct 2026 against `571ace2` (master). Nothing in the tree was changed
to produce this; the only working-copy edits are still the two firebase-admin
shims in `scripts/` and the untracked `docs/` folders. Every diff here is
**described, not applied**.

**Reconciled 3 Nov 2026** against [DESIGN_26OCT.md](DESIGN_26OCT.md) and
The owner's five answers at the bottom of it. See "Reconciliation" below.

**Line references are pinned to `571ace2`.** HEAD has since moved to `60acb33`
(1.2.9 bump, tray mode built, capabilities now in `nsis/` and `store/`), so
`git show 571ace2:<path>` to read them, and re-pin at the start of Phase B. The
§4.5 Bedtime item was added afterwards, against `docs/day-plan/PHASE_A.md`.

Everything after the reconciliation section has been rewritten to match it, and
text tagged **v0.2** is kept as design but is not part of the first build.

**Reference:** WindowPet at `aba8d3a` (11 Apr 2025), studied in a scratch
clone and not copied. It is **Tauri v1**, which matters for what carries over:

- One full-screen transparent window (`src-tauri/tauri.conf.json:76-83`:
  `fullscreen`, `transparent`, `alwaysOnTop`, `skipTaskbar`).
- Phaser 3 with arcade physics, `fps.target: 30` (`src/PhaserWrapper.tsx:46`).
- Click-through: it starts with `setIgnoreCursorEvents(true)` (`:25`). Then,
  **on every Phaser frame** (`src/scenes/Pets.ts:311-317`), it IPCs
  `get_mouse_position` to Rust (`src-tauri/src/app/cmd.rs:6`), hit-tests in JS,
  and toggles ignore with a 50 ms debounce. The comment
  (`src/scenes/manager.ts:308`) says this is "to avoid crash when call
  setIgnoreCursorEvents too fast".
- Taskbar: `screen.height - screen.availHeight` (`Pets.ts:684`), so it only
  works with a bottom taskbar.
- Sprites: one PNG per pet, square frames (`frameSize: 128`), one row per state
  (`spriteLine`, `frameMax`), e.g. `src/config/Klee.json`.

What we take: the row-per-state sheet format, a 30 fps ceiling, and the
debounced ignore toggle. What we don't: a 30 Hz IPC round trip for the cursor
(the hit test moves to Rust, §1.4), Phaser (about 1 MB of physics we don't
need), and `availHeight` for the taskbar.

---

## Reconciliation with the design doc (3 Nov)

### Settled by the owner's answers

| # | Answer | Effect here |
|---|---|---|
| 1 | Default ON, easy off in Settings | §1.1, §4.4, §5, §6. See disagreement A for what that pulls with it. |
| 2 | Asleep and visible during sessions | `hideWhileFocusing` removed everywhere. Full-screen hiding still applies during a session. |
| 3 | vitest, scoped to the animator/state machine | Commit added in §7.1. See disagreement H. |
| 4 | v0.1 walks the bottom edge of the primary work area, whatever edge the taskbar is on | §2.2: `SHAppBarMessage` drops out of v0.1. |
| 5 | Ships in 1.3.x after 1.2.9 tray mode; "any window can call any Rust command" goes into 1.2.9 | §1.5, §5, §7.1. |

### Where the brief or this doc disagreed with the design doc

"Applied" means the rest of this doc now follows that call. Tell me if you want
any of them the other way.

| | Phase A / the brief said | Design doc says | Which way I'd go |
|---|---|---|---|
| **A** | Companion off by default; privacy copy says "only if you turn it on" | Line 14 says "Opt-in toggle, DEFAULT ON", which contradicts itself. Answer 1 says default ON. | **Default ON, so it is opt-out.** Applied. Consequences: existing users get a bird on upgrade, so the first bubble says how to quiet it. X hides instead of exits for almost everyone (§5). The privacy page has to say it is on by default (§6). |
| **B** | Title-bar perching, water/stretch and jokes all in one build | v0.1 is taskbar only, with a 15-min nudge. Title bars, care lines and jokes are v0.2. | **Follow the design doc's staging, even though the brief listed them all.** Applied. A default-on feature should ship with the smallest window-reading surface: v0.1 needs no `EnumWindows` at all. About 5 days instead of 5.5, and much less to get wrong. |
| **C** | Nudge after 45 min, plus a separate `minGapMin` of 20 | Default 15 min; "max one per interval" | **One setting, default 15.** Applied. A separate 20-min gap would silently turn the 15-min default into 20. 15 stays the floor in the rules. |
| **D** | Water, stretch and jokes each on their own timer and toggle | One mix: about 70 % focus, 20 % care, 10 % jokes | **One bubble slot per interval, with a weighted pick (v0.2).** Applied. The per-kind toggles are dropped, except one later addition: care lines as a group can be switched off separately (§4.5). |
| **E** | "Snooze 1 h", "Hush today" | Nudge: Start 25 / Not now / Quiet 1h. Menu: Start 25 / Quiet 1h / Hide. Mute: also "quiet today". | **Use the design doc's words.** Applied. The menu gets a fourth item, **Quiet today**, because line 14 requires it and the v0.1 menu on line 26 omits it. |
| **F** | Quiet hours only | "During the user's chosen hours" **and** "quiet hours" | **One pair of times, quiet hours.** Chosen hours are just the complement. Applied. |
| **G** | Sprite spec had no `peck`, `happy` or `sad`; no shadow, optional dark outline | Those three are required, in the Notebook sticker style | **Add the rows and use the sticker look**: white die-cut border and dark line, as in `stickers.tsx:24-26`. Bake the border; leave out the soft shadow. Applied (§7.3). |
| **H** | vitest for `machine.ts` **and** `nextBubble()` | Answer 3 scopes it to the animator and state machine | **Settled by the owner: vitest also covers `nextBubble()`.** Applied (§7.1, test 3-d). |
| **I** | The bird "does not read which apps are open" (§2.2, §6) | v0.2 compares the foreground app/site to the blocklist | **True for v0.1 only, and v0.2 must rewrite that copy before it ships.** Noted in §6. Also, the desktop app can't see the current site without a new channel from the extension, so I'd do apps in v0.2 and sites in the v0.3 extension companion. Needs its own short Phase A. |
| **J** | "Never guilt" | Line 5's example is "What are you doing?"; line 11 wants the bird restless when you skip; `sad` sprite | **Settled by the owner: "What are you doing?" is replaced by "Lock in! Lock in!" and "What are we working on?".** Applied (§4.2). Still my call for v0.2: restless is animation only, with no words, and `sad` gets drawn but must never be tied to a lost streak. |
| **K** | Stood-down line "Nice. 25 down." | No line given; "happy and calm after a session" | **"Nice. That's done." with the `happy` animation.** Applied. Sessions aren't always 25 min, and the event carries no length. |
| **L** | Brief wants a daily play-budget countdown "later" | Not mentioned in v0.1, v0.2 or v0.3 | **Settled by the owner: out of v0.1; the Day Plan design will define it.** `playBudgetMin` removed from the settings plan (§7.4). |
| **M** | Not covered | Line 5: perches on "icons" | **Don't build it.** It isn't in the design rules or scope, and reading desktop icon positions means cross-process ListView messages, which goes beyond read-only geometry. Noted so it isn't lost. |
| **N** | Sprite `point` row for the play badge | Nothing | **Removed.** |
| **O** | A care line vs quiet hours | "Sleep at night" is a care line, but night is usually inside quiet hours | **Superseded by Bedtime (§4.5).** "Sleep at night" leaves the care pool, so night lines only come from the Bedtime setting. |

No conflict: 30 fps ceiling, under about 1 % idle CPU, reduced motion, full-screen
hiding, click-through, drop-and-fall, the 45+ hold rule, local-only processing.
The design doc's "pause after N seconds" is met with N = 0, since the loop stops
as soon as nothing is due (§3.2).

---

## 0. Anchors

| Where | What | Line |
|---|---|---|
| `apps/desktop/src-tauri/tauri.conf.json` | the only window (unlabelled = `"main"`), `visible:false` | 16-29 |
| `tauri.store.conf.json` | `capabilities: ["store"]` | 3-5 |
| `capabilities/default.json`, `store.json` | both `"windows": ["main"]` | 5-7 |
| `build.rs` | parses **one** capability file per build | 7-12, 19 |
| `Cargo.toml` | `windows` 0.61 is optional and only used by `store` | 32, 41 |
| `lib.rs` `update_enforcement` | arm branch, no "armed" event | 618-649 |
| `lib.rs` `emit_stood_down` | `enforcer-stood-down` on every true→false | 320-329 |
| `lib.rs` `get_enforcer_state` | `focus_active`, `session_end_time`, `bailout_deadline` | 1121-1163 |
| `lib.rs` single-instance callback | shows `"main"` | 1437-1445 |
| `lib.rs` sniper thread | 2 s loop; locks `profile` twice per tick | 1483-1637 |
| `lib.rs` sniper "window enforcement" | touches `"main"` only, every tick | 1618-1635 |
| `lib.rs` boot show | 3 s delay, then shows `"main"` | 1663-1670 |
| `apps/web/index.html` / `harness.html` | precedent for a second HTML entry | — |
| `apps/web/src/main.tsx` | top-level `await loadBootSnapshot()`, imports `global.css` | 1-2, 25 |
| `packages/ui/src/global.css` | opaque `body` background | 13-25 |
| `useFocusSession.ts` | `startSession` | 448-525 |
| `App.tsx` | `useFocusSession(...)`; `onStartSession={startSession}` | 492-498, 811 |
| `Dashboard.tsx` | `startWithObjective`; 25 is single-click, ≥45 is hold | 182-184, 466-486 |
| `database.rules.json` | `config` has 3 validated children and no `$other` | 11-15 |
| `firebase-rules-tests/rules.test.cjs` | `check()` helper; theme tests | 17, 173-186 |
| `useSnapshotWriter.ts` | snapshots the whole `config` node | 55-57 |
| `BlockRegistry.tsx` | the "LAUNCH ON STARTUP" toggle pattern | 57-90 |
| `lockin-website/privacy.html` | "App settings" row; "What stays on your device" | 142, 210-216 |

---

## 1. The overlay window

### 1.1 Create it from Rust, not `tauri.conf.json`

A config entry would be created in **both** builds at startup with no way to
gate it on the user's `config/companion/enabled`, and its size has to come
from the monitor. So `setup()` builds it, right after `app.manage(AppState…)`
(`lib.rs:1468-1472`), unless the companion was off at last exit (a
`companion_enabled` bool in `LockProfile`). Toggling later creates or destroys
it.

**Default ON (answer 1).** The field needs
`#[serde(default = "default_true")]`, like `default_lock_mode` at `lib.rs:43`
and `:106`, and `true` in the initialiser at `lib.rs:1413-1427`. A plain
`#[serde(default)]` would give `false`, and every upgrading user would be off.
A signed-out install must still show nothing, so `show()` waits for **both**
`parrot-ready` and the main window's first signed-in `companion:settings`.

```rust
let mon = app.primary_monitor()?.ok_or(...)?;           // physical px
let wa  = mon.work_area();                               // tauri window/mod.rs:98
WebviewWindowBuilder::new(app, "parrot", WebviewUrl::App("parrot.html".into()))
    .title("Lock-In parrot")
    .transparent(true)        // wry: controller bg (0,0,0,0) at creation
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focusable(false)         // tao → WS_EX_NOACTIVATE (window_state.rs:296-298)
    .focused(false)
    .resizable(false)
    .visible(false)           // shown on the page's "parrot-ready" event (§1.3)
    .devtools(false)          // same shipping invariant as lib.rs:1405-1410
    .position(wa.position.x as f64, wa.position.y as f64)   // see DPI note
    .inner_size(...)
    .build()?;
w.set_ignore_cursor_events(true)?;
```

**Size and position: use physical units.** The builder's
`position`/`inner_size` take *logical* units. Call
`set_position(PhysicalPosition)` and `set_size(PhysicalSize)` with
`work_area` straight after `build()` and before `show()`, so a 150 % display
doesn't get a window 1.5× too big.

**Verified in the 2.10.3 sources** (`~/.cargo/registry`):

- `focusable()`: `tauri-2.10.3/src/webview/webview_window.rs:607`. It sets
  `WS_EX_NOACTIVATE` in `tao-0.34.8/src/platform_impl/windows/window_state.rs:296-298`.
- `transparent()`: `webview_window.rs:1079`. It sets the window **and** the
  webview flag.
- `set_ignore_cursor_events`: `webview_window.rs:2155`. Tao adds
  `WS_EX_TRANSPARENT | WS_EX_LAYERED` (`window_state.rs:285-287`).
- `shadow(false)`: `webview_window.rs:716`. It only matters on undecorated
  windows, which this is.

### 1.2 What Windows needs for transparency in Tauri v2

- **No feature flag on Windows.** `macOSPrivateApi` is macOS-only
  (`tauri-utils config.rs:1745-1750`); `transparent` is honoured on Windows as
  is.
- **WebView2 background.** wry passes `(0,0,0,0)` as the controller's default
  background *at creation* through `ICoreWebView2ControllerOptions3`
  (`wry-0.54.4/src/webview2/mod.rs:127-131`, `:393-403`). It sets it again
  after creation (`:452-453`) for older runtimes. That is what keeps WebView2
  from painting white/black.
- **The page must be transparent too.** `html, body { background: transparent }`.
  The parrot entry must **not** import `@lock-in/ui/src/global.css`, which
  paints `body` with `--ground-deep` (`global.css:13-25`), or `tokens.css`.
- **Same browser arguments as `main`.** Both webviews share one WebView2
  environment in this process. wry's default
  `--disable-features=msWebOOUI,…` (`mod.rs:294-297`) applies to both. Do
  **not** set `additional_browser_args` on the overlay alone: a mismatched
  environment fails webview creation. This also means GPU flags like
  `--disable-gpu` can't be set per-window.

### 1.3 Known WebView2 gotchas and mitigations

| Gotcha | Mitigation |
|---|---|
| **Black or white until first paint.** The HWND exists before the controller does, and an older runtime or a first-run profile can paint one opaque frame. | `visible(false)` at build. The page calls `emit("parrot-ready")` after its first `requestAnimationFrame`, and Rust `show()`s on that (plus the signed-in gate in §1.1). Fallback: treat the page as ready after 3 s anyway, with a log line. This matches the 3 s boot show (`lib.rs:1663-1670`); create the overlay after `"main"` shows so the two webviews don't race at boot. |
| **GPU and memory cost of a full-screen transparent webview.** DWM composites a work-area-sized surface (about 8 MB per buffer at 1920×1040). The page only re-rasterises damaged rects, but a full-page `<canvas>` damages the whole page every frame. | Draw the bird as **one small element** (a 96×96 CSS-px `<div>` with `background-position`, or a 96×96 `<canvas>`) moved by `transform: translate3d`. That is a compositor-only move, with no full-page repaint. **No full-page canvas.** Stop the rAF loop whenever nothing moves (§3.2). `hide()` the window (not just an empty page) when the companion is off, signed out, or over a full-screen app. Measure it (§3.4). |
| **A second renderer process.** About 30–60 MB working set. Both pages are `tauri://localhost`, so WebView2 *may* put them in one renderer; don't rely on either. | Keep the overlay bundle tiny: plain TS, no React, no Firebase, no `framer-motion`. Budget < 150 KB JS. |
| **DPI.** `work_area`, `cursor_position`, and every Win32 rect (with tao's per-monitor-v2 awareness) are **physical** px. The page works in CSS px. | Rust sends physical px relative to the overlay origin, and the page divides by `devicePixelRatio`. On `WindowEvent::ScaleFactorChanged`/`Resized`, or when the 2 Hz poll sees `work_area` change (taskbar moved, resolution changed), Rust re-fits the window and emits `parrot-geometry`. |
| **Multi-monitor.** | v0.1 lives on the **primary** monitor only (answer 4). In v0.2, title bars are clipped to the overlay rect and a window on another monitor is ignored. A later "follow the cursor's monitor" means re-fitting to `monitor_from_point` and is out of scope. |
| **Hidden/occluded throttling.** | Not a concern while shown: an always-on-top window is never occluded. When hidden, timers throttle, and the nudge logic reads the clock (§4.2). |
| **Toggling `WS_EX_LAYERED` on a DirectComposition window.** Tao adds *and removes* `WS_EX_LAYERED` with ignore-cursor (`window_state.rs:285-287`). Removing it from a transparent window is the step most likely to flicker or lose transparency on some drivers. Unverified; runtime test 1-c. | Debounce the toggle (50 ms, as WindowPet does) and only send real changes. If 1-c fails: patch around tao by setting/clearing **only** `WS_EX_TRANSPARENT` via `SetWindowLongPtrW` on `window.hwnd()`, leaving `WS_EX_LAYERED` set permanently. |

### 1.4 Click-through, toggled from a hitbox (in Rust)

While ignoring, the page receives **no** mouse events, so JS can't detect
hover. WindowPet fixes that with a 30 Hz IPC poll from JS. Instead:

- JS calls `companion_set_hitbox({x,y,w,h})` (overlay-relative CSS px × DPR =
  physical) **only when the rect changes**. That is ≤30/s while moving and 0
  while still. Rust keeps it in a `Mutex<Option<Rect>>` inside `CompanionState`
  (a **separate** managed state; it never touches `AppState.profile`).
- A Rust **hit-test thread** wakes at **20 Hz** while the overlay is shown,
  calls `GetCursorPos` (one syscall), inflates the hitbox by 8 px, and calls
  `set_ignore_cursor_events(!inside)` **only on a change**. It sleeps on a
  `Condvar` while the overlay is hidden, so it costs nothing then.
- **Bubbles are hitboxes too.** Each one sends its rect
  (`companion_set_hitbox` takes a small array).
- **Drag** (`companion_set_dragging(true)` on `pointerdown`) pins ignore=false
  until `pointerup`/`pointercancel`. Otherwise the bird outruns the cursor and
  the window goes click-through mid-drag.
- Cost: 20 wakes/s × about 1 µs ≈ 0.002 % of a core.
- **Not used:** `WH_MOUSE_LL` low-level hooks. A global mouse hook in a Store
  app reads as input monitoring, which is a review risk and a privacy-page
  line we don't want.

### 1.5 Capabilities and permissions (both builds)

- **What the overlay needs from JS:** `core:event:default` (`listen`, `emit`,
  `emitTo`), plus `core:window:default` (read-only getters such as
  `scaleFactor`). Nothing else: hide, show, ignore-cursor and position are all
  done in Rust.
- **Problem: `build.rs` parses exactly one file** (`build.rs:7-11`, `:19`).
  `capabilities_path_pattern` is a `glob` pattern (`tauri-utils` `acl/build.rs:76`,
  the `glob` crate, **no `{a,b}` braces**).
- **Proposed:** move to per-variant directories.
  - `capabilities/nsis/default.json` (the current `default.json`, unchanged)
    plus `capabilities/nsis/parrot.json`.
  - `capabilities/store/store.json` (the current `store.json`) plus
    `capabilities/store/parrot.json`.
  - `build.rs` picks `./capabilities/nsis/*.json` or `./capabilities/store/*.json`.
  - `$schema` paths become `../../gen/schemas/desktop-schema.json`.
  - The two `parrot.json` files are identical. Add one line to the
    capability-variant check from 1.2.9 item 3 that byte-compares them, or
    accept the duplication.

  ```json
  { "$schema": "../../gen/schemas/desktop-schema.json",
    "identifier": "parrot",
    "description": "Parrot overlay: events and read-only window getters only",
    "windows": ["parrot"],
    "permissions": ["core:event:default", "core:window:default"] }
  ```

- **`tauri.store.conf.json:4`:** `"capabilities": ["store", "parrot"]`. The
  NSIS config has no list, so every parsed capability is enabled.
- **App commands are not gated per window today.** There is no `AppManifest`
  in `build.rs`, so every command in `generate_handler!` (`lib.rs:1447`) is
  callable from **any** webview, the overlay included (`update_enforcement`,
  `clear_all_blocks`, …).
  - The overlay loads only bundled code, so the risk is "a bug in overlay
    code", not a remote attacker.
  - **This now goes into 1.2.9 as a security item (answer 5):**
    `AppManifest::commands(&[...])` plus explicit `allow-*` grants per window.
    It belongs to that release, not this feature.
  - **What the parrot needs from it:** `parrot.json` gains only `allow-`
    entries for the `companion_*` commands and `get_enforcer_state`, and no
    other command is reachable from the overlay. With that in place, the
    `label() != "parrot"` checks I proposed earlier are unnecessary.
  - **Ordering:** that 1.2.9 change edits the same capability files, so do the
    per-variant directory move above inside it. Commit 2 in §7.1 then only
    adds `parrot.json`.
- **MSIX manifest:** no change. An always-on-top, no-activate window needs no
  capability beyond `runFullTrust` (`Package.appxmanifest:89`).

---

## 2. Rust commands (read-only Win32)

**Staging.** v0.1 needs only full-screen detection, the work area (from Tauri)
and user idle time. The title-bar enumeration, occlusion and perch tracking
below are **v0.2**: kept here so v0.2 doesn't have to research them again.

### 2.1 Crate

`windows` 0.61.3 is already in `Cargo.lock` (`:5478`), optional and
`store`-only (`Cargo.toml:32`, `:41`). Make it unconditional with the Win32
features. The store feature then only adds WinRT:

```toml
windows = { version = "0.61", features = [
  "Win32_Foundation", "Win32_UI_WindowsAndMessaging", "Win32_UI_Shell",
  "Win32_Graphics_Dwm", "Win32_Graphics_Gdi", "Win32_UI_Input_KeyboardAndMouse" ] }
[features]
store = ["windows/ApplicationModel", "windows/Foundation"]
```

`Win32_Graphics_Dwm` is only needed from v0.2 on; leave it out of v0.1.

`lib.rs:1327-1330` (`use windows::ApplicationModel…`) still compiles under
`cfg(feature="store")`. All the new code goes in a new `src/companion.rs`,
so `lib.rs` only grows by a `mod` line, `manage()`, the builder and the
handler entries.

### 2.2 Commands and polled data

All of these are read-only and touch no other process. None read window
titles, class names of other apps, process names or contents. (v0.2's
distraction-aware nudges would change the "process names" part; see
disagreement I.)

| Item | API | Notes |
|---|---|---|
| **Taskbar rect: not needed in v0.1** | Researched: `SHAppBarMessage(ABM_GETTASKBARPOS)` → `rc`, `uEdge`; `ABM_GETSTATE` → `ABS_AUTOHIDE` | **The bird walks along the bottom of the primary work area, whichever edge the taskbar is on (answer 4).** The overlay *is* the work area, so that is simply its bottom edge, and Tauri's `work_area` already handles auto-hide (it is then the full monitor). With a bottom taskbar this is the taskbar's top edge, as the design doc asks. Add this call only if a later version walks on side or top taskbars. |
| **Title-bar perches (v0.2)** | `EnumWindows`, then filter (below), then `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` | Returns the **visible, unoccluded** segments of each window's top edge (below). |
| **Foreground full-screen** | `SHQueryUserNotificationState` → `QUNS_RUNNING_D3D_FULL_SCREEN`, `QUNS_PRESENTATION_MODE`, `QUNS_BUSY`; backstop: `GetForegroundWindow` rect ⊇ `MonitorFromWindow` rect, and not the shell's desktop window (`GetShellWindow()`, or the `WorkerW` that hosts it, compared by HWND, not by reading class names of other apps) | Borderless-windowed games report `QUNS_BUSY`, which the backstop also catches. True → `hide()` the overlay; false for 2 consecutive polls → `show()` it. The hysteresis avoids flicker on alt-tab. |
| **User idle seconds** | `GetLastInputInfo` vs `GetTickCount64` | Only so nudges never fire at an empty chair (§4.2). It reads a timestamp, not input. |

**v0.2. Filters for perch windows (in `EnumWindows` order, top of z-order first):**

1. `IsWindowVisible`; not `IsIconic`; not `IsZoomed` (a maximised window's top
   edge is the screen top, and the bird would perch off-canvas).
2. `DwmGetWindowAttribute(DWMWA_CLOAKED) == 0`. This drops windows on other
   virtual desktops and suspended UWP frames.
3. No owner (`GetWindow(GW_OWNER) == 0`); not `WS_EX_TOOLWINDOW`; has
   `WS_CAPTION`. That leaves real app windows, not menus, tooltips or popups.
4. Not this process (`GetWindowThreadProcessId` pid ≠ ours), which excludes
   `"main"` and `"parrot"`.
5. Width ≥ 200 physical px.

**v0.2. Occlusion** (pure function, unit-tested): walk the list top-down. A window's
top edge is the segment `[left, right] × top`. Subtract the x-intervals of
every *earlier* (higher) window whose rect covers `top`. Keep segments
≥ 96 physical px. Clip to the overlay rect. Emit
`{hwnd: u64, x0, x1, y}[]` in overlay-relative physical px. The HWND is only
an opaque id the page uses to follow "its" window.

**Store policy.** The brief cites 10.2.8 for "no UI Automation". The above
uses only USER32/DWM/Shell geometry queries: no `IUIAutomation`, no
accessibility hooks, no `SetWinEventHook`. `SetWinEventHook` would be
event-driven instead of polled, but it is the MSAA/WinEvents family, so it
stays out to keep that line clean. **Re-read the current 10.x text before
submission;** it was not re-fetched for this report.

### 2.3 Polling, and keeping it away from the 2 s kill loop

- **Its own thread** (`companion` thread), started with the overlay and parked
  on a `Condvar` while it is hidden or disabled. It **never locks
  `AppState.profile`**. The sniper (`lib.rs:1494`, `:1531-1541`) takes that
  lock twice per tick, and a slow `EnumWindows` must never be able to hold it.
- **Rates:**

  | What | Rate |
  |---|---|
  | v0.1 poll (full-screen + work area + idle) | **2 Hz** |
  | Poll while the bird **sleeps** (session) | **0.5 Hz**, only full-screen and work area matter |
  | v0.2 adds `EnumWindows` to the 2 Hz poll | **2 Hz** |
  | v0.2 perch tracking: **only the one HWND the bird stands on**, one `DwmGetWindowAttribute` | **10 Hz**, only while on a title bar |

  Perch tracking keeps the bird on a window being dragged without enumerating
  everything at 10 Hz. 2 Hz alone leaves the bird floating for up to 500 ms.
- **Emit only on change.** Diff against the last snapshot, then
  `app.emit_to("parrot", "parrot-world", payload)`.
- **Cost estimate:** the v0.1 poll is a handful of cheap calls. v0.2's
  `EnumWindows` over about 150 top-level windows plus about 20 DWM calls is
  roughly 0.3–1 ms; at 2 Hz that is < 0.2 % of one core. Measure in test 3-a.
- **No effect on the kill loop:** separate thread, no shared lock, no shared
  `System`. The only shared resource is the CPU, and the companion uses
  ≤ 2 ms/s.
- **The sniper's window block** (`lib.rs:1618-1635`) addresses `"main"` by
  label and never touches `"parrot"`. No change.

---

## 3. Web

### 3.1 Entry: a second HTML page, not a route

There is no router (`main.tsx` renders `<App/>` directly) and `App` boots
Firebase, auth and the snapshot (`main.tsx:25`). A route would load all of
that into the overlay.

- `apps/web/parrot.html` → `src/parrot/main.ts`, following the
  `harness.html` precedent.
- `vite.config.ts`: `build.rollupOptions.input = { main: "index.html", parrot: "parrot.html" }`.
  `harness.html` stays dev-only because it is not listed.
- `parrot.html` carries its own CSP meta, a copy of `index.html`'s minus every
  Firebase origin: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost`.
- **Guard:** `src/parrot/main.ts` starts with
  `if (getCurrentWebviewWindow().label !== "parrot") throw …`, and
  `main.tsx` does the converse. A stray navigation can't mount the wrong app
  in the wrong window.

### 3.2 Animator and state machine

**Files:**

- `src/parrot/sprite.ts`: sheet loader plus `drawFrame(state, i)`, which sets
  `background-position` on the bird `<div>`. With placeholder squares it fills
  a coloured box with the state name.
- `src/parrot/machine.ts`: a **pure** reducer, `(state, event, now) → state`.
  It has no DOM, so it can be tested.
- `src/parrot/loop.ts`: the rAF loop.
- `src/parrot/bubble.ts`: speech bubbles.
- `src/parrot/main.ts`: wiring.

**rAF loop:**

- Accumulates time and steps logic at most **30 Hz** (skips rAF callbacks
  < 33 ms apart).
- Sprite frames advance by **each state's own fps** (≤ 12) from the sheet
  JSON, computed from `now`, not frame count (the 1.2.3 lesson).
- **Paused when idle:** when the state is static (`perch` with no blink due,
  `sleep`'s slow breathing, the reduced-motion pose), the loop cancels rAF
  and schedules the next frame with `setTimeout(nextEventAt - now)`. Blinks
  and breathing are 1 frame every 2–4 s, so the idle rate is about 0.3–1
  wakes/s instead of 60.

**States and transitions:**

| State | Enters on | Leaves on |
|---|---|---|
| `idle` | landing; `talk` ends | random 4–20 s → `walk`, `peck` or `perch`; in v0.2, 30 % → `fly` to a title bar |
| `walk` | from `idle` | reaches its target x → `idle` (bounded by the work-area bottom edge) |
| `peck` | occasional idle variation | ends → `idle` |
| `perch` | v0.1: settles on the bottom edge. v0.2: arrives on a title-bar segment | random 30–120 s → `walk`. v0.2: segment gone or moved > 40 px between polls → `fly` (or `fall` if it moved straight down) |
| `fly` (`takeoff` → `fly` → `land` sub-phases), **v0.2** | heading to a title bar | arrives → `perch`; target vanished → re-target, or the bottom edge |
| `sleep` | `enforcer-armed`, or boot with `focus_active` (visible, answer 2). v0.2: also Sleep mode `active`/`fuse` (§4.5) | `enforcer-stood-down` → `wake` → `happy` + a short line if `deadline-expired`; → `idle` + a neutral line if `bailout-expired`, never guilt. v0.2: if Sleep mode is still on, it stays asleep, with no line |
| `happy` | a session ended on time | ends → `idle` |
| `sad`, **v0.2** | streak mood (disagreement J) | not used in v0.1 |
| `talk` | nudge due; click on the bird | bubble dismissed or timed out (12 s) → previous state |
| `drag` | `pointerdown` on the bird | `pointerup` → `fall` to the bottom edge (v0.2: the nearest title bar below the drop point, if any) |
| `hidden` | full-screen, disabled, or signed out | the reverse |

**Drag:** pointer events on the bird `<div>`:

- `setPointerCapture` on `pointerdown`, plus `companion_set_dragging(true)`.
- Move the bird with `transform`, clamped to the overlay.
- On `pointerup`, release the capture and send `companion_set_dragging(false)`.
- A press shorter than 200 ms with less than 4 px of movement counts as a
  **click**: it opens the small menu ("Start 25", "Quiet 1h", "Quiet today",
  "Hide"). The drag can go anywhere within the overlay, which is the primary
  work area.

**`prefers-reduced-motion`.** WebView2 follows Windows Settings →
Accessibility → Visual effects → Animation effects. With `matchMedia(...).matches`:

- No `walk` or `fly`. The bird sits on the bottom edge at 85 % of the width,
  in a single frame (`idle` frame 0, or `sleep` frame 0).
- Bubbles appear without a slide.
- Drag still works and drops instantly.
- Listen to `change` events to switch modes live.

### 3.3 CPU budget: ≤ 1 % idle

"Idle" means the bird is perched or sleeping and nobody is touching it.
Expected:

| Process | Load |
|---|---|
| Renderer | about 1 wake/s |
| Rust | 2 Hz poll + 20 Hz cursor check |
| GPU | ≈ 0 between blinks |

### 3.4 How to measure it

Run each step for 5 minutes, NSIS release build:

1. Baseline: companion **off**, app idle, main window hidden.
2. Companion **on**, bird perched on the bottom edge (DEV setting
   `parrot.debugFreeze=perch` to pin the state).
3. Companion on, bird walking (worst case, expected 2–4 %).
4. Session running (bird asleep).

Sample all WebView2 processes and the app process together, normalised to
total CPU:

```powershell
Get-Counter '\Process(msedgewebview2*)\% Processor Time','\Process(app)\% Processor Time' -SampleInterval 1 -MaxSamples 300 |
  % { ($_.CounterSamples | Measure-Object CookedValue -Sum).Sum / $env:NUMBER_OF_PROCESSORS } |
  Measure-Object -Average -Maximum
```

The process name is `Lock-In` for MSIX. **Pass:** (2) − (1) ≤ 1.0 % average,
and (4) − (1) ≤ 0.5 %. GPU: Task Manager → Details → GPU column for the
`msedgewebview2` processes, or `\GPU Engine(*)\Utilization Percentage`
filtered by pid; expect < 1 % in (2).

Also record the private bytes of the extra renderer (if one appears) in
step 2.

---

## 4. Wiring

### 4.1 Session state: Rust is the truth, as in the main window

- **New event:** `enforcer-armed` (`{ session_end_time, timestamp }`). Emit it
  in `update_enforcement`'s arm branch after `:645`, and in `restore_profile`
  when it restores an armed session. Today there is only the stand-down event
  (`lib.rs:320-329`), so the overlay could not learn of a start without
  polling.
  - `app.emit` is global, so both webviews get it.
  - The main window can ignore it.
- **Overlay boot:** `invoke("get_enforcer_state")` (`lib.rs:1145`). If
  `focus_active` → `sleep`.
- **Backstop:** re-probe every 60 s, asleep or awake. Idempotent, so a missed event
  self-heals within a minute.
- **On `enforcer-stood-down`:** wake. The `reason` picks the line:
  - `deadline-expired` → the `happy` animation and "Nice. That's done."
  - `bailout-expired` / `session-ended-*` → a neutral "Back to it whenever."
  - **Never guilt.**
- **Asleep and visible during sessions (answer 2).** There is no setting to
  hide it. The companion thread drops to 0.5 Hz while asleep, and the bird still
  hides over a full-screen app. The design doc's "sleeps or cheers quietly" is
  settled as sleeps.

### 4.2 Nudge timer: read the clock (the 1.2.3 lesson)

**State in the overlay's `localStorage`:** `lastSessionEndAt`,
`lastBubbleAt`, `quietUntil`, `quietTodayDate`. Both pages are `tauri://localhost`,
so they share an origin; prefix keys `parrot.`.

`lastSessionEndAt` is seeded from `enforcer-stood-down.timestamp`, and on
first run from overlay boot time. **No Firebase** in the overlay.

**One 30 s `setInterval`** that calls a **pure**
`nextBubble(now, settings, memory, world) → Bubble | null`. It never counts
ticks; everything is `now - timestamp`. A throttled or late tick fires
whatever is due, once.

**Rules, in order:**

1. Return nothing if any of these hold:
   - asleep, or a session is running
   - hidden or full-screen
   - `now < quietUntil`
   - `quietTodayDate === today`
   - inside **quiet hours**: local `HH:MM` start/end that may wrap midnight
     (default 22:00–08:00; disagreement F)
   - user idle > 5 min (`idle_seconds` from the poll)
2. **Max one bubble per interval:** the single `nudgeAfterMin` setting (default
   15 min). Nothing if `now - lastBubbleAt < nudgeAfterMin` or
   `now - lastSessionEndAt < nudgeAfterMin`.
3. **v0.1:** that slot is always a focus nudge.
4. **v0.2:** the slot takes a weighted pick: about 70 % focus, 20 % care (water
   and stretch), 10 % jokes. With care lines off, the pick is only between focus
   and jokes. Bedtime has its own rules (§4.5).

**Every nudge has three actions:** **Start 25** (never 45+; the hold rule still
applies), **Not now** (dismiss) and **Quiet 1h**.

**Copy rules** (put them in `src/parrot/lines.ts` as a header comment):

- Short, written by us, an invitation not an order. The signature line is
  "Lock in! Lock in!".
- No streak loss, no "you've wasted", no counts of minutes not focused.
- The v0.1 nudge lines are "Lock in! Lock in!" and "What are we working on?".
  "What are you doing?" is not used (disagreement J).

**First bubble after install or upgrade (default ON):** "Hi! Click me if you
want me quiet." It shows once, and uses the same one-per-interval slot.

### 4.3 "Start 25" from the bubble: reuse the dashboard's start path

The overlay has no Firebase and no `startSession`; the main window owns both.

1. The overlay calls `emitTo("main", "companion:start-session", { minutes: 25 })`.
2. `App.tsx` adds one `useEffect` next to `useFocusSession` (after `:498`)
   that `listen`s for it and calls **the same `startSession`** that
   `Dashboard` gets as `onStartSession` (`App.tsx:811`):
   `startSession(25, "Untitled Session")`. That matches
   `startWithObjective` with an empty objective (`Dashboard.tsx:182-184`).
   - Everything `startSession` does, it does here too: the Firebase writes,
     `update_enforcement`, and any refuse-to-start check 1.2.9 adds.
   - 25 is a single-click preset on the dashboard (`Dashboard.tsx:466-469`),
     so a one-click start from the bubble keeps the same rule. **Never offer
     45+ from the bubble.**
3. **Guards** (in App): signed in, `emailVerified`, onboarding complete, and
   `!isActive`. Otherwise App replies
   `emitTo("parrot", "companion:start-refused", {reason})` and `show()`s
   `"main"`; the bird says "Open Lock-In to start."
4. **Success** is not a reply: Rust's `enforcer-armed` puts the bird to
   sleep. It is one source of truth, and the same path as a dashboard start.
5. **Dependency:** this only works while the main **webview exists**. With
   tray mode it is hidden, not destroyed (§5).

### 4.4 Settings: `users/{uid}/config/companion`

**Shape (v1):**

| Field | Type | Range / default |
|---|---|---|
| `enabled` | bool | default `true` |
| `nudgeAfterMin` | number | 15–240, default 15 |
| `quietStart`, `quietEnd` | "HH:MM" | default 22:00, 08:00 |
| `v` | number | `1` |

**Default ON (answer 1):** a missing `enabled` means on, so code reads
`enabled !== false`. Nothing is written until the user changes a setting. The
toggle follows the `BlockRegistry.tsx:57-90` pattern.

**Rules** (`database.rules.json`, inside `config` after `:14`):

```json
"companion": {
  "enabled":           { ".validate": "newData.isBoolean()" },
  "nudgeAfterMin":     { ".validate": "newData.isNumber() && newData.val() >= 15 && newData.val() <= 240" },
  "quietStart":        { ".validate": "newData.isString() && newData.val().matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)" },
  "quietEnd":          { ".validate": "newData.isString() && newData.val().matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)" },
  "v":                 { ".validate": "newData.val() === 1" },
  "$other":            { ".validate": false }
}
```

`config` itself has no `$other` (`:11-15`), so this is additive and breaks
no existing writer.

**Emulator tests** (`rules.test.cjs`, after the theme block `:173-186`, same
`check()` helper):

- Pass:
  - `enabled` true/false
  - `nudgeAfterMin` 15 and 240
  - `quietStart` `"22:00"`, `quietEnd` `"07:30"`
  - `v` 1
  - the whole object in one `set`
- Fail:
  - `nudgeAfterMin` 14, 241 and `"45"`
  - `quietStart` `"24:00"`, `"7:30"` and `"22:00x"`
  - `enabled` `"yes"`
  - `v` 2
  - an unknown key `companion/foo`
  - **another user** writing `users/alice/config/companion/enabled`
  - anon writing it (mirrors `:312`)

Run with `pnpm --filter @lock-in/firebase-rules-tests test`.

Rules changed, so **the full cycle applies**: emulator tests → diff → deep
compare → deploy → deep compare (the cycle named in `docs/1.2.9/PHASE_A.md`
§10).

**Snapshot:** `useSnapshotWriter.ts:55-57` already captures the whole
`config` node, so `config.companion` rides along with **no change**. An
offline boot gets the last settings.

**Getting settings to the overlay:**

1. The main window (Firebase listener on `config/companion` in a small
   `useCompanionSettings` hook) `emitTo("parrot", "companion:settings", …)`
   on every change.
2. The main window also invokes `companion_set_enabled(bool)` to create or
   destroy the overlay, which persists `LockProfile.companion_enabled` for
   the next boot.
3. The overlay asks with `emitTo("main", "companion:hello")` on boot; main
   answers with the current settings.
4. Until it has an answer, the overlay uses the last settings it cached in
   `localStorage` (`parrot.settings`), and **no bubbles** until settings
   have arrived once.

**Signed out:** the main window sends `companion:settings` with
`enabled:false` semantics. The bird goes `hidden`; no account, no companion.
This is what keeps default ON from showing a bird on the Login screen.

**Later:** the v0.3 extension companion reads the same `config/companion` node,
as the design doc asks. v0.2's settings would add to the rules above.

**UI:** a "Parrot companion" block in Block Registry next to LAUNCH ON STARTUP,
with an on/off toggle and the fields above. Quiet hours use two `<input type=time>`.

### 4.5 v0.2: Bedtime and the sleepy parrot

**Not in v0.1.** It adds no new Win32 reads: only the clock, plus the idle time
and full-screen state the poll already has.

**Settings** (in `config/companion`, in the same Block Registry block):

| Field | Type | Default |
|---|---|---|
| `bedtimeEnabled` | bool | `false` |
| `bedtime` | "HH:MM" | `"00:30"` |
| `careLines` | bool | `true` |

Rules go next to the fields in §4.4, using the same `HH:MM` regex. `v` stays 1,
since the fields are optional. Writers must use `update`, not `set`, so a v0.1
client can't erase them. Emulator tests:

- Pass: `bedtime` `"00:30"`, both booleans.
- Fail: `bedtime` `"24:00"`, `bedtimeEnabled` `"yes"`, `careLines` `1`.

It's a rules change, so the full deploy cycle applies.

**The bedtime window** runs from `bedtime` to the next **morning**, which is
`quietEnd` (default 08:00). This is one pure function that handles the midnight
wrap, read from the clock on every check.

**Sleepy state.** While the window is open and `bedtimeEnabled` is on:

| | |
|---|---|
| Animation | `droopy_idle` replaces `idle`, with a `yawn` every 1–3 min at random |
| Movement | No `walk` or `fly`. It stays where it is, and drag still works |
| Reduced motion | `droopy_idle` frame 0, no `yawn` |
| Session running | Normal `sleep` wins, and the bird returns to sleepy afterwards |
| Leaves | At morning, or when Bedtime is switched off |

**Bedtime nudges,** added to `nextBubble()` and covered by its vitest tests:

- **At most one every 30 minutes,** from a separate `lastBedtimeNudgeAt`, read
  from the clock. After a laptop sleep: one bubble, not a backlog.
- **Never** during a session, over full-screen, or with the user idle over 5 min.
- **Not within 5 min of any other bubble,** so a session's "Nice. That's done."
  isn't followed straight away by a bedtime line.
- **Lines:** "It's {time}. Tomorrow-you says thanks for sleeping." and "Lock in
  tomorrow. Sleep now?". `{time}` comes from the clock, so the line never says
  1 am at 00:30. No guilt, and no count of how late it is.
- **Actions: "Going to bed" and "Quiet tonight".** There is deliberately no
  Start 25; this is the one exception to the design doc's line 16.

| Action | Effect |
|---|---|
| **Quiet tonight** | Sets `quietTonightUntil` to the next morning. No more bedtime nudges until then. The bird stays sleepy. |
| **Going to bed** | The same, and the bird plays `yawn` then `sleep` until morning. It does nothing to the PC. |

**How it fits the other nudges:**

- **Quiet hours do not silence bedtime nudges.** The default quiet hours
  (22:00–08:00) cover the default bedtime (00:30), so otherwise the feature would
  never fire. Turning Bedtime on is explicit, so it wins.
- **Quiet 1h** applies to bedtime nudges too.
- **Quiet today** also sets `quietTonightUntil`. v0.1's value is a calendar date,
  so without this it would run out at midnight, just before a 00:30 bedtime.
- **Focus, care and joke lines stop inside the window,** so nobody gets "Lock in!
  Lock in!" at 1 am. Day Plan's budget lines (`docs/day-plan/PHASE_A.md` §9) still
  outrank nudges.

**Care lines.** Water and stretch stay in the v0.2 care pool (about 20 % of lines),
max one per interval, with `careLines` switching them off separately.

**Day Plan's Sleep mode is status, not a nudge.** It is defined in
`docs/day-plan/PHASE_A.md` §11.1. The blocking belongs entirely to Day Plan.

**What the parrot reads:** `get_enforcer_state().day.sleep`, a
`SleepView` (`None`, or `day` itself `None`, means Sleep mode is off):

```rust
struct SleepView {
    state: String,            // "idle" | "heads_up" | "pre_arm" | "active" | "fuse" | "skipped" | "voided" | "done" | "missed" | "reminded"
    next_start_at: Option<u64>,
    arm_at: Option<u64>,
    ends_at: Option<u64>,     // epoch ms when blocking really stops; the reader formats it in local time
    can_skip: bool,
    fuse_until: Option<u64>,
    bailout_left: bool,
}
```

It reads this at overlay boot, on `day-sleep-changed`, and on the 60 s probe from
§4.1. The probe also runs while the bird is asleep, because Sleep mode can start
during a session. The parrot uses only `state` and `ends_at`. It doesn't need
`fuse_until`, because Rust already resolves `ends_at` to when blocking really stops,
including a fuse that would outlast the window. It calls no Day Plan
command; Skip and Bail out stay in the main window. No new capability is needed.

**Sleep mode is on when `state` is `active` or `fuse`.** No dial check is needed:
Notify only ever reaches `reminded`, which blocks nothing. Precedence is session,
then Sleep mode, then Bedtime. While it is on:

| | |
|---|---|
| Animation | `sleep` (not `droopy_idle`), even with Bedtime off |
| Click menu | **Always** shows the status line above the usual items, at any hour. It has no action. `active`: "Sleep mode until 7:00". `fuse`: "Sleep mode ends at 1:05". Both times come from `ends_at` |
| Bubble | **Only one kind:** the same line, when a Play app has just been closed (below) |
| Nudges | None of any kind: no bedtime, focus, care or joke lines. No "go to bed", no "you're still up" |

Sleep mode leaving `active`/`fuse` wakes the bird silently, with no line and no
`happy`. It then follows the normal rules, including Bedtime if that is on.

**The "Play app closed" bubble:**

- **It is status, so** quiet hours, Quiet 1h, Quiet tonight and the idle check do
  not silence it. It explains why an app just went away. It adds no buttons.
- **Not during a session,** when the bird is asleep and stays silent. The menu line
  still works.
- **It waits for the bird to be visible.** The closed app is often the full-screen
  one, so the overlay is still hidden when it closes, for up to about 1 s (§2.2).
  Hold the bubble for up to 5 s until the overlay shows, then drop it.
- **At most one every 30 min,** from `lastSleepBubbleAt`, read from the clock. Day
  Plan leaves rate limiting to the parrot: a relaunching game emits every 2 s. Only a
  bubble actually shown sets `lastSleepBubbleAt`, so an event ignored during a session
  or dropped after the 5 s wait doesn't use up the 30 minutes.
- **The signal is `day-sleep-closed { timestamp }`** (Day Plan §11.1). Rust emits it
  after a kill pass in `active` or `fuse` where Sleep's terms actually killed something,
  once per pass, however many processes went. It carries no app names, ever.
- **Not after the soft close.** Day Plan doesn't emit for the T-0:30 `WM_CLOSE`: the
  state is still `pre_arm`, and its warning has already said what will close. So a game
  that closes politely at the start of the window gets no bubble. One that ignores the
  request, or is launched later, does. Notify never emits.
- **The text is the current status line,** so during a fuse the bubble says "Sleep mode
  ends at 1:05". If the current `SleepView` isn't `active` or `fuse`, it shows nothing.

**Other `SleepView` states:**

- `heads_up` and `pre_arm`: the parrot says nothing about them, since Day Plan warns
  the user itself. It also holds back bedtime nudges so the two don't stack.
- `idle`, `skipped`, `voided`, `done`, `missed` and `reminded`: no status and no line
  about them. Bedtime works as above.

---

## 5. Dependency: tray mode (1.2.9 item 1)

`docs/1.2.9/PHASE_A.md` §1 is designed but **not built**: there is no
`tray-icon` feature (`Cargo.toml:24`) and no `on_window_event`. The overlay
needs these from it:

1. **Main hides, never closes, while the companion is enabled.** Item 1 step 4
   hides on X only when `armed()` or `close_to_tray` is set. Add
   `|| companion_enabled`.
   - Otherwise X destroys `"main"`, and Tauri **does not exit**, because
     `"parrot"` is still open.
   - That leaves an invisible process with no Start-25 handler (§4.3), no
     Firebase settings, and no way to quit.
   - **Default ON changes this for nearly everyone.** X hides instead of exits
     for any user who hasn't turned the parrot off, which overrides 1.2.9's
     "close = exit" default for signed-in users. 1.2.9 test 1-e still holds
     only with the companion off. Signed out, the overlay is hidden, so X
     should still exit.
2. **A tray icon whenever the overlay exists**, because the overlay is the
   only visible thing left. Tray menu additions:
   - "Show parrot" / "Hide parrot" (toggles `enabled` locally *and* writes
     `config/companion/enabled`, via the main webview). The bird's own **Hide**
     menu item does the same, and this is the way back from it.
   - "Quiet 1h" (`emitTo("parrot", …)`)
3. **Quit** (allowed when not armed, per item 1) must `app.exit(0)`, which
   closes both windows. Do not rely on "last window closed".
4. **`--silently` boot (item 1 step 5):**
   - The overlay **does** start on a silent boot, so the bird is there at
     login.
   - `"main"` stays hidden but its webview is created, so Firebase and the
     start handler are live.
   - The 3 s delay before creating the overlay still applies.
5. **The single-instance callback** (`lib.rs:1437-1445`) shows `"main"` only;
   it never shows or focuses `"parrot"`. No change beyond item 1's.
6. **Session sign-out (item 1 risk):** two windows add nothing new. The
   overlay has no `CloseRequested` handler, so it closes with the session.

**Order (answer 5):** tray mode and the per-window command ACL ship in 1.2.9.
The parrot ships in **1.3.x** and is not usable without them.

---

## 6. Privacy page and Store listing

**`lockin-website/privacy.html`** (separate repo):

Default ON means this must say so plainly; users won't have opted in first.

- **`:142` "App settings" row:** append "…and your parrot companion settings
  (on/off, quiet hours, how often it may speak)."
- **`:210-216` "What stays on your device"**, new bullet for **v0.1**:
  > **Parrot companion (desktop, on by default; turn it off in the app's
  > settings):** to know when to hide or speak, the app checks whether the
  > window in front fills your screen, and how long since you last used the
  > keyboard or mouse. It does not read window titles, window contents, or which
  > apps are open, and none of this is stored or sent anywhere. Its nudge
  > timings are kept on your device.
- **v0.2 replaces that bullet.** Title bars add "the position and size of visible
  windows on your main screen, about twice a second". Distraction-aware nudges
  add "which app is in front, compared against your blocklist on your device".
  The "or which apps are open" clause **must** come out at that point
  (disagreement I).
- **v0.2 Bedtime (§4.5):** the `:142` row also lists "your bedtime, if you set
  one", because that time is stored in the account. No new window reads.
- **"What we never collect" (`:116-121`):** no change. The new reads are
  geometry and an idle timestamp, not keystrokes. If asked: `GetLastInputInfo`
  returns *when*, never *what*.
- **`:107` and `:263`:** bump "Last updated".

**Store listing (Partner Center), feature bullet (v0.1):**

> An African grey parrot who walks along the bottom of your screen, naps while
> you focus, and now and then suggests a 25-minute session. On by default. Click
> it for quiet for an hour or for the day, or turn it off in settings.

**Store listing, privacy and "what's new" line (v0.1):**

> The parrot checks whether a full-screen app is in front so it can get out of
> the way. That happens on your PC only; nothing about your windows is uploaded.

**From v0.2:** "The parrot reads where your windows are so it can perch on them.
That happens on your PC only; nothing about your windows is uploaded."

`Package.appxmanifest:56` (`Description`) stays: it describes the core app.

---

## 7. Phase B plan

Phase B builds **v0.1** only, for **1.3.x**. **It starts after 1.2.9 ships tray
mode.**

### 7.1 Commits, in order

| # | Commit | Effort | Notes |
|---|---|---|---|
| 0 | **Prereq:** 1.2.9 tray mode, plus the per-window command ACL and capability directory move | (1.2.9) | Must be on master first (§1.5, §5). |
| 1 | `desktop: windows crate unconditional; companion.rs full-screen and idle reads + unit tests` | 2 h | Pure `covers_monitor(window_rect, monitor_rect)`. Tests: exact cover, larger than monitor, one pixel short, on another monitor. |
| 2 | `desktop: parrot capability` | 30 min | `parrot.json` in both directories; `tauri.store.conf.json`. Verify with 1.2.9 item 3's marker: both builds still grant autostart/updater as before. |
| 3 | `desktop: parrot overlay window, companion thread, hit-test thread, commands` | 1 d | `companion_set_enabled`, `companion_set_hitbox`, `companion_set_dragging`, events `parrot-world`/`parrot-geometry`; `parrot-ready` plus signed-in → show; `LockProfile.companion_enabled` defaulting to true. |
| 4 | `desktop: emit enforcer-armed on arm and on restore` | 1 h | Two `emit` lines plus a payload struct; the main window ignores it. |
| 5 | `web: add vitest for the animator and state machine` | 1 h | Answer 3. `test` script in `apps/web/package.json`, and `apps/web` only. Covers `machine.ts` and frame timing in `sprite.ts`; commit 7 adds the `nextBubble()` tests. |
| 6 | `web: parrot.html entry, animator, state machine, placeholder squares` | 1 d | Multi-page Vite input, own CSP, no global.css; reduced motion; drag; fall. |
| 7 | `web: parrot wiring — sleep on session, nudge scheduler, bubble and menu, Start 25 bridge` | 1 d | `nextBubble()` pure, with vitest tests: quiet hours across midnight, one bubble per interval, Quiet 1h and Quiet today, idle user, and one bubble (not a backlog) after a long sleep. App.tsx listener reusing `startSession`. |
| 8 | `rules: config/companion + emulator tests` | 2 h | Then the deploy cycle. |
| 9 | `web: Parrot companion settings in Block Registry; settings bridge` | 0.5 d | `useCompanionSettings`; `companion:hello`. |
| 10 | `tray: parrot show/hide/quiet items` | 1 h | On top of commit 0. |
| 11 | (website repo) `privacy: parrot companion` | 30 min | §6. |
| 12 | `web: real sprites` (when the art lands) | 0.5 d | Swap sheet + JSON; tune hitbox/pivot. |

**Total ≈ 5 working days**, excluding commit 0 and waiting on art.

**v0.2, once v0.1 has shipped, about 4 days:**

- Title-bar perching and `fly` (geometry module, occlusion tests, perch tracking).
- Weighted care lines (water, stretch, with their own off switch) and jokes.
- Streak mood.
- **Bedtime and the sleepy parrot** (§4.5): setting, rules and emulator tests,
  sleepy state, bedtime nudges with Going to bed and Quiet tonight, about 1 day.
- **Showing Day Plan's Sleep mode** (§4.5), from `SleepView`. Day Plan §11.1 budgets
  this at 2 h, in whichever of the two ships second. With no `SleepView` the parrot
  simply shows no status, so neither has to wait for the other.

Distraction-aware nudges need their own short Phase A first (disagreement I).

### 7.2 Exact runtime tests

Use the NSIS release build unless the test says otherwise; repeat the ★ ones
on MSIX.

**Window (1)**

- **1-a ★** Sign in on a fresh install with no `config/companion`. A bird
  (placeholder square) appears on its own, within 4 s of the dashboard, with
  **no black/white flash**. Watch with a phone camera at 240 fps if needed. On
  the Login screen there is no bird. Upgrade from an older state file with no
  `companion_enabled`: the bird still appears, and the first bubble says how to
  quiet it.
- **1-b ★** Click and type in Notepad, browser and Explorer everywhere except
  the bird. Every click lands in the app beneath. The overlay never takes
  focus: the caret stays in Notepad when you click the bird. Alt-Tab never
  lists "Lock-In parrot" and the taskbar has no extra button.
- **1-c** Move the cursor on and off the bird 100 times quickly. No flicker,
  transparency is intact, no crash. Log line count of ignore toggles ≤ 200.
- **1-d** Drag the bird across the screen and release in mid-air: it falls to
  the bottom edge. (v0.2: release over a window's title bar and it lands there.)
- **1-e** 150 % scaling on the primary display: the overlay exactly covers
  the work area (no gap above the taskbar). Change scaling to 125 % live: it
  re-fits within 1 s.
- **1-f** Move the taskbar to the left edge (Win 10 VM), and separately turn on
  auto-hide on Win 11: the bird walks on the bottom of the primary work area and
  is never under the taskbar.
- **1-g** Two monitors: the bird stays on the primary. (v0.2: a window on the
  secondary is never a perch.)

**Rust polling (2)**

- **2-a (v0.2)** A window perch: drag Notepad slowly. The bird rides it with ≤ 100 ms
  lag. Minimise Notepad: the bird flies off within 0.5 s.
- **2-b (v0.2)** Cover half of Notepad's title bar with another window: the bird
  only perches on the uncovered half.
- **2-c ★** Open a full-screen game or video (F11 in Edge; YouTube full
  screen; PowerPoint slideshow): the bird is gone within 0.5 s and back within
  1.5 s of leaving.
- **2-d ★** Start a 25-min session with Notepad blocked while the companion
  runs: Notepad is still killed within 2–3 s (sniper log timing unchanged
  versus companion off over 20 ticks).
- **2-e (v0.2)** Switch virtual desktop: no perches from the other desktop.
- **2-f ★** During a session, open a full-screen video: the sleeping bird hides,
  and comes back asleep when you leave full screen.

**Web and CPU (3)**

- **3-a ★** Run the §3.4 recipe. Record steps 1–4.
  - Pass: perched delta ≤ 1.0 %, asleep delta ≤ 0.5 %.
  - Also record the Rust poll time from a `[Companion] poll took X µs` debug
    log (DEV only).
- **3-b** Windows "Animation effects" off: the bird stays still in one spot;
  dragging works; turn the setting on again and walking resumes without a
  restart.
- **3-c** DevTools are off in the overlay (F12 does nothing).
- **3-d** `pnpm --filter @lock-in/web test` passes (state machine, frame timing
  and `nextBubble()`).

**Wiring (4)**

- **4-a ★** Start 25 from the Dashboard: the bird sleeps within 1 s and stays
  visible. Session ends: it wakes, plays `happy`, and says a non-guilt line.
- **4-b** Bail out (DEV 30 s fuse): when the fuse burns, the bird wakes with
  the neutral line, not a celebration.
- **4-c ★** Default settings: stay active for 15 min after a session. Exactly
  one nudge appears, with Start 25, Not now and Quiet 1h. Stay active another
  14 min after dismissing with **Not now**: no second nudge. At 15: the next one
  appears. Click **Start 25**: a session starts, the Dashboard shows it, Firebase
  `sessionState.isActive` is true, Notepad gets killed, and the bird sleeps.
- **4-c2** Click the bird: the menu shows Start 25, Quiet 1h, Quiet today and
  Hide. Quiet 1h: no bubble for an hour. Quiet today: none until tomorrow. Hide:
  the bird goes, `config/companion/enabled` is false, and tray → Show parrot
  brings it back.
- **4-d** Hide the main window (tray), then Start 25 from the bubble: the
  session starts without the window popping up.
- **4-e** Signed out (Login screen), click Start 25: refused, the main window
  shows, and the bird says to open Lock-In.
- **4-f** Quiet hours set to cover now: no bubble for 30 min. Set the PC clock
  forward past the end: a nudge can appear on the next 30 s check.
- **4-g** Leave the PC untouched for 10 min past `nudgeAfterMin`: no bubble.
  Touch the mouse: a bubble within 30 s.
- **4-h** Sleep the laptop for 2 h and resume: at most **one** bubble, not a
  backlog.
- **4-i** Restart mid-session: the bird boots asleep (`get_enforcer_state`
  probe).

**Settings (5)**

- **5-a** Emulator suite passes. Deploy, then deep-compare.
- **5-b** Toggle the companion on device A: the bird appears or disappears
  within 2 s. Change quiet hours on A: a second desktop B (same account)
  follows.
- **5-c** Offline boot: the last settings apply from the snapshot and cache.

**Tray (6)**

- **6-a ★** Default settings, no session: click X. The main window hides, the bird
  stays, and the tray is present. Tray → Quit: both are gone and the process
  exits.
- **6-b** Autostart `--silently`: after login, the bird is there and the main
  window is hidden.
- **6-c** Companion off, or signed out: click X. The process exits, as it does
  today.

**Bedtime (v0.2, 7)**

- **7-a** Bedtime off (default): nothing changes at 00:30. Turn it on with bedtime
  a few minutes ahead and quiet hours at their defaults: at that time the bird goes
  sleepy and one nudge appears, with the correct time in the line.
- **7-b** Stay active: the next nudge comes 30 min later, not sooner, and no focus
  or care line appears in between.
- **7-c** Quiet tonight: no more bedtime nudges until `quietEnd`, and the bird stays
  sleepy. Going to bed: the bird sleeps until `quietEnd`, and the PC is untouched.
- **7-d** Press Quiet today at 23:00 with bedtime 00:30: no bedtime nudge that night.
- **7-e** Start a session inside the window: the bird sleeps, no bubble appears until
  it ends, and then it returns to sleepy. Close the lid for 2 h inside the window: at
  most one bubble on resume.
- **7-f** Animation effects off: `droopy_idle` frame 0, no yawn.
- **7-g** Care lines off: 2 hours of normal use shows no water or stretch line.
- **7-h** (once Day Plan's Sleep mode is built; this is also its T-S10) Sleep mode
  `active` at Enforce, inside the parrot's quiet hours: the bird plays `sleep`, the
  click menu shows "Sleep mode until 7:00", and no nudge appears, with Bedtime on
  too.
- **7-h2** Same setup (T-S11 covers the event itself). Launch a Play app while
  `active`: it gets killed, and one bubble appears with the line and no buttons.
  Relaunch it repeatedly for 10 min: no second bubble. With Quiet tonight set: the bubble
  still appears. A Play app that ignores the soft close and is killed while full-screen:
  the bird reappears, then shows the bubble.
- **7-h3** A Play app that closes on the T-0:30 soft close: no bubble. Notify
  (`reminded`): no status line, and Bedtime works as normal. Sleep mode ends: the bird
  wakes with no line.
- **7-h4** During a session, with Sleep mode `active`, a Play app is killed: no bubble.
  After the session, the next kill still shows one.
- **7-h5** (with T-S12) Bail out: the menu line and any bubble say "Sleep mode ends at"
  the `ends_at` time, not "until 7:00". Bail out 10 s before the window's end on the DEV
  fuse: the time shown is the window's end.
- **7-i** Re-run §3.4 with the bird sleepy: delta ≤ 1.0 %.

### 7.3 Sprite-sheet spec for the artist

**Character:** original African grey parrot, in the **Notebook sticker style**.
Grey scalloped body, **red tail**, black beak, pale face patch. Drawn **facing
right**; the code mirrors for left, so avoid asymmetric marks or text. For the
style, see the Notebook stickers in `apps/web/src/theme/stickers.tsx:24-26` and
below: flat colour, dark `#2B3A55` line, white die-cut border.

**Frame:** square, with the bird filling about 70 % of the height.

**Pivot:** bottom-centre is the feet contact point, **identical in every
frame of every state**. Leave a 4 px (at 1×) transparent margin below the
feet so the bird sits on an edge rather than overlapping it.

| Scale | Frame | Max sheet (12 cols × 17 rows) |
|---|---|---|
| 1× | 96 × 96 px | 1152 × 1632 |
| 1.5× | 144 × 144 px | 1728 × 2448 |
| 2× | 192 × 192 px | 2304 × 3264 |

At 1× the bird displays at 96 CSS px. The page picks the sheet by
`devicePixelRatio`: ≤ 1.25 → 1×, ≤ 1.75 → 1.5×, else 2×.

**Format:**

- PNG-32, sRGB, **straight (non-premultiplied) alpha**.
- **White die-cut border baked into the art**, 1 px at 1× (scaled to 1.5/2 px),
  outside the dark line. It keeps the bird legible on any wallpaper or window
  colour, light or dark.
- **No soft shadow and no semi-transparent matte.** The app's stickers add their
  shadow in CSS, but a filter on a moving sprite would repaint it each frame.
- One sheet per scale, **one row per state** in the order below, frames
  left-aligned, empty cells transparent.
- Also deliver the source (Aseprite `.ase` or layered `.psd`) and an
  Aseprite-style JSON (`frames[]`, `frameTags[]`).

| Row | State | Frames | fps | Loop | Notes |
|---|---|---|---|---|---|
| 1 | `idle` | 6 | 6 | yes | Breathing; frame 0 is the reduced-motion pose |
| 2 | `idle_blink` | 3 | 12 | no | Played every 2–6 s over idle |
| 3 | `idle_preen` | 8 | 8 | no | Occasional variation |
| 4 | `walk` | 8 | 10 | yes | Side-on waddle; stride ≈ 12 px at 1× per cycle |
| 5 | `takeoff` | 4 | 12 | no | Ends wings up |
| 6 | `fly` | 6 | 12 | yes | Wing cycle; body level |
| 7 | `land` | 4 | 12 | no | Ends in the `idle` pose |
| 8 | `perch` | 4 | 4 | yes | Sitting low, toes gripping; subtle. Used on the bottom edge in v0.1 |
| 9 | `sleep` | 4 | 2 | yes | Head tucked, slow breathing; frame 0 for reduced motion |
| 10 | `talk` | 6 | 8 | yes | Beak open/close, head bob |
| 11 | `drag` | 4 | 8 | yes | Held, flapping, legs dangling |
| 12 | `wake` | 5 | 10 | no | Sleep → idle |
| 13 | `peck` | 6 | 10 | no | Pecks at the surface it stands on; idle variation |
| 14 | `happy` | 8 | 10 | no | After a finished session: a small hop and wing lift; calm, not frantic |
| 15 | `sad` | 6 | 6 | yes | Mild droop, not crying; **not used until v0.2** (disagreement J) |
| 16 | `yawn` | 8 | 8 | no | Big beak-open yawn, eyes shut; starts and ends in the `droopy_idle` pose. **v0.2** |
| 17 | `droopy_idle` | 6 | 4 | yes | Half-closed eyes, slow breathing, slight nod. Tired, not unhappy, and clearly different from `sad`. Frame 0 is the reduced-motion pose. **v0.2** |

That is 96 frames. Commission them all at once, even though `fly`, `takeoff`,
`land`, `sad`, `yawn` and `droopy_idle` aren't used until v0.2. **Placeholder until the art lands:**
solid 96 px squares, one colour per state, the state name drawn in text, the
same JSON shape.

### 7.4 Later

**v0.3 (design doc):** extension in-page companion, friends' parrots via The
Pack, more animals. Not designed here.

**Daily "play budget" countdown:** out of v0.1; **the Day Plan design will define
it** (disagreement L). That covers how play time is measured, against which apps,
and when it resets. Whatever it needs from the parrot, such as a badge, settings
or a sprite row, gets designed once that exists.

### 7.5 Decisions

The five original decisions and the three that came out of reconciling are all
answered and applied. The doc follows the design doc's v0.1 scope rather than the
original brief's (disagreement B), so title bars wait for v0.2.

**Bedtime (§4.5), settled by the owner:** bedtime nudges ignore quiet hours; focus,
care and joke lines stop after bedtime; morning is `quietEnd`; "sleep at night"
leaves the care pool; Quiet today lasts until morning; lines use the real clock
time. Sleep mode is defined in Day Plan §11.1, and the parrot reads its `SleepView`
as status.

Day Plan §11.1 now has `day-sleep-closed` and resolves `ends_at` during a fuse, so §4.5
matches it and nothing is open between the two docs.

**The "Play app closed" bubble, decided by the owner:** max one bubble per 30 min (only
shown bubbles count); it ignores Quiet 1h, Quiet tonight and quiet hours; none during a
session.

**STOP. Phase A ends here.**
