# Lock-In brand kit (19 Nov 2026)

Icon = lock-on brackets around a red dot. Text mark = `[•] lock in`.

## Colours
| Name | Hex | Use |
|---|---|---|
| Ink | #2B2033 | Brackets/text on light backgrounds |
| Cream | #F6F1E7 | Brackets/text on dark, light backgrounds |
| Red | #D9372B | The dot only. Never for text or large areas |
| Idle grey | #8E8E96 | Dot when no session is running |
| Dark | #1F1B24 | App icon tile, dark backgrounds |

Font: Inter SemiBold (the wordmark SVGs are outlined, so no font is needed to display them).

## Folders
| Folder | What | Where it goes |
|---|---|---|
| `app/app-icon-1024.png` | Master app icon | Input for `pnpm tauri icon` (generates .ico, Square*Logo, StoreLogo, Android) |
| `app/app-icon-square-1024.png` | Full-bleed version | Platforms that round corners themselves (Android adaptive, iOS) |
| `tray/dark-taskbar`, `tray/light-taskbar` | idle + locked, 16–48 px, .ico | Desktop tray icon, swapped on session start/end |
| `extension/icon{16,32,48,128}.png` | Locked (red dot) | Web Guard manifest + Web Store |
| `extension/icon*-idle.png` | Idle (grey dot) | Optional: `chrome.action.setIcon` when no session |
| `web/` | favicon.ico/.svg, apple-touch-icon, 192/512, maskable | lockinme.com + mobile PWA |
| `social/` | Avatar 1080, OG 1200×630, X header, YouTube banner, story | Social profiles + link previews |
| `store/` | Chrome promo tile 440×280, MS Store poster 720×1080 + box art 1080 | Web Store + Partner Center listings |
| `wordmark/`, `mark/` | PNGs of the text mark and bare icon | Docs, decks, press |
| `svg/` | Vector masters of everything | Edit here, re-export |
| `lockin-loader.html` | Loading screen (CSS/SVG) | App boot, website |

## Rules
- Keep clear space around the icon equal to the gap between the brackets and the dot.
- The dot is always red when "locked in" and grey when idle. Don't use other colours.
- Don't add outlines, shadows, gradients, or rotate or stretch the mark.
- Under 24 px, use the tile (`app-icon`) or the tray files, not the bare mark.
- In writing, the text mark is `[•] lock in`, lowercase.
