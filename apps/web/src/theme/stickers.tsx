// apps/web/src/theme/stickers.tsx  (v2 — replaces the 1.2.5 file entirely)
//
// Decorative sticker layer for the Notebook and Botanical themes. Original
// artwork drawn for Lock-In; no third-party assets.
//
// PLACEMENT RULE (the reason v1 was wrong): a sticker may live in exactly two
// places, and neither can cover content.
//   1. "straddle" — centred on the card's top or bottom BORDER. Half of it sits
//      outside the card, half inside the card's padding band. Assets in this
//      mode are ≤ 44 px tall, so with p-6 (24 px) or p-8 (32 px) padding they
//      never reach the first line of content.
//   2. "watermark" — large, low-opacity line art BEHIND the content, clipped to
//      the card (self-clipping). Host card needs `relative isolate`, content wrapper
//      `relative z-[1]` (see <Sticker> docs below).
// Every asset is aria-hidden and pointer-events: none.

import { useTheme } from "./ThemeProvider";
import type { CSSProperties, ReactElement } from "react";

/* ------------------------------------------------------------------ */
/*  NOTEBOOK — die-cut stickers (white border + soft shadow) + tape    */
/* ------------------------------------------------------------------ */

const DIE_CUT: CSSProperties = {
  filter: "drop-shadow(0 1px 0 #fff) drop-shadow(0 -1px 0 #fff) drop-shadow(1px 0 0 #fff) drop-shadow(-1px 0 0 #fff) drop-shadow(0 2px 2px rgba(20,40,80,0.18))",
};

export function Flower() {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true" style={DIE_CUT}>
      <g transform="translate(22 22)">
        {[0, 72, 144, 216, 288].map((r) => (
          <g key={r} transform={`rotate(${r})`}>
            <ellipse cx="0" cy="-11" rx="7.5" ry="10" fill="#F6A5B7" />
            <ellipse cx="0" cy="-12.5" rx="4" ry="6" fill="#FBC3CF" />
          </g>
        ))}
        <circle r="6.5" fill="#F7C948" />
        <circle r="6.5" fill="none" stroke="#2B3A55" strokeWidth="1.4" />
        <circle cx="-2" cy="-2" r="1.6" fill="#FFF3C4" />
      </g>
    </svg>
  );
}

export function Star() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" style={DIE_CUT}>
      <path
        d="M20 3.5 L24.9 14.2 L36.5 15.3 L27.8 23.1 L30.4 34.6 L20 28.7 L9.6 34.6 L12.2 23.1 L3.5 15.3 L15.1 14.2 Z"
        fill="#F7C948"
        stroke="#2B3A55"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M15 17.5 L18 15.5" stroke="#FFF3C4" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function Sun() {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true" style={DIE_CUT}>
      <g stroke="#2B3A55" strokeWidth="1.6" strokeLinecap="round">
        {[0, 45, 90, 135, 180, 225, 270, 315].map((r) => (
          <line key={r} x1="22" y1="4" x2="22" y2="8.5" transform={`rotate(${r} 22 22)`} />
        ))}
      </g>
      <circle cx="22" cy="22" r="10.5" fill="#FFD166" stroke="#2B3A55" strokeWidth="1.6" />
      <circle cx="18" cy="21" r="1.3" fill="#2B3A55" />
      <circle cx="26" cy="21" r="1.3" fill="#2B3A55" />
      <path d="M18 25.5 Q22 28.5 26 25.5" stroke="#2B3A55" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <circle cx="15.5" cy="24.5" r="1.6" fill="#F6A5B7" opacity="0.8" />
      <circle cx="28.5" cy="24.5" r="1.6" fill="#F6A5B7" opacity="0.8" />
    </svg>
  );
}

