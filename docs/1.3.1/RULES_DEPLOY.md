# Lock-In 1.3.1 — deploying the Firebase rules

**Not deployed.** This is the plan; nothing here has been run against production except the read-only `database:get`.

- Project `synchrofocus-ac0f2`, Realtime Database instance `synchrofocus-ac0f2-default-rtdb` (asia-southeast1).
- Deployed today = `master`'s `database.rules.json` (1.3.0), read 2026-11-19 (twice; the second read during the 1.3.1 reconciliation, deep JSON compare: equal); identical apart from one blank line. 4,052 bytes.
- Merged file = `database.rules.json` on `security-1.3.1`, last changed at `780ad09` (desktop 1.3.1 + Android v0.1). The reconciliation (R1) changed no rule; it added `structure.test.cjs`.

## One freeze, in one place

The guarded-session freeze is a single rule, B2's guard in `users/$uid/.write`. While `sessionState.guard` is 2, `isActive` is true and `endTime` is more than 120 s off (and no Bail out fuse has burned down), a write from the account's own token must keep `isActive` true, `guard` 2, and `endTime` the same or later. It also may not turn `config/focusActive` off, change `isLocked`, or touch an armed `bailoutEnd`; a new `bailoutEnd` must be at least `now + 270000`. 1.3.1 item 3 added tests only, not a second freeze, and item 17's `androidSessionHistory` has `.validate` rules only.

Every `.write` under `users/$uid`, at any depth:

| Path | Grants |
|---|---|
| `users/$uid` | the owner, through the guard above |
| `users/$uid/friends/$fid` | the friend `$fid`, delete only (removing itself) |

Neither is on, above or below `sessionState`, `config`, `config/focusActive` or `isLocked`, so nothing grants the owner a way round the guard. `structure.test.cjs` (first step of `pnpm test:rules`) fails if that ever changes.

Desktop and dev builds both arm a 5-minute fuse (1.3.1 R3), which the guard's 270 s minimum accepts.

## When

Deploy **before** any 1.3.1 desktop build or Web Guard 1.3.1 reaches users, and before Android v0.1 uploads go live. Every rule is additive for 1.3.0 clients: on the emulator, `master`'s `rules.test.cjs` passes 90/91 and `android-v01`'s passes 93/94 against the merged file. The one failure in each is the unverified legacy-handle migration. 1.3.0 never runs it unverified (`master:apps/web/src/hooks/useHandleProfile.ts:154`). The website's privacy changes (WEBSITE_CHANGES.md) go live first, as `privacy.html` promises.

## (a) The diff: deployed → merged

What it adds:
- **B2 session freeze.** In `users/$uid/.write`, a live `guard: 2` session can't be switched off, shortened or deleted from the account's own token; `sessionState/guard` and `bailoutEnd` are validated.
- **B2 privacy and Pack.**
  - `presence` is readable only by people the owner added, and needs a profile.
  - `friends/$fid` entries must be `true`, need a verified email to add, and a friend may remove itself.
  - `friendRequests/` is new.
- **B2 handles.**
  - `public/userName` must be handle-shaped.
  - `config/username` must be reserved by you.
  - The `usernames/$name` write needs a verified email, except for the first claim.
- **1.3.1:**
  - `proInterest` (item 7)
  - `config/baselineAt`, `config/study`, `config/followupHoursLost` (item 9)
  - `androidSessionHistory` (item 17)

Lines removed or changed on the deployed side: `users/$uid/.write` (extended), the closing brace of `config` (now followed by `username`), `public/userName` (was "no @"), `presence/.read` (was any signed-in user), and `usernames/$name/.write` (extended).

