# Lock-In 1.3.0

What's changed since 1.2.7.

## A parrot keeps you company

An African grey now lives on your desktop. It walks along the bottom of the screen, flies up to a
branch on the right edge now and then, and naps there while a session runs. Now and then it
suggests a session, at most once every 30 minutes by default, and never in your quiet hours. Click
it for its menu, drag it somewhere else, or hold the right button and rub it to pet it.

It's on by default. Turn it off with **Show the parrot** in parrot settings (in the Block
Registry) or **Show parrot** in the tray menu. Its settings follow your account. The branch
height is a slider in parrot settings, and it stays on this PC.

## Browsers close during sessions that block sites

New: every session that blocks websites closes browsers that can't block them, after a 10 second
warning (a Windows notification if the window is hidden). They close again if reopened, until the
session ends. Anything typed and not sent in them is lost, so the warning says so. Sessions that
block only apps close no browsers.

- Browsers running Web Guard, signed in to your Lock-In account, stay open. Web Guard from the
  Chrome Web Store works in Chrome, Edge and Brave.
- Before closing one of those, Lock-In says "Install Web Guard in this browser to keep using it
  during sessions", with an Install button that opens the store page in that browser. If Web Guard
  is there but signed out, or on another account, it says so.
- If Web Guard stops answering in a browser mid-session while you're online, that browser is
  warned, closed, and kept closed until the session ends.
- If Lock-In can't check your browsers, the session blocks apps only and closes none, and it tells
  you so.
- It isn't airtight. A browser Lock-In doesn't recognise stays open. A second Chrome profile or a
  Guest window without Web Guard isn't blocked. Incognito is covered only if you've allowed Web
  Guard there, and Lock-In tells you when you haven't. End task still stops Lock-In.

## Lock-In lives in the tray

- Closing the window keeps Lock-In running in the tray, with Open and Quit. You can turn that off
  in the Block Registry. During a session, closing always hides it, and Quit says "A session is
  running. Use Bail out."
- Starting Lock-In again shows the window it's already running.
- Starting with Windows opens the dashboard without taking the keyboard from whatever you opened
  first. The launch-on-startup switch shows what Windows actually has set.

## Sessions

- Lock-In itself ends and records a session, whether the window is open, hidden or closed. A
  session earns only the minutes your PC was awake with Lock-In running.
- Another device can't start or stop a session on this PC anymore. A session here runs until its
  own end, or until you Bail out.
- The line under Hold to Start says what's true: Bail out ends a session early, and voids it.

## A clearer Block Registry

- Type "youtube", "YouTube.com" or a full link, and it blocks youtube.com. It shows what it will
  block before you add it.
- Plain labels: **During focus sessions** and **Always (even without a session)**, the same for
  apps and sites. The blocked-sites count includes sites blocked always.
- Clear All Blocks says plainly what it does.

## Web Guard 1.2.5

Web Guard is the Chrome Web Store extension, updated separately. It blocks a site before it loads,
covers blocked frames inside other pages, and tells Lock-In on the same PC which browser it's in.
That stays on your PC. It no longer blocks sites with no session running after the app had been
open 6 hours in a day: that was a leftover daily limit nothing explained.

## Other fixes and changes

- Apps with "app" in their name, such as WhatsApp, can be blocked again.
- A block like "msedge" closes Edge and nothing of Lock-In's own.
- A session whose only blocked sites were "always" blocks counted as blocking no sites. It counts
  them now.
- A bail-out followed by Clear All Blocks, or by a stop from another device, could void your next
  session. A bail-out that finished while Lock-In was closed is now recorded.
- The offline pill rechecks as soon as you reconnect, and has a Retry button.
- Only Google Calendar's public link is accepted; a saved link that isn't one shows the connect
  screen instead of a broken frame.
- To-dos wrap between words. Demo accounts are off The Pack's leaderboard. Rows in the Block
  Registry no longer flicker on hover, and long links in notices wrap.
- If you have both the Microsoft Store and the direct-download copy, Lock-In tells you which one
  you're in. They don't share sessions or settings.
- The download is a single installer now. If you once installed the MSI and see two Lock-In
  entries in Apps & Features, uninstall the older one (version 1.2.7 or earlier). Your blocks and
  streak are safe either way.
