# Parrot v0.1: laptop tests

Run these yourself on the build from the `parrot` branch. Tick a test only if you
saw the expected result. If you see something else, write down what you saw and
carry on.

## Before you start

- **Use a test account.** Every session here credits the signed-in account and sets
  its `presence` to locked-in. Sign out of your own account first.
- **Block only something harmless.** A session kills what the account blocks. On the
  test account, block Notepad and nothing else, and keep no unsaved work in Notepad.
  Add a site block only for test 2.
- **Quit any other copy of Lock-In** from the tray. Only one copy can run at a time.
- **Bubbles are slow on purpose.** A nudge needs at least 30 minutes since the last
  bubble or session, you active in the last 5 minutes, outside quiet hours and
  outside Quiet. A brand-new account's first bubble is the hello line, on the same
  clock. Keep working normally while you wait, and group the bubble tests together.
- **Sign in once on the test account and wait.** The bird appears within about 4 s of
  the dashboard, with no black or white flash. There is no bird on the Login screen.

## Sessions

1. **Finished Micro shows the happy line.** Start a 2-minute Micro from the dashboard
   and let it run out.
   - Within about 2 s of starting, the bird is asleep and stays visible.
   - At the end it wakes, hops (`happy`), and says "Nice. That's done." with Quiet 1h.
   - If a bubble was shown in the last 30 minutes, the line is held back, by design.
     Wait 30 minutes after any bubble before this test.

