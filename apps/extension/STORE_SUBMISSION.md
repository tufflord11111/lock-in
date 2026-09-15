# Chrome Web Store submission — Lock-In Web Police 1.2.1

Everything the developer dashboard asks for on this update, in one place.
Paste each block into the matching field.

## Package

| | |
|---|---|
| Item | Lock-In Web Police (`pcmcaccnegefcjhdabjjfhaakjfeocea`) |
| Version | 1.2.1 (previous published version: 1.0.7) |
| Zip | `apps/extension/lock-in-extension-v1.2.1.zip` (built from `dist/`, not committed — `*.zip` is git-ignored) |
| SHA256 | `4CF24583221982F7CF4C29D609C69817E533BC7BEB56D2E1681742FDC0E597A0` (108,434 bytes, 2026-09-15) |
| Permissions | `storage`, `webNavigation`, `alarms` |
| Host permissions | `<all_urls>` |

If you rebuild the zip, update the SHA256 above. Entry names must use `/`
separators (the old v1.2.0 zip used `\`, which Chrome can unpack wrongly).

## Store listing → Privacy practices

### Single purpose

> Lock-In Web Police blocks websites on the user's own blocklist during a Lock-In focus session. The session is started from the Lock-In desktop app or the Lock-In web app, and the extension enforces it in Chrome by redirecting blocked sites to a local block page.

### Permission justifications

**storage**

> Stores the signed-in Lock-In user ID locally so the extension stays signed in across browser restarts. No browsing data is stored.

**webNavigation**

> Detects navigation to a blocked site before the page loads, so the tab goes straight to the local block page instead of briefly loading the distracting site. Navigation addresses are checked in memory against the user's blocklist and are never stored or transmitted.

**alarms**

> Manifest V3 service workers are suspended when idle. A periodic alarm keeps the extension's connection to the user's Lock-In account alive, so a focus session started on another device is enforced promptly, and updates the extension's check-in time.

**Host permission `<all_urls>`**

> The blocklist is defined entirely by the user, so the extension cannot know in advance which sites it must check. It compares the hostname of pages the user opens against that personal list, and on a match during an active session redirects the tab to a local block page or closes it. The same host access lets it connect to the user's Lock-In account (Firebase) to read that blocklist and the session state. The extension has no content scripts and does not request the scripting permission, so it never reads page content, the DOM, cookies or form data. No browsing data is transmitted or stored off the device.

### Remote code

> No, I am not using remote code. All JavaScript, including the Firebase SDK, is bundled in the package.

### Data usage

Tick:

- [x] **Authentication information** — the password entered in the popup is sent to Firebase Authentication to sign in.
- [x] **Personally identifiable information** — the email address entered in the popup is sent to Firebase Authentication. Google lists "email address" under this category, so declare it rather than under-declare.

Leave unticked:

- [ ] Health information
- [ ] Financial and payment information
- [ ] Personal communications
- [ ] Location
- [ ] Web history — page addresses are compared in memory and never transmitted; open-tab upload was removed in 1.2.1 and is rejected by the database rules
- [ ] User activity
- [ ] Website content

Tick all three certifications:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

> The listing for 1.0.7 was declared when that version uploaded open-tab domains. If **Web history** or **User activity** are ticked on the current listing, untick them for this submission.

### Privacy policy URL

```
https://lockinme.com/privacy
```

## Distribution → Test instructions

A test account is required: every feature sits behind sign-in, and signed
out the extension blocks nothing.

Before submitting:

1. Create the test account through the popup's **Create account** link or at
   https://lock-in-mobile.vercel.app/#register, so it gets a normal profile.
   Extension 1.2.1 sends no heartbeat for an account without one.
2. Do not remove `youtube.com` from its default blocklist, or step 6 below
   will not trigger.
3. Run the seven steps yourself once with the zipped build.
4. Replace the two placeholder credential lines.

Paste into the **Test instructions** field:

> Lock-In Web Police is the browser companion to the Lock-In focus app. It blocks sites on the user's blocklist only while a focus session is running. Sessions are started from the Lock-In desktop app or the Lock-In web app; the extension enforces that state and does nothing on its own, by design. No desktop install is needed to test.
>
> **Test account**
> Email: `REPLACE_WITH_TEST_EMAIL`
> Password: `REPLACE_WITH_TEST_PASSWORD`
>
> **Steps**
> 1. Install the extension, click its icon, and sign in with the test account above. (Or click **Create account** in the popup to register your own.)
> 2. The popup shows **UNLOCKED** with the note "No active session. Start one from the Lock-In desktop app or at lock-in-mobile.vercel.app".
> 3. In a normal tab, open `https://lock-in-mobile.vercel.app` and sign in with the same account.
> 4. Leave the duration at 25 minutes and press **Start 25 min session**.
> 5. Return to the extension popup and click **Manual Sync**. The status shows **LOCKED**.
> 6. Open a new tab and go to `youtube.com`. The tab is redirected to the extension's local block page. YouTube is on the default blocklist, so no setup is needed.
> 7. Press **End session** in the web app. The popup returns to **UNLOCKED** and sites load normally.
>
> Note: sign-out is disabled in the popup while a session is active ("SESSION ACTIVE — LOGOUT DISABLED"). End the session first.
>
> **Data handling:** the extension sends the email and password to Firebase Authentication to sign in, and writes a heartbeat (timestamp, extension version, online status) to the user's own record. It reads that user's own blocklist and session state. Page addresses are evaluated locally in memory and never uploaded. It does not collect browsing history or open tabs.

## Install warnings users will see

For reference when answering reviewer questions:

- `<all_urls>` — "Read and change all your data on all websites"
- `webNavigation` — "Read your browsing history"

Removing `tabs` did not remove the browsing-history warning; `webNavigation`
shows the same text. Both are explained in the justifications above.
