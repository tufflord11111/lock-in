import os, subprocess
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from PIL import Image

OUT = "/home/claude/brand/lockin-brand"
INK, CREAM, RED, GREY, DARK = "#2B2033", "#F6F1E7", "#D9372B", "#8E8E96", "#1F1B24"

def w(path, text):
    p = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(text)
    return p

def png(svg_path, out_path, wpx, hpx=None):
    p = os.path.join(OUT, out_path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    subprocess.run(["rsvg-convert", "-w", str(wpx), "-h", str(hpx or wpx), "-o", p, svg_path], check=True)
    return p

def corners(h, l):
    return (f"M{-h} {-h+l}V{-h}H{-h+l}M{h-l} {-h}H{h}V{-h+l}"
            f"M{h} {h-l}V{h}H{h-l}M{-h+l} {h}H{-h}V{h-l}")

def mark(stroke, dot, h=35, l=18, sw=8, r=10):
    return (f'<path d="{corners(h,l)}" fill="none" stroke="{stroke}" stroke-width="{sw}" stroke-linecap="butt" stroke-linejoin="miter"/>'
            f'<circle r="{r}" fill="{dot}"/>')

def svg(vb, body, w_=None, h_=None):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">{body}</svg>'

# ---- wordmark "[•] lock in" as outlined paths (no font dependency)
font = TTFont("/usr/share/fonts/opentype/inter/Inter-SemiBold.otf")
gs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font["head"].unitsPerEm
def text_path(txt, size, x0, base):
    pen = SVGPathPen(gs); x = 0; s = size / upm
    for ch in txt:
        g = cmap[ord(ch)]
        tp = TransformPen(pen, (s, 0, 0, -s, x0 + x * s, base))
        gs[g].draw(tp); x += gs[g].width
    return pen.getCommands(), x * s

def wordmark(ink):
    size, base = 100, 100
    top, bot = base - 76, base + 8          # bracket spans ascender to just under baseline
    sw = 11; arm = 16
    lx = 6
    lb = f"M{lx+arm} {top}H{lx}V{bot}H{lx+arm}"
    dot_cx = lx + arm + 22; dot_cy = (top + bot) / 2
    rx = dot_cx + 22 + arm
    rb = f"M{rx-arm} {top}H{rx}V{bot}H{rx-arm}"
    d, tw = text_path("lock in", size, rx + 30, base)
    W = rx + 30 + tw + 6
    body = (f'<path d="{lb}{rb}" fill="none" stroke="{ink}" stroke-width="{sw}" stroke-linejoin="miter"/>'
            f'<circle cx="{dot_cx}" cy="{dot_cy}" r="13" fill="{RED}"/>'
            f'<path d="{d}" fill="{ink}"/>')
    return body, W, bot + sw

# ---------- 1. SVG masters
masters = {}
masters["logo-mark-ink"] = w("svg/logo-mark-ink.svg", svg("-50 -50 100 100", mark(INK, RED)))
masters["logo-mark-cream"] = w("svg/logo-mark-cream.svg", svg("-50 -50 100 100", mark(CREAM, RED)))
tile = (f'<rect x="-50" y="-50" width="100" height="100" rx="22" fill="{DARK}"/>'
        f'<g transform="scale(0.8)">{mark(CREAM, RED, sw=9, r=11)}</g>')
masters["app-icon"] = w("svg/app-icon.svg", svg("-50 -50 100 100", tile))
masters["app-icon-light"] = w("svg/app-icon-light.svg", svg("-50 -50 100 100",
    f'<rect x="-50" y="-50" width="100" height="100" rx="22" fill="{CREAM}"/><g transform="scale(0.8)">{mark(INK, RED, sw=9, r=11)}</g>'))
for name, ink in [("wordmark-ink", INK), ("wordmark-cream", CREAM)]:
    body, W, H = wordmark(ink)
    masters[name] = w(f"svg/{name}.svg", svg(f"0 0 {W:.0f} {H:.0f}", body))
WM_W, WM_H = wordmark(INK)[1], wordmark(INK)[2]

# ---------- 2. App icon source (Tauri `tauri icon` input, also MSIX + Android)
png(masters["app-icon"], "app/app-icon-1024.png", 1024)
# full-bleed square (no rounded corners) for platforms that mask themselves (Android adaptive, iOS)
w("svg/app-icon-square.svg", svg("-50 -50 100 100",
    f'<rect x="-50" y="-50" width="100" height="100" fill="{DARK}"/><g transform="scale(0.72)">{mark(CREAM, RED, sw=9, r=11)}</g>'))
png(os.path.join(OUT, "svg/app-icon-square.svg"), "app/app-icon-square-1024.png", 1024)

# ---------- 3. Tray icons: idle (open, grey) vs locked (closed, red), for dark and light taskbars
def tray(stroke, locked):
    h, l, sw, r, dot = (34, 20, 13, 14, RED) if locked else (44, 18, 11, 11, GREY)
    return svg("-50 -50 100 100", mark(stroke, dot, h=h, l=l, sw=sw, r=r))
for theme, stroke in [("dark-taskbar", CREAM), ("light-taskbar", INK)]:
    for state in ["idle", "locked"]:
        sp = w(f"svg/tray-{state}-{theme}.svg", tray(stroke, state == "locked"))
        ims = []
        for s in [16, 20, 24, 32, 48]:
            ims.append(png(sp, f"tray/{theme}/tray-{state}-{s}.png", s))
        Image.open(ims[-1]).save(os.path.join(OUT, f"tray/{theme}/tray-{state}.ico"),
                                 sizes=[(s, s) for s in [16, 20, 24, 32, 48]])

# ---------- 4. Chrome extension (Web Guard) icons: tile style so it reads on any toolbar
for s in [16, 32, 48, 128]:
    png(masters["app-icon"], f"extension/icon{s}.png", s)
w("svg/ext-locked.svg", tile)  # placeholder name kept simple below
for s in [16, 32, 48, 128]:
    idle = svg("-50 -50 100 100", f'<rect x="-50" y="-50" width="100" height="100" rx="22" fill="{DARK}"/><g transform="scale(0.8)">{mark(CREAM, GREY, h=42, l=17, sw=9, r=9)}</g>')
    sp = w("svg/ext-idle.svg", idle)
    png(sp, f"extension/icon{s}-idle.png", s)
os.remove(os.path.join(OUT, "svg/ext-locked.svg"))

# ---------- 5. Website favicons + PWA
png(masters["app-icon"], "web/apple-touch-icon.png", 180)
png(os.path.join(OUT, "svg/app-icon-square.svg"), "web/apple-touch-icon.png", 180)
png(masters["app-icon"], "web/icon-192.png", 192)
png(masters["app-icon"], "web/icon-512.png", 512)
w("svg/maskable.svg", svg("-50 -50 100 100",
    f'<rect x="-50" y="-50" width="100" height="100" fill="{DARK}"/><g transform="scale(0.55)">{mark(CREAM, RED, sw=9, r=11)}</g>'))
png(os.path.join(OUT, "svg/maskable.svg"), "web/icon-maskable-512.png", 512)
f48 = png(masters["app-icon"], "web/_fav48.png", 48)
Image.open(f48).save(os.path.join(OUT, "web/favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
os.remove(f48)
open(os.path.join(OUT, "web/favicon.svg"), "w").write(open(masters["app-icon"]).read())

# ---------- 6. Social
def social(name, W, H, mark_px, with_word, word_w=None):
    parts = [f'<rect width="{W}" height="{H}" fill="{DARK}"/>']
    if with_word:
        ww = word_w; sc = ww / WM_W; wh = WM_H * sc
        body = wordmark(CREAM)[0]
        parts.append(f'<g transform="translate({(W-ww)/2:.1f},{(H-wh)/2:.1f}) scale({sc:.4f})">{body}</g>')
    else:
        sc = mark_px / 100
        parts.append(f'<g transform="translate({W/2},{H/2}) scale({sc})">{mark(CREAM, RED)}</g>')
    sp = w(f"svg/{name}.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">{"".join(parts)}</svg>')
    png(sp, f"social/{name}.png", W, H)
social("avatar-1080", 1080, 1080, 560, False)          # IG / TikTok / X / LinkedIn / YouTube profile (circle-safe)
social("og-image-1200x630", 1200, 630, 0, True, 620)    # website link previews
social("x-header-1500x500", 1500, 500, 0, True, 560)
social("youtube-banner-2560x1440", 2560, 1440, 0, True, 900)  # text stays inside the 1546x423 safe area
social("story-1080x1920", 1080, 1920, 0, True, 640)

# ---------- 7. Wordmark PNGs
for name in ["wordmark-ink", "wordmark-cream"]:
    png(masters[name], f"wordmark/{name}-1200.png", 1200, int(1200 * WM_H / WM_W))
for name in ["logo-mark-ink", "logo-mark-cream"]:
    png(masters[name], f"mark/{name}-512.png", 512)
print("done")

# ---------- 8. Store listing art
social("chrome-promo-tile-440x280", 440, 280, 0, True, 300)
social("ms-store-poster-720x1080", 720, 1080, 0, True, 480)
social("ms-store-boxart-1080", 1080, 1080, 560, False)
import shutil
os.makedirs(os.path.join(OUT, "store"), exist_ok=True)
for n in ["chrome-promo-tile-440x280", "ms-store-poster-720x1080", "ms-store-boxart-1080"]:
    shutil.move(os.path.join(OUT, f"social/{n}.png"), os.path.join(OUT, f"store/{n}.png"))
print("store done")
