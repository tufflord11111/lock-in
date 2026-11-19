# Lock-In 1.3.1 — laptop checklist (one sitting, DEV_MODE build)

Run everything signed in to the **test account** (lockintest10), never your real one. Commands are PowerShell. Tick each line; a failure is a stop, not a note.

Expected times assume DEV_MODE: the 2-minute Micro session is shown. The Bail out fuse is 5 minutes in DEV_MODE too (the rules refuse a shorter one), so Bail out steps use a 25-minute session, which the fuse ends first.

## Setup

1. Build the test exe from the branch:
   ```powershell
   cd C:\dev\lock-in-sec
   pnpm --filter @lock-in/desktop build:dev
   ```
   Copy `apps\desktop\src-tauri\target\release\app.exe` to the laptop as your next `app-gen-vN.exe` (and to `C:\dev\parrot-builds`).
2. Turn on DEV_MODE on the laptop:
   ```powershell
   New-Item -ItemType Directory -Force "$env:APPDATA\com.lockin.app" | Out-Null
   Set-Content -Path "$env:APPDATA\com.lockin.app\DEV_MODE" -Value "1" -Encoding utf8
   ```
3. Web Guard 1.3.1 isn't in the store yet. In Chrome: `chrome://extensions` → Developer mode on → **Load unpacked** → `apps\extension\dist`. Copy its 32-letter id, then:
   ```powershell
   Set-Content -Path "$env:APPDATA\com.lockin.app\DEV_EXTENSION_ID" -Value "<the id>" -Encoding utf8
   ```
   Remove the store copy of Web Guard from that Chrome profile so only 1.3.1 runs. Sign Web Guard in to the test account. Turn on **Allow in Incognito** for it (step 6 turns it off again on purpose).
4. Start the test exe. In Settings, the Pro row ("Pro — not available yet") and the study row ("Help find out whether Lock-In helps", **Off**) sit between the parrot settings and Delete account.

## Check-ins (items 1, 2, 5)

5. **Forged check-in refused.** With Lock-In running:
   ```powershell
   curl.exe -s -o NUL -w "%{http_code}`n" -X POST -H "Origin: chrome-extension://pcmcaccnegefcjhdabjjfhaakjfeocea" -H "Content-Type: application/json" --data '{\"browser\":\"chrome\",\"uid\":\"x\",\"incognitoAllowed\":true}' http://127.0.0.1:47823/beat
   ```
   Expect **403**. Repeat with your unpacked id in the Origin: still **403**.
6. Start a 25-minute session that blocks sites, with Chrome open and Web Guard running in it. Chrome stays open.
   - **Guest window:** Chrome profile menu → Guest. Within about 5 s comes the warning ("Chrome has a window Web Guard can't see …"), and Chrome is closed about 12 s later. Reopen Chrome; it is closed again in about 5 s (it stays closed for this session).
   - End the session (wait it out or Bail out), start a new one, and repeat with **a second Chrome profile** that has no Web Guard: same result.
   - New session. Open Chrome with its own folder: `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:TEMP\lockin-udd"`. Same warning and close.
   - Incognito is covered in steps 7a–7c below.
   - New session. Web Guard → Site access → **On click**: warning ("… its site access is limited …"), then the close. Set it back to **On all sites**.
7. **Web Guard disabled.** New session, Chrome open with Web Guard. Note the time and turn Web Guard off in `chrome://extensions`. The warning comes at about 35 s and Chrome is closed by about **47 s** (well within 60 s). The Firefox, Opera or Edge-without-Web-Guard case is unchanged: warned and closed.
### Incognito (item 13) and things that must not close a covered browser (item 14)

Each step: start a 25-minute session that blocks sites, with Chrome open and Web Guard 1.3.1 running and signed in, then open the thing named. Keep it open **60 s**. What must not happen: no "Lock-In is closing a browser" warning or toast, and Chrome isn't closed. Close the thing again before the next step. For the Edge steps, do the same in Edge with Web Guard 1.3.1 loaded unpacked there too.

To see the counts while you test: from `C:\dev\lock-in-sec\apps\desktop\src-tauri`, run `cargo test --lib -- --ignored window_counts_on_this_pc --nocapture`. It prints how many windows Lock-In counts per browser instance; it should equal the windows Web Guard sees.