2. **Start 25 from the bird, with the pre-start question.** Add a site block, leave a
   browser open, and hide the main window to the tray. Click the bird, then Start 25.
   - The main window comes forward with the pre-start question ("Start and close
     other browsers" / "Start and leave them open").
   - After you answer, the session runs and the bird sleeps. The dashboard shows 25
     minutes. No duration other than 25 is offered by the bird.
   - End it with End task from the dashboard. Do not use Bail out on an account you
     care about. The bird wakes and says "Back to it whenever.", with no hop.

3. **Start 25 with nothing to ask.** Remove the site block, hide main to the tray, and
   click Start 25 again.
   - The session starts and the bird sleeps. The main window does not pop up.

4. **Restart during a session.** During a Micro, use Task Manager to end Lock-In, then
   reopen it.
   - The bird comes back already asleep.

## Bubbles, with real clicks

5. **Start 25 on a nudge bubble.** Wait for a nudge ("Lock in! Lock in!" or "What are
   we working on?") and click Start 25.
   - The bubble closes and a 25-minute session starts. End it with End task.

6. **Not now.** On the next nudge, click Not now.
   - The bubble closes. No other bubble for at least 30 minutes.

7. **Quiet 1h on a bubble.** On the next nudge, click Quiet 1h. Note the time.
   - The bubble closes. No bubble for one hour, even after a session ends in that hour.
   - After the hour passes, a bubble can appear again.

8. **A bubble left alone.** Do not touch the next one.
   - It closes by itself after about 12 s. It takes no focus while it is up: your
     typing stays in the window you were using.

9. **Click-through around the bird.** With a bubble showing, click on the window behind
   it, just outside the bubble. Then click just outside the bird.
   - Both clicks land on the window behind.

## The menu, Quiet and Hide

10. **Menu.** Click the bird once.
    - The menu shows Start 25, Quiet 1h, Quiet today and Hide. During a session it has
      no Start 25. It closes by itself after about 10 s, or if you click the bird again.
    - Your caret stays in the window you were typing in, and Alt-Tab has no parrot.

11. **Quiet today.** Pick Quiet today from the menu.
    - No bubble until your quiet-hours end time (08:00 by default), not until midnight.

12. **Quiet hours.** In Protocols, Block Registry, set quiet hours to a window starting
    now, then wait past when a nudge would be due.
    - No nudge and no session-end line during quiet hours.
    - Set them back afterwards, and nudges return.

13. **Hide from the menu.** Pick Hide.
    - The bird goes within about 2 s. The settings toggle shows off. The tray's Show
      parrot is unticked.

14. **Tray toggle with main hidden.** Hide the main window to the tray. Right-click the
    tray icon and click Show parrot.
    - The bird comes back within about 2 s and the item is ticked. Click it again: the
      bird goes and the item is unticked. Main stays hidden both times. Leave it on.

15. **Settings toggle.** In Block Registry, turn the parrot off, then on.
    - The bird goes, then comes back, within about 2 s each. The tray tick follows it.

16. **Sign out.** Sign out with the bird showing.
    - The bird goes, and the tray's Show parrot is unticked. Clicking it while signed
      out leaves it unticked and shows no bird.

17. **Closing.** With close-to-tray off in settings, click X on the main window.
    - The whole app exits, bird included. Turn close-to-tray back on.

## Moving the bird

18. **Walking.** Watch for a few minutes.
    - It walks along the bottom of the work area, pauses, pecks and sits, with its feet
      moving at walking speed and no shaking or stutter. It never goes off screen.
      It reaches both the far left and the far right.

19. **Drag and fall.** Drag the bird quickly around the screen and release it mid-air.
    - It stays under the cursor with no lag you'd notice, and it falls to the bottom
      edge. Try fast shakes, each corner, and dragging past the edge of the screen. It
      stays on the primary monitor and never gets stuck to the cursor after release.

20. **A menu near the edges.** Drag the bird to the far left, then far right, and click
    it each time.
    - The whole menu is visible each time, and every item can be clicked.

## Full screen

21. **Maximised vs F11.** In a browser window, maximise it, then press F11, then F11 again.
    - Maximised: the bird stays visible.
    - F11: the bird is gone within 0.5 s.
    - F11 off: it is back within about 1.5 s.

22. **Full-screen video during a session.** Start a Micro and put a video in full screen.
    - The sleeping bird hides within about 2 s and comes back asleep when you leave.

23. **A game.** Run a game in exclusive full screen, then in borderless full screen if
    it offers that.
    - The bird is hidden in both, and returns when you Alt-Tab to a normal window on
      that monitor.

24. **PowerPoint slideshow.** Start a slideshow on the laptop screen.
    - The bird is gone within about 0.5 s and returns when the show ends.

25. **Win+D.** Press Win+D, wait, then press it again.
    - The bird comes back within about 1 s of Win+D and stays on top of the desktop.

## Windows settings

26. **Reduced motion.** Turn off Settings, Accessibility, Visual effects, Animation
    effects. Leave Lock-In running.
    - The bird stops walking, and sits still in one spot in one pose, also when asleep.
      You can still drag it, and it drops straight down with no fall.
    - Turn the setting back on: walking resumes with no restart.

27. **DPI: 100 %, 125 %, 150 %.** Change display scale live, once each.
    - Within about 2 s the bird is back on the bottom edge, sharp, at the same apparent
      size. A bubble and the menu are complete and clickable at each scale. Drag it at
      each scale: it stays under the cursor.

## Taskbar

28. **Left, top, right** (where Windows allows it). Move the taskbar to each edge.
    - The bird is never under the taskbar, and walks on the bottom of the work area.
      It reaches the edge next to the taskbar without going behind it.

29. **Taskbar not auto-hidden, at the bottom.**
    - The bird stands directly on top of the taskbar with no gap.

30. **Taskbar auto-hidden.**
    - The bird stands on the bottom edge of the screen. The taskbar still pops up and
      hides normally. Decide whether the taskbar covering the bird when it pops up is OK.

## Second monitor

31. **Where it lives.** Connect a second monitor. Drag the bird toward it.
    - The bird stays on the primary monitor and stops at the shared edge.

32. **Full screen on the other monitor.** Put a browser in F11 on the second monitor,
    then click into it.
    - The bird **stays visible** on the primary monitor.

33. **Full screen on the bird's monitor, focus elsewhere.** Put a browser in F11 on the
    primary monitor, then click into a window on the second.
    - The bird stays hidden.

34. **A game or slideshow on the other monitor.** Run a game, or a PowerPoint slideshow,
    on the second monitor, with the first monitor showing normal windows.
    - The bird stays visible on the primary monitor, whether focus is on either monitor.

35. **Slideshow on the bird's monitor, presenter view on the other.**
    - The bird stays hidden during the show.

36. **Unplug and replug the second monitor** with the bird showing, and again with the
    primary changed if you can.
    - The bird ends up on the new primary's bottom edge, within about 2 s.

## MSIX

37. **Install the MSIX.** Build it with `pnpm --filter @lock-in/desktop pack:msix`
    (needs `winapp` and `devcert.pfx`), trust the dev certificate, and install it. Quit
    the NSIS copy first.
    - It installs and opens. Sign in with the test account: the bird appears.
    - Repeat tests 1, 10, 13, 14 and 19 on it. All behave the same.

## Release build

38. **No parrot files.** On the NSIS release build, click the bird a few times, then
    look in `%APPDATA%\com.lockin.app`.
    - No new `parrot-menu.log` appears. (An older one from my testing may be there on
      your desktop PC. It is safe to delete.)

## Not yet measured

39. **CPU and memory on the laptop.** With the bird awake and no session, then during a
    Micro, watch Lock-In in Task Manager's Details tab for 5 minutes each.
    - Nothing stays busy, the fan doesn't rise, and it matches this PC's numbers in the
      final report within reason.

## Open question from testing

40. **Focus after closing main.** Click into the main window, then click X so it hides
    to the tray. Straight away, type something harmless, and watch what has focus.
    - The window you were in before, or another normal window, gets focus. The bird
      must not. If your typing goes nowhere until you click, the overlay took focus:
      write that down. It showed up once in a measurement run on the desktop PC and
      could not be reproduced there.