```diff
--- deployed: synchrofocus-ac0f2-default-rtdb, read 2026-11-19
+++ merged: database.rules.json @ 780ad09
@@ -6,12 +6,26 @@
     "users": {
       "$uid": {
         ".read": "auth != null && auth.uid === $uid",
-        ".write": "auth != null && auth.uid === $uid && (!newData.exists() || newData.child('emergencyUnlock/expiry').val() === data.child('emergencyUnlock/expiry').val())",
-
+        ".write": "auth != null && auth.uid === $uid && (!newData.exists() || newData.child('emergencyUnlock/expiry').val() === data.child('emergencyUnlock/expiry').val()) && (!(data.child('sessionState/guard').val() === 2 && data.child('sessionState/isActive').val() === true && data.child('sessionState/endTime').isNumber() && data.child('sessionState/endTime').val() > now + 120000 && !(data.child('sessionState/bailoutEnd').isNumber() && data.child('sessionState/bailoutEnd').val() <= now)) || (newData.child('sessionState/isActive').val() === true && newData.child('sessionState/guard').val() === 2 && newData.child('sessionState/endTime').isNumber() && newData.child('sessionState/endTime').val() >= data.child('sessionState/endTime').val() && (newData.child('config/focusActive').val() === true || data.child('config/focusActive').val() !== true) && newData.child('isLocked').val() === data.child('isLocked').val() && ((data.child('sessionState/bailoutEnd').exists() && newData.child('sessionState/bailoutEnd').val() === data.child('sessionState/bailoutEnd').val()) || (!data.child('sessionState/bailoutEnd').exists() && (!newData.child('sessionState/bailoutEnd').exists() || (newData.child('sessionState/bailoutEnd').isNumber() && newData.child('sessionState/bailoutEnd').val() >= now + 270000))))))",
         "config": {
           "theme": { ".validate": "newData.isString() && newData.val().matches(/^(operator|notebook|bento|botanical)$/)" },
           "themeAccent": { ".validate": "newData.isString() && newData.val().matches(/^(orange|sage|lavender|teal)$/)" },
           "baselineHoursLost": { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 24" },
+          "baselineAt": { ".validate": "newData.val() === now" },
+          "study": {
+            ".validate": "newData.hasChildren(['consented','consentedAt','v'])",
+            "consented": { ".validate": "newData.isBoolean()" },
+            "consentedAt": { ".validate": "newData.val() === now" },
+            "v": { ".validate": "newData.val() === 1" },
+            "$other": { ".validate": false }
+          },
+          "followupHoursLost": {
+            ".validate": "!data.exists() && newData.hasChildren(['value','askedAt','answeredAt'])",
+            "value": { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 24" },
+            "askedAt": { ".validate": "newData.isNumber() && newData.val() <= now" },
+            "answeredAt": { ".validate": "newData.val() === now" },
+            "$other": { ".validate": false }
+          },
           "companion": {
             "enabled": { ".validate": "newData.isBoolean()" },
             "nudgeAfterMin": { ".validate": "newData.isNumber() && newData.val() >= 30 && newData.val() <= 240" },
@@ -19,7 +33,23 @@
             "quietEnd": { ".validate": "newData.isString() && newData.val().matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)" },
             "v": { ".validate": "newData.val() === 1" },
             "$other": { ".validate": false }
-          }
+          },
+          "username": { ".validate": "data.val() === newData.val() || (newData.isString() && newData.val().matches(/^[a-z0-9_]{1,20}$/) && newData.parent().parent().parent().parent().child('usernames/' + newData.val()).val() === $uid && (!data.exists() || !newData.parent().parent().parent().parent().child('usernames/' + data.val()).exists()))" }
+        },
+        "sessionState": {
+          "guard": { ".validate": "newData.val() === 2" },
+          "bailoutEnd": { ".validate": "newData.isNumber()" }
+        },
+
+        "proInterest": {
+          ".validate": "newData.hasChildren(['at','source','version'])",
+          "at": { ".validate": "newData.isNumber() && newData.val() <= now + 60000" },
+          "source": { ".validate": "newData.val() === 'desktop' || newData.val() === 'android'" },
+          "notify": { ".validate": "newData.isBoolean()" },
+          "price": { ".validate": "newData.isString() && newData.val().matches(/^(S\\$2|S\\$3|S\\$5|I wouldn't pay)$/)" },
+          "features": { "$i": { ".validate": "$i.matches(/^[0-4]$/) && newData.isString() && newData.val().matches(/^(parrot outfits and perches|day plan|the pack pro|deeper stats|scheduled sessions)$/)" } },
+          "version": { ".validate": "newData.val() === 1" },
+          "$other": { ".validate": false }
         },
 
         "sessionHistory": {
@@ -31,13 +61,32 @@
           }
         },
 
+        "androidSessionHistory": {
+          "$entry": {
+            "minutes": { ".validate": "newData.isNumber() && newData.val() >= 0" },
+            "bailedOut": { ".validate": "newData.isBoolean()" },
+            "status": { ".validate": "newData.isString()" },
+            "reason": { ".validate": "newData.isString()" },
+            "device": { ".validate": "newData.isString()" },
+            "timestamp": { ".validate": "newData.isNumber()" },
+            ".validate": "!newData.hasChild('bailedOut') || (newData.child('bailedOut').val() === true && newData.child('minutes').val() === 0)"
+          }
+        },
+
         "public": {
           ".read": "auth != null",
-          "userName": { ".validate": "newData.isString() && !newData.val().contains('@')" },
+          "userName": { ".validate": "newData.isString() && newData.val().matches(/^[A-Za-z0-9_]{1,20}$/)" },
           "$other": { ".validate": false }
         },
         "presence": {
-          ".read": "auth != null"
+          ".validate": "newData.parent().child('config').exists()",
+          ".read": "auth != null && (auth.uid === $uid || root.child('users/' + $uid + '/friends/' + auth.uid).exists())"
+        },
+        "friends": {
+          "$fid": {
+            ".write": "auth != null && auth.uid === $fid && !newData.exists()",
+            ".validate": "newData.val() === true && $fid !== $uid && auth.token.email_verified === true"
+          }
         },
         "openTabs": { ".validate": false, "$k": { ".validate": false } },
         "extension_state": {
@@ -52,7 +101,21 @@
       ".indexOn": ".value",
       "$name": {
         ".read": "auth != null",
-        ".write": "auth != null && ((!newData.exists() && (!data.exists() || data.val() === auth.uid)) || (newData.val() === auth.uid && (!data.exists() || data.val() === auth.uid) && $name.matches(/^[a-z0-9_]{1,20}$/)))"
+        ".write": "auth != null && ((!newData.exists() && (!data.exists() || data.val() === auth.uid)) || (newData.val() === auth.uid && (!data.exists() || data.val() === auth.uid) && $name.matches(/^[a-z0-9_]{1,20}$/) && (auth.token.email_verified === true || data.val() === auth.uid || (!root.child('users/' + auth.uid + '/config/username').exists() && !root.child('users/' + auth.uid + '/username').exists()))))"
+      }
+    },
+
+    "friendRequests": {
+      "$target": {
+        ".read": "auth != null && auth.uid === $target",
+        ".write": "auth != null && auth.uid === $target && !newData.exists()",
+        "$from": {
+          ".write": "auth != null && ((auth.uid === $from && !data.exists() && newData.exists() && auth.token.email_verified === true) || (!newData.exists() && (auth.uid === $target || auth.uid === $from)))",
+          ".validate": "$from !== $target && newData.hasChildren(['from', 'at']) && newData.child('from').val() === $from && newData.parent().parent().parent().child('users/' + $target + '/config').exists() && newData.parent().parent().parent().child('users/' + $from + '/friends/' + $target).val() === true",
+          "from": { ".validate": "newData.isString()" },
+          "at": { ".validate": "newData.val() === now" },
+          "$other": { ".validate": false }
+        }
       }
     },
 
@@ -95,4 +158,3 @@
     }
   }
 }
-
```