export function Cloud() {
  return (
    <svg width="56" height="34" viewBox="0 0 56 34" aria-hidden="true" style={DIE_CUT}>
      <path
        d="M13 29 C5 29 4 18 12 17 C12 8 24 6 28 13 C31 7 44 8 42 18 C50 17 51 29 43 29 Z"
        fill="#DCEBFF"
        stroke="#2B3A55"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M17 23 Q24 20 32 23" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function Heart() {
  return (
    <svg width="36" height="34" viewBox="0 0 36 34" aria-hidden="true" style={DIE_CUT}>
      <path
        d="M18 30 C6 21 3 15 3 10 C3 5 7 2.5 11 2.5 C14 2.5 16.5 4 18 6.5 C19.5 4 22 2.5 25 2.5 C29 2.5 33 5 33 10 C33 15 30 21 18 30 Z"
        fill="#F27D8E"
        stroke="#2B3A55"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 9 Q10.5 6 13.5 5.5" stroke="#FFD1D9" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** Translucent washi tape — straddles an edge at a slight angle. */
export function Tape({ hue = "mint" }: { hue?: "mint" | "peach" | "sky" }) {
  const base = { mint: "#BFE8D2", peach: "#FFD6B8", sky: "#CFE2FF" }[hue];
  const stripe = { mint: "#8FD3B0", peach: "#F7B98A", sky: "#9EC3F5" }[hue];
  const id = `tape-${hue}`;
  return (
    <svg width="84" height="22" viewBox="0 0 84 22" aria-hidden="true" style={{ opacity: 0.82 }}>
      <defs>
        <pattern id={id} width="8" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
          <rect width="8" height="22" fill={base} />
          <rect width="3" height="22" fill={stripe} />
        </pattern>
      </defs>
      <path d="M2 3 L82 1 L83 19 L1 21 Z" fill={`url(#${id})`} />
      <path d="M2 3 L82 1 L83 19 L1 21 Z" fill="none" stroke="#fff" strokeOpacity="0.5" strokeWidth="1" />
    </svg>
  );
}

/** Paperclip — hangs over the top border like it's holding the card. */
export function Paperclip() {
  return (
    <svg width="18" height="44" viewBox="0 0 18 44" aria-hidden="true">
      <path
        d="M13 10 V32 a4 4 0 0 1 -8 0 V8 a6 6 0 0 1 12 0 V34 a8 8 0 0 1 -16 0 V12"
        fill="none"
        stroke="#5B7DB8"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Pencil() {
  return (
    <svg width="60" height="18" viewBox="0 0 60 18" aria-hidden="true" style={DIE_CUT}>
      <rect x="12" y="4" width="36" height="10" fill="#FFD166" stroke="#2B3A55" strokeWidth="1.4" />
      <rect x="44" y="4" width="8" height="10" fill="#F6A5B7" stroke="#2B3A55" strokeWidth="1.4" />
      <path d="M12 4 L3 9 L12 14 Z" fill="#F9E2B8" stroke="#2B3A55" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.5 7.1 L3 9 L6.5 10.9 Z" fill="#2B3A55" />
      <line x1="18" y1="9" x2="40" y2="9" stroke="#2B3A55" strokeWidth="1" strokeOpacity="0.25" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  BOTANICAL — line art. Every leaf is generated ON the stem curve:   */
/*  sampled point + tangent → petiole → leaf outline → midrib.          */
/* ------------------------------------------------------------------ */

const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

type Pt = [number, number];
/** Quadratic Bézier point + unit tangent at t. */
function qb(p0: Pt, p1: Pt, p2: Pt, t: number): { p: Pt; tan: Pt } {
  const u = 1 - t;
  const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
  const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
  const dx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
  const dy = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
  const l = Math.hypot(dx, dy) || 1;
  return { p: [x, y], tan: [dx / l, dy / l] };
}
const f = (n: number) => n.toFixed(1);

/**
 * One leaf attached at `at`, growing along direction `dir` (unit), with
 * `width` as a fraction of length. shape "ovate" = round eucalyptus leaf,
 * "lance" = narrow pointed olive/ruscus leaf. Returns petiole + outline + midrib.
 */
function leaf(at: Pt, dir: Pt, len: number, width: number, shape: "ovate" | "lance", petiole = 4): string {
  const [ax, ay] = at;
  const [dx, dy] = dir;
  const nx = -dy, ny = dx; // normal
  const bx = ax + dx * petiole, by = ay + dy * petiole; // leaf base, end of petiole
  const tx = bx + dx * len, ty = by + dy * len; // tip
  const w = len * width;
  // control points: ovate bulges near the base, lance bulges mid-way
  const k = shape === "ovate" ? 0.38 : 0.5;
  const c1x = bx + dx * len * k + nx * w, c1y = by + dy * len * k + ny * w;
  const c2x = bx + dx * len * k - nx * w, c2y = by + dy * len * k - ny * w;
  const tipPull = shape === "ovate" ? 0.85 : 0.95;
  const e1x = bx + dx * len * tipPull + nx * w * 0.35, e1y = by + dy * len * tipPull + ny * w * 0.35;
  const e2x = bx + dx * len * tipPull - nx * w * 0.35, e2y = by + dy * len * tipPull - ny * w * 0.35;
  const mid = `M${f(bx)} ${f(by)} L${f(bx + dx * len * 0.8)} ${f(by + dy * len * 0.8)}`;
  return (
    `M${f(ax)} ${f(ay)} L${f(bx)} ${f(by)} ` +
    `C${f(c1x)} ${f(c1y)} ${f(e1x)} ${f(e1y)} ${f(tx)} ${f(ty)} ` +
    `C${f(e2x)} ${f(e2y)} ${f(c2x)} ${f(c2y)} ${f(bx)} ${f(by)} ` +
    mid
  );
}

/** Rotate a unit vector by deg. */
function rot([x, y]: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
}

function stemPath(p0: Pt, p1: Pt, p2: Pt) {
  return `M${f(p0[0])} ${f(p0[1])} Q${f(p1[0])} ${f(p1[1])} ${f(p2[0])} ${f(p2[1])}`;
}

/** Eucalyptus — alternate round leaves, bigger at the base, bud at the tip. */
export function Eucalyptus() {
  const P0: Pt = [18, 152], P1: Pt = [70, 110], P2: Pt = [142, 18];
  const leaves = [0.1, 0.22, 0.34, 0.46, 0.58, 0.7, 0.81, 0.9].map((t, i) => {
    const { p, tan } = qb(P0, P1, P2, t);
    const side = i % 2 === 0 ? 1 : -1;
    const len = 30 - i * 2.2;
    return leaf(p, rot(tan, side * 62), len, 0.62, "ovate", 3);
  });
  const tip = qb(P0, P1, P2, 1);
  return (
    <svg width="160" height="160" viewBox="0 0 160 160" aria-hidden="true" {...LINE}>
      <path d={stemPath(P0, P1, P2)} />
      {leaves.map((d, i) => <path key={i} d={d} />)}
      <path d={leaf(tip.p, tan2(tip.tan, 0), 12, 0.45, "ovate", 2)} />
    </svg>
  );
}
function tan2(t: Pt, deg: number): Pt { return rot(t, deg); }

/** Olive — opposite narrow leaves along a gently curving branch, two olives near the base. */
export function Olive() {
  const P0: Pt = [8, 104], P1: Pt = [80, 84], P2: Pt = [164, 16];
  const pairs = [0.12, 0.26, 0.4, 0.54, 0.68, 0.82, 0.94].flatMap((t, i) => {
    const { p, tan } = qb(P0, P1, P2, t);
    const len = 26 - i * 1.6;
    return [leaf(p, rot(tan, 48), len, 0.28, "lance", 3), leaf(p, rot(tan, -48), len, 0.28, "lance", 3)];
  });
  const a = qb(P0, P1, P2, 0.2).p;
  return (
    <svg width="170" height="120" viewBox="0 0 170 120" aria-hidden="true" {...LINE}>
      <path d={stemPath(P0, P1, P2)} />
      {pairs.map((d, i) => <path key={i} d={d} />)}
      <path d={`M${f(a[0])} ${f(a[1])} l6 10 M${f(a[0])} ${f(a[1])} l12 7`} />
      <circle cx={f(a[0] + 7)} cy={f(a[1] + 15)} r="5" />
      <circle cx={f(a[0] + 15)} cy={f(a[1] + 11)} r="5" />
    </svg>
  );
}

/** Ruscus — upright stem, opposite pointed leaves, tight to the stem. */
export function Branch() {
  const P0: Pt = [76, 166], P1: Pt = [70, 90], P2: Pt = [84, 14];
  const pairs = [0.1, 0.24, 0.38, 0.52, 0.66, 0.8].flatMap((t, i) => {
    const { p, tan } = qb(P0, P1, P2, t);
    const len = 34 - i * 3.2;
    return [leaf(p, rot(tan, 42), len, 0.34, "lance", 2), leaf(p, rot(tan, -42), len, 0.34, "lance", 2)];
  });
  const tip = qb(P0, P1, P2, 1);
  return (
    <svg width="150" height="170" viewBox="0 0 150 170" aria-hidden="true" {...LINE}>
      <path d={stemPath(P0, P1, P2)} />
      {pairs.map((d, i) => <path key={i} d={d} />)}
      <path d={leaf(qb(P0, P1, P2, 0.92).p, tip.tan, 14, 0.34, "lance", 1)} />
    </svg>
  );
}

/** Wheat — spikelets attached alternately to the stem, with awns. */
export function Wheat() {
  const P0: Pt = [44, 158], P1: Pt = [40, 100], P2: Pt = [48, 44];
  const spikes = [0.46, 0.56, 0.66, 0.76, 0.86, 0.95].flatMap((t, i) => {
    const { p, tan } = qb(P0, P1, P2, t);
    const len = 16 - i * 0.8;
    const l = leaf(p, rot(tan, 28), len, 0.42, "ovate", 0);
    const r = leaf(p, rot(tan, -28), len, 0.42, "ovate", 0);
    // awn: thin line continuing past each spikelet
    const al = rot(tan, 18), ar = rot(tan, -18);
    const awn = `M${f(p[0] + al[0] * len)} ${f(p[1] + al[1] * len)} l${f(al[0] * 26)} ${f(al[1] * 26)} ` +
      `M${f(p[0] + ar[0] * len)} ${f(p[1] + ar[1] * len)} l${f(ar[0] * 26)} ${f(ar[1] * 26)}`;
    return [l, r, awn];
  });
  const blade = qb(P0, P1, P2, 0.18);
  return (
    <svg width="100" height="160" viewBox="0 0 100 160" aria-hidden="true" {...LINE}>
      <path d={stemPath(P0, P1, P2)} />
      {spikes.map((d, i) => <path key={i} d={d} strokeWidth={d.startsWith("M") && d.includes(" l") && !d.includes("C") ? 1 : 1.5} />)}
      <path d={leaf(blade.p, rot(blade.tan, 70), 46, 0.22, "lance", 0)} />
    </svg>
  );
}

/** Fern — curved rachis with pinnae attached, shortening toward the curled tip. */
export function Fern() {
  const P0: Pt = [62, 168], P1: Pt = [66, 90], P2: Pt = [104, 22];
  const pinnae = [0.14, 0.24, 0.34, 0.44, 0.54, 0.64, 0.74, 0.84, 0.92].flatMap((t, i) => {
    const { p, tan } = qb(P0, P1, P2, t);
    const len = 38 - i * 3.6;
    return [leaf(p, rot(tan, 58), len, 0.3, "lance", 0), leaf(p, rot(tan, -58), len, 0.3, "lance", 0)];
  });
  const tip = qb(P0, P1, P2, 1).p;
  return (
    <svg width="140" height="175" viewBox="0 0 140 175" aria-hidden="true" {...LINE}>
      <path d={stemPath(P0, P1, P2)} />
      {pinnae.map((d, i) => <path key={i} d={d} />)}
      <path d={`M${f(tip[0])} ${f(tip[1])} c4 -6 10 -6 11 -1 c1 4 -3 6 -6 4`} />
    </svg>
  );
}

/** Small sprig tag — the only Botanical asset used in straddle mode. */
export function SprigTag() {
  const P0: Pt = [4, 27], P1: Pt = [24, 18], P2: Pt = [52, 4];
  const leaves = [0.25, 0.5, 0.75].map((t, i) => {
    const { p, tan } = qb(P0, P1, P2, t);
    const side = i % 2 === 0 ? 1 : -1;
    return leaf(p, rot(tan, side * 55), 12, 0.5, "ovate", 1.5);
  });
  return (
    <svg width="56" height="30" viewBox="0 0 56 30" aria-hidden="true" {...LINE} strokeWidth={1.4}>
      <path d={stemPath(P0, P1, P2)} />
      {leaves.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Placement                                                           */
/* ------------------------------------------------------------------ */

export type StickerName =
  | "flower" | "star" | "sun" | "cloud" | "heart" | "tape-mint" | "tape-peach" | "tape-sky" | "paperclip" | "pencil"
  | "eucalyptus" | "olive" | "branch" | "wheat" | "fern" | "sprig";

const ART: Record<StickerName, () => ReactElement> = {
  flower: Flower, star: Star, sun: Sun, cloud: Cloud, heart: Heart,
  "tape-mint": () => <Tape hue="mint" />, "tape-peach": () => <Tape hue="peach" />, "tape-sky": () => <Tape hue="sky" />,
  paperclip: Paperclip, pencil: Pencil,
  eucalyptus: Eucalyptus, olive: Olive, branch: Branch, wheat: Wheat, fern: Fern, sprig: SprigTag,
};

export type Placement =
  | { mode: "straddle"; edge: "top" | "bottom"; align: "left" | "right"; offset?: number; rotate?: number; hang?: boolean }
  | { mode: "watermark"; corner: "bottom-right" | "bottom-left" | "top-right"; opacity?: number; rotate?: number };

export type Slot =
  // Dashboard
  | "mission" | "todo" | "session" | "streak" | "history"
  // Block Registry
  | "blocks.identity" | "blocks.telemetry" | "blocks.boot" | "blocks.web" | "blocks.apps"
  // The Pack
  | "pack.add" | "pack.online" | "pack.offline" | "pack.leaderboard"
  // Performance Log
  | "plan.schedule" | "plan.connect" | "plan.header"
  // Login
  | "login";

type Entry = [StickerName, Placement];

const S = (edge: "top" | "bottom", align: "left" | "right", offset = 24, rotate = 0, hang = false): Placement =>
  ({ mode: "straddle", edge, align, offset, rotate, hang });
const W = (corner: "bottom-right" | "bottom-left" | "top-right", opacity = 0.16, rotate = 0): Placement =>
  ({ mode: "watermark", corner, opacity, rotate });

/**
 * Which sticker each slot shows, per theme. Themes not listed render nothing.
 * Notebook: every card gets at most ONE straddle sticker; tape is always on a
 * top edge; die-cut stickers alternate top/bottom so a page never looks like a
 * row of badges. Botanical: large faint watermarks, one SprigTag on the page's
 * header card only.
 */
export const STICKER_MAP: Record<string, Partial<Record<Slot, Entry>>> = {
  notebook: {
    mission: ["flower", S("top", "right", 28)],
    todo: ["paperclip", S("top", "left", 24, -4, true)],
    session: ["tape-mint", S("top", "left", 32, -5)],
    streak: ["star", S("bottom", "right", 28, 8)],
    history: ["cloud", S("top", "right", 36)],

    "blocks.identity": ["tape-peach", S("top", "right", 28, 4)],
    "blocks.telemetry": ["sun", S("top", "right", 28)],
    "blocks.boot": ["pencil", S("bottom", "left", 28, -3)],
    "blocks.web": ["star", S("top", "left", 32, -10)],
    "blocks.apps": ["cloud", S("top", "right", 36)],

    "pack.add": ["tape-sky", S("top", "left", 28, -4)],
    "pack.online": ["heart", S("top", "right", 28, 10)],
    "pack.offline": ["cloud", S("bottom", "right", 32)],
    "pack.leaderboard": ["star", S("top", "right", 28, -8)],

    "plan.schedule": ["pencil", S("top", "right", 28, 3)],
    "plan.connect": ["paperclip", S("top", "left", 24, 3, true)],
    "plan.header": ["sun", S("bottom", "right", 28)],

    login: ["flower", S("top", "right", 28, 8)],
  },
  botanical: {
    mission: ["eucalyptus", W("bottom-right", 0.14)],
    todo: ["olive", W("bottom-right", 0.14, -8)],
    session: ["sprig", S("top", "right", 28)],
    streak: ["wheat", W("bottom-right", 0.16)],
    history: ["fern", W("bottom-right", 0.14)],

    "blocks.identity": ["sprig", S("top", "right", 28)],
    "blocks.telemetry": ["olive", W("bottom-right", 0.14)],
    "blocks.boot": ["branch", W("bottom-right", 0.12)],
    "blocks.web": ["eucalyptus", W("bottom-right", 0.14)],
    "blocks.apps": ["fern", W("bottom-right", 0.12)],

    "pack.add": ["sprig", S("top", "right", 28)],
    "pack.online": ["eucalyptus", W("bottom-right", 0.14)],
    "pack.offline": ["olive", W("bottom-right", 0.14)],
    "pack.leaderboard": ["wheat", W("bottom-right", 0.14)],

    "plan.schedule": ["branch", W("bottom-right", 0.12)],
    "plan.connect": ["olive", W("bottom-right", 0.14)],
    "plan.header": ["sprig", S("top", "right", 28)],

    login: ["eucalyptus", W("bottom-right", 0.14)],
  },
};

function placementStyle(p: Placement): CSSProperties {
  if (p.mode === "straddle") {
    const base: CSSProperties = {
      position: "absolute",
      lineHeight: 0,
      pointerEvents: "none",
      zIndex: 2,
      [p.align]: p.offset ?? 24,
    };
    // `hang` = asset hooks over the edge (paperclip): mostly outside the card.
    const shift = p.hang ? "-70%" : "-50%";
    if (p.edge === "top") return { ...base, top: 0, transform: `translateY(${shift}) rotate(${p.rotate ?? 0}deg)` };
    return { ...base, bottom: 0, transform: `translateY(${p.hang ? "70%" : "50%"}) rotate(${p.rotate ?? 0}deg)` };
  }
  const pos: CSSProperties =
    p.corner === "bottom-right" ? { right: -18, bottom: -22 }
    : p.corner === "bottom-left" ? { left: -18, bottom: -22 }
    : { right: -18, top: -22 };
  return {
    position: "absolute",
    ...pos,
    opacity: p.opacity ?? 0.18,
    color: "var(--ink)",
    transform: `rotate(${p.rotate ?? 0}deg)`,
    lineHeight: 0,
    pointerEvents: "none",
  };
}

/**
 * Clips a watermark to the card's rounded box without the card needing
 * overflow-hidden — straddle stickers on the same card must stay uncut.
 *
 * z-index -1, not 0. Inside the card's stacking context (which `isolate`
 * guarantees) a negative layer paints above the card's own background and
 * BELOW its block content, which is exactly where a watermark belongs. At
 * z-index 0 it would paint above non-positioned text, and keeping it there
 * would mean wrapping every card's children in a positioned div — which these
 * cards cannot take, because most of them are flex containers whose children
 * are laid out directly. The wrapper would collapse those layouts.
 */
const CLIP: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  borderRadius: "inherit",
  pointerEvents: "none",
  zIndex: -1,
};

/**
 * Decorative card ornament.
 *
 * Host card requirements:
 *   - `relative` (both modes)
 *   - for watermark mode additionally `isolate`, and the card's content
 *     wrapper `relative z-[1]` so text paints above the art. The watermark
 *     clips itself to the card's radius; the card keeps overflow visible so
 *     straddle stickers are never cut off.
 * Renders nothing for themes without an entry. Stickers never carry meaning —
 * nothing in the UI depends on them.
 */
export function Sticker({ slot }: { slot: Slot }) {
  const { theme } = useTheme();
  const entry = STICKER_MAP[theme]?.[slot];
  if (!entry) return null;
  const [name, placement] = entry;
  const Art = ART[name];
  if (placement.mode === "watermark") {
    return (
      <span style={CLIP} aria-hidden="true" data-sticker={name}>
        <span style={placementStyle(placement)}><Art /></span>
      </span>
    );
  }
  return (
    <span style={placementStyle(placement)} aria-hidden="true" data-sticker={name}>
      <Art />
    </span>
  );
}
