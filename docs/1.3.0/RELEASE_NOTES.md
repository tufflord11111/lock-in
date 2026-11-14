# Lock-In 1.3.0

## A parrot keeps you company

An African grey now lives on your desktop. It walks along the bottom of the screen, flies up to a
branch on the right edge now and then, and naps there while a session runs. Now and then it
suggests a session, at most once every 30 minutes by default, and never in your quiet hours. Click
it for its menu, drag it somewhere else, or hold the right button and rub it to pet it.

It's on by default. Turn it off with **Show the parrot** in parrot settings (in the Block
Registry) or **Show parrot** in the tray menu. Its settings follow your account. The branch
height is a slider in parrot settings, and it stays on this PC.

## Browsers close in every session that blocks sites

In 1.2.10, closing browsers was something you picked when a session started. Now every session that blocks
websites closes browsers that can't block them, after a 10 second warning. Browsers running Web
Guard, signed in to your Lock-In account, stay open. Anything typed and not sent in a closed
browser is lost, so the warning says so. A session that blocks apps only closes no browsers.

If Lock-In can't check your browsers, the session blocks apps only and closes none, and it tells
you so.

## Web Guard in Edge and Brave

Web Guard from the Chrome Web Store works in Edge and Brave as well as Chrome, and keeps them open
during sessions. When Lock-In is about to close one of them, it says "Install Web Guard in this
browser to keep using it during sessions", with an Install button that opens the store page in
that browser. If Web Guard is already there but signed out, or signed in to a different account,
it says so and asks you to sign in with this one.

## A clearer web blocker

- Type "youtube", "YouTube.com" or a full link, and it blocks youtube.com. It shows what it will
  block before you add it.
- Plain labels: **During focus sessions** and **Always (even without a session)**, the same for
  apps and sites.
- The blocked-sites count now includes sites blocked always.

## The dashboard opens at startup

When Lock-In starts with Windows, the dashboard now opens too (1.2.10 stayed in the tray). It
doesn't take the keyboard from whatever you opened first.

## Fixes

- A session whose only blocked sites were "always" blocks counted as blocking no sites. It now
  counts them.
- Rows and buttons in the Block Registry no longer flicker at their bottom edge on hover.
- Long links in notices now wrap instead of running off the edge.