## (b) Back up, deploy, read back and compare

PowerShell, from a terminal where `firebase login` is done. Stop at the first step that fails.

1. Run the full emulator suite on the exact file that will be deployed:
   ```powershell
   cd C:\dev\lock-in-sec
   git log -1 --format="%h %s" -- database.rules.json
   pnpm test:rules
   ```
   The `git log` line must show `780ad09` (or a later rules commit you meant to ship). The test output must show 17/17 structure checks, then 91/91, 116/116 and 67/67.

   Optional, the 1.3.0 and Android suites against the same file (each should be 90/91 and 93/94, the one failure being the unverified legacy-handle migration):
   ```powershell
   cd C:\dev\lock-in-sec\apps\firebase-rules-tests
   git show master:apps/firebase-rules-tests/rules.test.cjs > master.rules.test.cjs
   git show android-v01:apps/firebase-rules-tests/rules.test.cjs > android.rules.test.cjs
   firebase emulators:exec --only database "node master.rules.test.cjs & node android.rules.test.cjs"
   Remove-Item master.rules.test.cjs, android.rules.test.cjs
   ```

2. Back up what is deployed now to a dated file:
   ```powershell
   $stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
   $dir = "C:\dev\lockin-rules-backups"
   New-Item -ItemType Directory -Force $dir | Out-Null
   $backup = "$dir\deployed-$stamp.rules.json"
   firebase database:get /.settings/rules --project synchrofocus-ac0f2 --instance synchrofocus-ac0f2-default-rtdb -o $backup
   Get-Item $backup | Select-Object FullName, Length
   ```
   The backup must exist and not be empty (today's deployed file is 4,052 bytes). Keep `$backup` in this same window for the rollback.

3. Deploy (rules only):
   ```powershell
   cd C:\dev\lock-in-sec
   firebase deploy --only database --project synchrofocus-ac0f2
   ```

4. Read it back and deep-compare it with the file you deployed:
   ```powershell
   $after = "$dir\deployed-$stamp-after.rules.json"
   firebase database:get /.settings/rules --project synchrofocus-ac0f2 --instance synchrofocus-ac0f2-default-rtdb -o $after
   $live = Get-Content $after -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 100 -Compress
   $want = Get-Content C:\dev\lock-in-sec\database.rules.json -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 100 -Compress
   if ($live -eq $want) { "MATCH: deployed rules equal database.rules.json" } else { "MISMATCH: roll back (step c) and compare the two files" }
   ```

5. Smoke test with the test account (lockintest10, never your real one) on desktop 1.3.0, which is what users have:
   - start a Micro session, let it end
   - start another and Bail out
   - add a block
   - the parrot settings still save

   If anything is refused, roll back.

## (c) Roll back to the backup

From the same PowerShell window (it still has `$backup`), or set `$backup` to the dated file from step 2:

```powershell
$rb = "C:\dev\lockin-rules-rollback"
New-Item -ItemType Directory -Force $rb | Out-Null
Copy-Item $backup "$rb\database.rules.json" -Force
Set-Content -Path "$rb\firebase.json" -Value '{ "database": { "rules": "database.rules.json" } }' -Encoding ascii
cd $rb
firebase deploy --only database --project synchrofocus-ac0f2
firebase database:get /.settings/rules --project synchrofocus-ac0f2 --instance synchrofocus-ac0f2-default-rtdb -o "$rb\after-rollback.rules.json"
$live = Get-Content "$rb\after-rollback.rules.json" -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 100 -Compress
$want = Get-Content $backup -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 100 -Compress
if ($live -eq $want) { "ROLLED BACK: deployed rules equal the backup" } else { "MISMATCH after rollback" }
```

The rollback folder is separate so `firebase.json` there points only at the backup, never at the branch's file. Rolling back after 1.3.1 clients are out has a cost: sessions they started lose the server-side freeze (Web Guard 1.3.1 still holds them), and friend requests, the waitlist and study answers stop being validated. Data already written stays.
