# Defender false positive — what likely trips it, and what to change

Written 4 Nov 2026 against `765e9b1`.

**Status:** items 1–3 are done in 1.2.10: no PowerShell, `rundll32` or `taskkill`. Items 4–7
aren't. Decisions: no signing for now, and direct-download publishing waits for Microsoft's
verdict.

## What happened

On 4 Nov 2026 Microsoft Defender quarantined 1.2.9's `app.exe` as
`Trojan:Win32/Bearfoos.A!ml`, while it was killing a blocked app. A false-positive
report (57797388-…) is pending.

The quarantined copy is at `.defender-submit/app.exe`: SHA-256
`D7BB2F405BAD4E4AC362C12379AD4CAA9702D4B23A9CCB7DDA965B46E0667001`, version 1.2.9,
**not signed**, ProductName `Lock-In`, CompanyName `lockin`.

Defender's own record (`Get-MpThreatDetection`, `Get-MpThreat`) on this PC:

| Time (4 Nov) | Process | Source type | Resources |
|---|---|---|---|
| **13:11:18** | `…\AppData\Local\Lock-In\app.exe` itself | 3 | The file, the running process, the Start menu shortcut, the Uninstall key |
| 13:11:42 | `ChromaTune.exe` (Acer's display tool) | 3 | The file only |
| 13:25:19 | `explorer.exe` | 3 | The file only |

Threat `Trojan:Win32/Bearfoos.A!ml`, severity 5, all actions successful. Source type 3 is, as
I understand Microsoft's numbering, real-time protection. So:

- The first hit names the **running process**, which fits your report that it fired during
  use, not at install or download. The record doesn't say it fired because of a kill.
- The later two are other programs touching the file. They're consequences, not new evidence.
- **Remediation reached beyond the exe:** the resources include the Start menu shortcut and the
  Uninstall key. A quarantined user may be left with no shortcut and no clean uninstall entry,
  as well as no enforcement. Worth checking on this PC.

**What's known and what isn't.** `!ml` means machine learning contributed to the
verdict. Microsoft doesn't publish the features behind it, and nothing here can show
which behaviour fired this one. Everything in the next section is reasoning from what
the binary does, ranked by judgment, not measured. A secondary source on `!ml`
detections lists self-compiled software as a common false-positive cause, and it's
secondary, so treat it as a hint.

## The line this doc won't cross

These reduce false positives by making the app **plainly what it is**. Not on the list,
and not to be added: packing or obfuscating the binary, hiding strings to avoid
detection, randomising timing to look less like a loop, splitting the kill into a helper
to separate the behaviour, disabling or excluding Defender from the installer, or telling
users to add an exclusion as the normal path. Those are evasion. They would also look
worse to a human reviewer at Microsoft, who is deciding this report right now.

## What the app does that could look wrong

| Behaviour | Where | Likely weight | Why | Needed for blocking? |
|---|---|---|---|---|
| **Unsigned, low-prevalence exe** | Every release has a new hash and no signature | High | Reputation is the strongest benign signal there is, and this file has none | No |
| **`TerminateProcess` on other processes in a loop** | Sniper, every 2 s, `process.kill()` | High, and it's when this one fired | Malware kills security tools this way. **This is the product** | **Yes: keep** |
| **Hidden `powershell.exe -Command`** | `get_running_apps`, `resolve_shortcut` (`lib.rs:1292`, `:1272`), with `CREATE_NO_WINDOW`, and `New-Object -COM WScript.Shell` | High | A hidden PowerShell with a COM object is a classic malware pattern | No: both are doable in-process |
| **`rundll32.exe url.dll,FileProtocolHandler`** | `open_web_guard_store` fallback (`lib.rs:1939`), added in 1.2.9 | Medium to high | A listed "living off the land" technique. **I introduced this in 1.2.9** | No |
| **`taskkill` spawned at onboarding** | `check_sniper` (`lib.rs:995`), runs `taskkill /?` | Medium | Stale: kills have been in-process since 1.2.1, so this tests nothing real | No |
| **Process enumeration every 1–2 s** | Sniper (names only, only with terms); lockdown (1 s, with full paths) | Medium | Common to malware and to legitimate tools alike | Yes, but it can be lighter |
| **Closing other apps' windows** (`WM_CLOSE`, `EnumWindows`) | Lockdown, new in 1.2.10 | Low to medium | **1.2.10 adds more of this, so don't assume the risk fell** | Yes |
| **Words in the binary** | `Sniper`, `💀 terminated`, `Kill`, `Enforcer`, `[Guard]`; 64 `println!` calls, which go nowhere in release | Low to medium | Static models read strings, and these read like a tool that attacks things | No |
| **Generic exe name and metadata** | `app.exe`, CompanyName `lockin` | Low to medium | `app.exe` in `%LOCALAPPDATA%` looks like nothing in particular | No |
| **Run-key autostart** | `tauri-plugin-autostart`, opt-in | Low | Persistence is a signal, but this is common and user-chosen | Keep |
| **Hidden window, starts silently** | Tray mode, `--silently` | Low | New in 1.2.9, so it's in the file that was flagged | Keep |
| **Loopback listener** | `127.0.0.1:47823`, new in 1.2.10, not in the flagged file | Low | A listening port in an unsigned app is a mild signal. Not the cause of this one | Keep |
| **Wide `<all_urls>` extension** | Not part of this binary | None | Listed to rule it out | Keep |

## Recommended changes, in order

None of these weakens blocking.

**1. Remove PowerShell.** `get_running_apps` becomes `sysinfo` plus the `EnumWindows` code
lockdown already has. `resolve_shortcut` becomes the `IShellLinkW` COM interface through
the `windows` crate. This also removes an injection surface, because `resolve_shortcut`
builds a PowerShell string from a path. About 1 day. **Best value of anything here.**

**2. Remove `rundll32`.** Use `ShellExecuteW` from `Win32_UI_Shell`, which is already a
dependency. Under an hour.

**3. Remove `check_sniper`'s `taskkill`.** Report ready from the fact that `sysinfo` can
read the process table, which is what blocking uses. Rename the command while there. An
hour.

**4. Sign the exe and the installer.** See "Signing" below. The biggest long-term gain,
but it costs money and time, and **it won't stop detections by itself**: a 2026 Microsoft
Q&A thread reports a signed app still getting cloud ML false positives across rebuilds.

**5. Name it properly.** Set `mainBinaryName` to `Lock-In` and the publisher field in
`tauri.conf.json`, so the installed exe is `Lock-In.exe` with real metadata. Also fixes the
mismatch behind the `whatsapp` bug. Moderate risk: it changes the process name existing
installs run under, so test an in-app update from 1.2.9/1.2.10, the shortcuts and the Run
key. Half a day.

**6. Keep release logs out of release builds.** Use `log::debug!`, or a macro that compiles
to nothing outside debug. Those 64 lines print nowhere in release anyway, and two print on
every 2 s tick. Rename `Sniper` to `Enforcer` where it reaches users or the binary. This is
removing dead output, not hiding behaviour: the app says what it does in the UI and FAQ.
Half a day.

**7. Lighter lockdown scans.** Read full paths only for names that need them (`opera`,
`launcher`, `firefox`, `tor`), not for every process each second. Same result, less
inspection of other processes. Under an hour. Also answers step 28 of the 1.2.10 test.

**Not recommended:** slowing the 2 s kill loop, or trying `WM_CLOSE` first for blocked apps.
Both change what the product does, on a guess about a model nobody can see.

## Signing

Facts as of Nov 2026, from Microsoft's pages (links below). Check before buying.

| Option | Cost | Catch |
|---|---|---|
| **Azure Artifact Signing** (was Trusted Signing) | About $10/month | **Individuals must be in the US or Canada.** Organizations: US, Canada, EU, UK. A March 2026 answer says individual validation was limited further. Needs an Entra ID work or school account, not a personal one |
| **OV certificate from a CA** | About $300–500/year | Open to more locations. Needs hardware or cloud key storage |
| **Microsoft Store** | Already done | Microsoft re-signs the MSIX at distribution. **Doesn't cover the NSIS download.** Point people hit by this at the Store build |

Reputation builds over time with Artifact Signing and OV alike, so early warnings are still
expected. If this is signed, set `bundle.windows.signCommand` so both the exe and the
installer are signed. This is separate from the updater's minisign key, which stays.

## Release process

Add to every release, before publishing:

1. Scan the built exe and setup with Defender on an up-to-date machine:
   `MpCmdRun -Scan -ScanType 3 -File <path>`. A clean local scan doesn't rule out a cloud ML
   hit, so also:
2. Submit both to [Microsoft's file submission](https://www.microsoft.com/en-us/wdsi/filesubmission)
   as **Software developer**, and keep the IDs next to the hashes. Each build has a new
   hash, so the 1.2.9 report **won't necessarily clear 1.2.10**. Submit the 1.2.10 files too.
3. Keep the source repository public and the release hashes published, which gives a reviewer
   something to check.

## What to tell people

Nothing on the site or in the app mentions this yet. If 1.2.9 or 1.2.10 is quarantined on a
user's PC, the session stops being enforced, and they get a scary name. Suggested FAQ entry,
once the report comes back, and not before:

> **Windows Defender flagged Lock-In. Is it safe?**
> Lock-In closes other programs on a timer, which is also what some malware does, so Defender's
> automated checks can get this wrong. We report these to Microsoft. You can check your download
> against the hash on the release page, or use the Microsoft Store version.

Don't tell people to add an exclusion as the first answer.

## Decisions (Cayden, 4 Nov)

1. Items 1–3 done now in 1.2.10. Items 6–7 not requested.
2. No signing for now.
3. Direct-download publishing waits for Microsoft's verdict.

## Sources

- [Microsoft: address false positives](https://learn.microsoft.com/en-us/defender-endpoint/defender-endpoint-false-positives-negatives)
- [Microsoft Q&A: signed app, repeated ML false positives](https://learn.microsoft.com/en-ca/answers/questions/5929545/microsoft-defender-false-positive-and-wdsi-submiss)
- [Secondary source on `!ml`](https://trojan-killer.net/microsoft-defender-ml-detection-false-positive/)
- [Microsoft: code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Microsoft: Artifact Signing quickstart](https://learn.microsoft.com/azure/artifact-signing/quickstart)
- [Microsoft Q&A: individual validation, March 2026](https://learn.microsoft.com/en-us/answers/questions/5810735/cant-create-a-new-trusted-signing-individual-ident)
- [Microsoft Q&A: work or school account needed](https://learn.microsoft.com/answers/a/12791070)
- [Microsoft: MSIX signing overview](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview)
