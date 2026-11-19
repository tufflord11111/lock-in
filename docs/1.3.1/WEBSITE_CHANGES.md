# Website changes for Lock-In 1.3.1 (C:\dev\lockin-website)

For a separate session. Read against `lockin-website` at 5f68151. `privacy.html:268` promises this page changes **before** the change ships, so all of this must go live before 1.3.1 is published.

Nothing here may say "can't turn it off", "no override" or "no off switch", promise offline site blocking, or say any antivirus engine (Defender included) rates the app clean. End task and uninstall always stop Lock-In.

## 1. privacy.html — date

- `privacy.html:112`: "Last updated: 15 November 2026" → the date you publish. Also change "Web Guard Chrome extension (version 1.2.1 and later)" if you name 1.3.1 anywhere below.

## 2. privacy.html — "What is stored in your account" table (from :132)

Add these four rows, in the table's style (What / Details and why / How long):

| What | Details and why | How long |
|---|---|---|
| Baseline answer | Your answer to "On a normal study day, how many hours do you lose to distractions on this laptop?" (0–12), and from 1.3.1 when you answered it. Shown beside your focus hours in the weekly card. Asked once; you can skip it. | Until you delete your account. |
| Optional study: your choice | Whether you turned on "Help find out whether Lock-In helps" in Settings, and when (on or off). Off unless you turn it on. | Until you delete your account. |
| Optional study: two weeks on | If the study is on, the same hours-lost question asked once, 14 days after you turned it on: your answer, when it was asked and when you answered. | Until you delete your account. |
| Pro waitlist | If you press "tell me when it's ready": that you'd like to hear about Lock-In Pro, which features you'd use and what you'd pay a month, if you answered, the date, and whether it came from the desktop or Android app. Nothing is sold; Pro isn't built. | Until you delete your account. |

## 3. privacy.html — new section "Optional study"

Put it after "What is stored in your account" (before "What other users can see", :211). Suggested text:

> **Optional study.** Lock-In can help find out whether it actually helps, but only if you turn it on (Settings → "Help find out whether Lock-In helps"; it's off unless you do). If it's on, we use your hours-lost answers (the first one, and once more two weeks later), your focus minutes per week, how many days you focus, and how often you bail out. We report them only as totals and averages across everyone who joined, and we don't report any figure based on fewer than 5 people. Reports never include your handle, email, user ID or anything else that identifies you. Lock-In never collects which sites you visit, so that's not included. You can turn it off in Settings at any time; your data is left out of every report after that. Reports already made can't be changed. Deleting your account deletes the answers.

Don't call it "research" or say anything is "proven" on the site either; the app avoids both words.

## 4. privacy.html — corrections that 1.3.1 also makes necessary

These go beyond the brief's list, but the page would be wrong without them:

- **"What other users can see" (:211–217):** online status is no longer readable by any signed-in user. From 1.3.1 it is readable only by people you have added in The Pack. Also say that adding someone sends them a friend request (your user ID, theirs, and the time), which only they can read, and which they can accept or dismiss.
- **"What stays on your device" (:221), Chrome extension bullet:** the check-in to the desktop app now also carries a random ID for the browser profile (not tied to you or the PC), how many browser windows the extension can see, whether it is blocking right now, and whether it can reach every site. It is sent about every 15 seconds and when a window opens or closes. The desktop app answers with whether a session is running on this PC and when it ends, so the extension can block for it. It still never leaves your computer.
- **"What stays on your device", desktop app bullet:** add your Pro waitlist answer (`lockin.proInterest`) and whether the waitlist card and the two-week question were already shown (`lockin.proAsked`, `lockin.proDue`, `lockin.followupSkipped`).

## 5. index.html — Pack Pro line

- `index.html:1076`: remove "friend-approved unlock" from "Group sessions, friend-approved unlock, scheduled sessions, full history." Ask my Pack (1.4) will be free, so it can't be listed as Pro.
- Recommended, same line: also remove "full history". History stays free (ground rule), and listing it as Pro contradicts that.
- Leave the `payIntent` button and `research/payIntent` as they are (decision 6).

## 6. Check before publishing

- No page names 1.3.1 features as shipped before 1.3.1 is published.
- Search the site for the banned phrases above; none may appear.