7a. **Incognito access off, no Incognito window.** Turn **Allow in Incognito** off for Web Guard. Must not happen within 60 s: a warning or a close. The Start dialog, if a session is started now, says "Web Guard isn't allowed in Incognito in Chrome. If an Incognito window is open during this session, that browser is closed after a warning."
7b. **Incognito access off, Incognito window open.** Still off: Ctrl+Shift+N. Within about 5 s comes the warning ("… most likely an Incognito window: Web Guard isn't allowed in Incognito …"), and about 12 s later Chrome is closed. *(This one must happen.)*
7c. **Incognito access on, Incognito window open.** Turn **Allow in Incognito** on, start a new session, Ctrl+Shift+N. Must not happen within 60 s: a warning or a close.
7d. **Installed web app (PWA), Chrome.** Install one (e.g. open `https://squoosh.app` → address bar install icon → Install), then open it from Start. Must not happen within 60 s: a warning or a close.
7e. **Installed web app, Edge.** The same in Edge (… menu → Apps → Install this site as an app). Must not happen within 60 s: a warning or a close.
7f. **Undocked DevTools.** F12, then DevTools' ⋮ → Dock side → Undock into separate window. Must not happen within 60 s: a warning or a close.
7g. **Extension popup.** Click Web Guard's toolbar icon so its popup is open (and another extension's, if any). Must not happen within 60 s: a warning or a close.
7h. **Picture in picture.** Play any video on an allowed site and choose Picture in picture (right-click twice on the video, or the PiP button). Also try a site using document picture-in-picture if you have one (e.g. Google Meet's PiP). Must not happen within 60 s: a warning or a close.
7i. **Edge sidebar and Copilot.** In Edge, open the sidebar (Copilot button, and one sidebar app). If the sidebar offers "Detach from Edge"/"Open in a separate window", do that too. Must not happen within 60 s: a warning or a close. *(Only the laptop can prove this one; the unit tests model it as a tool window.)*
7j. **Print dialog.** Ctrl+P (Chrome's print preview), then "Print using system dialog" (Ctrl+Shift+P). Must not happen within 60 s: a warning or a close.
7k. **Download dialog.** Right-click a link on an allowed site → Save link as… (the Save As dialog), and the downloads bubble at the top right. Must not happen within 60 s: a warning or a close.
7l. **Cast.** ⋮ → Cast, save and share → Cast… (the Cast dialog, even with no device found). Must not happen within 60 s: a warning or a close.
7m. **Fullscreen and minimized.** F11 on a tab, then minimize a second Chrome window. Must not happen within 60 s: a warning or a close.

8. **Mirrors.** During a session that blocks youtube.com, each of these shows Web Guard's block page:
   - `https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ`
   - `https://yewtu.be/`
   - `https://www-youtube-com.translate.goog/`
   - `https://web.archive.org/web/2024/https://www.youtube.com/`

   `https://translate.google.com/` and `https://web.archive.org/` stay open.

## Clocks (item 4)

9. **Time zone across midnight: no second bail-out.** Settings → Time & language → Date & time: turn off *Set time zone automatically*. Pick a zone where it's about 23:50. Start a 25-minute session and Bail out; let the 5-minute fuse burn down. Pick a zone a few hours ahead (now "tomorrow"). Start a 25-minute session and hold Bail out: **"You've already bailed out today."** Put the zone back to automatic.
10. **Clock forward doesn't end the session early** (needs admin). Start a 25-minute session with a blocked app (e.g. Notepad). Turn off *Set time automatically* and set the clock 2 hours ahead. Expect: the session keeps running, the countdown shows the same minutes left as before (no toast every second), Notepad is still closed within 3 s of opening, and the session ends 25 real minutes after it started, recorded **completed**. Put the clock back to automatic.
11. **Sleep across the deadline ends it normally.** Start a Micro session. Sleep the laptop (Start → Power → Sleep) for 4 minutes and wake it. The session ends on wake, at its own end time; History shows it completed with the minutes before sleep only.

## Waitlist and study (items 8, 10)

12. **Waitlist card after the first completed session, never during one.** The card is once per PC (`lockin.proAsked`), and this laptop hasn't shown it yet. Start a Micro session. No card appears while it runs. It ends; after the History entry is written (a minute at most) the card "Lock-In Pro is not built yet" appears. It shows no price for Pro and no checkout. Tick two features, pick S$3, press notify. It says "Nothing charged. Nothing built yet." Close the app and reopen it: the card doesn't come back. Settings' Pro row now says the same.
13. **Study consent on/off.** Settings → the study row shows Off, with the full consent text. Turn it On, then Off, then On. In Firebase (console, test account): `config/study` is `{consented: true, consentedAt: <server time>, v: 1}` after the last switch. The day-14 question can't be waited for in one sitting: the rule and its timing are covered by `phaseb.test.cjs` and `study.test.ts`.

## Records (unchanged paths still work)

14. **Normal end writes to Firebase.** A Micro session that runs out: History shows it completed, and `sessionHistory` and `history/<today>` gain it.
15. **Bail out writes to Firebase.** A 25-minute session, Bail out, wait the 5 minutes: History shows it bailed out with 0 minutes; `sessionHistory` has `status: "bailed-out", bailedOut: true`.

## Basics

16. **Micro kill ≤ 3 s.** Block Notepad, start a Micro session, open Notepad 5 times: each is closed within 3 s.
17. **Lock-In never kills itself.** Block `app`, `lock`, `msedge` and `msedgewebview2` as app names; start a session. Lock-In's window and tray stay alive for the whole session; Edge (msedge.exe) is closed if open.

## Clean up

18. Delete `DEV_MODE` and `DEV_EXTENSION_ID` from `%APPDATA%\com.lockin.app`, remove the unpacked Web Guard, and put the clock and time zone back to automatic.
