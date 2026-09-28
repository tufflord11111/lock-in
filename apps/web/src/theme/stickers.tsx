// apps/web/src/theme/stickers.tsx
// Original sticker + line-art assets for the Notebook and Botanical themes.
// Drawn for Lock-In; no third-party artwork. Every sticker is decorative:
// aria-hidden, pointer-events none, absolutely positioned by <Sticker>.

import type { CSSProperties, ReactElement } from "react";
import { useTheme } from "./ThemeProvider";

export type StickerName = "flower" | "ladybug" | "cloud" | "fish" | "sprig" | "fern";
export type StickerCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const CORNER: Record<StickerCorner, CSSProperties> = {
  "top-left": { top: -18, left: 18 },
  "top-right": { top: -18, right: 18 },
  "bottom-left": { bottom: 14, left: 16 },
  "bottom-right": { bottom: 12, right: 18 },
};

/* ---------- Notebook stickers (filled, crayon-ish) ---------- */

export function Flower() {
  return (
    <svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true">
      <g transform="translate(27 27)">
        {[0, 72, 144, 216, 288].map((r) => (
          <ellipse key={r} cx="0" cy="-13" rx="8" ry="11" fill="#F7A8B8" transform={`rotate(${r})`} />
        ))}
        <circle r="7" fill="#F5C64A" stroke="var(--ink)" strokeWidth="1.5" />
      </g>
    </svg>
  );
}

export function Ladybug() {
  return (
    <svg width="46" height="40" viewBox="0 0 46 40" aria-hidden="true">
      <ellipse cx="23" cy="24" rx="19" ry="14" fill="#E8503A" stroke="var(--ink)" strokeWidth="2" />
      <path d="M23 10 L23 38" stroke="var(--ink)" strokeWidth="2" />
      <circle cx="23" cy="10" r="7" fill="var(--ink)" />
      <circle cx="14" cy="22" r="3" fill="var(--ink)" />
      <circle cx="31" cy="20" r="3" fill="var(--ink)" />
      <circle cx="17" cy="31" r="2.5" fill="var(--ink)" />
      <circle cx="30" cy="30" r="2.5" fill="var(--ink)" />
      <path d="M19 5 L15 1 M27 5 L31 1" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Cloud() {
  return (
    <svg width="70" height="40" viewBox="0 0 70 40" aria-hidden="true">
      <path
        d="M14 34 C4 34 4 20 14 20 C14 8 32 6 36 16 C42 6 60 10 56 22 C66 22 66 34 56 34 Z"
        fill="#FFFFFF"
        stroke="var(--ink-muted)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Fish() {
  return (
    <svg width="56" height="36" viewBox="0 0 56 36" aria-hidden="true">
      <path d="M6 18 L16 8 L16 28 Z" fill="#F0923B" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
      <ellipse cx="32" cy="18" rx="18" ry="12" fill="#F0923B" stroke="var(--ink)" strokeWidth="2" />
      <path d="M26 8 Q28 18 26 28 M34 7 Q36 18 34 29" stroke="#FFFFFF" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="42" cy="16" r="2.5" fill="var(--ink)" />
    </svg>
  );
}

/* ---------- Botanical line art (single stroke, ink) ---------- */

const LINE = {
  fill: "none",
  stroke: "var(--ink)",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  opacity: 0.8,
};

export function Sprig() {
  return (
    <svg width="140" height="90" viewBox="0 0 140 90" aria-hidden="true" {...LINE}>
      <path d="M20 88 C40 60 60 40 100 18" />
      <path d="M44 62 C36 48 44 36 58 36 C58 50 52 58 44 62 Z" />
      <path d="M66 46 C74 30 88 26 98 30 C92 44 80 50 66 46 Z" />
      <path d="M58 68 C66 62 78 64 84 74 C74 78 64 76 58 68 Z" />
      <path d="M100 18 C104 10 112 8 118 12 C114 20 106 22 100 18 Z" />
      <path d="M120 60 c-6 -8 0 -18 8 -16 c8 2 8 12 0 16 M124 60 v14 M116 64 l8 -4 l8 4" />
    </svg>
  );
}

export function Fern() {
  return (
    <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true" {...LINE}>
      <path d="M60 118 V64" />
      <path d="M60 64 c-10 -4 -14 -18 -6 -26 c8 6 12 18 6 26 Z" />
      <path d="M60 64 c10 -4 14 -18 6 -26 c-8 6 -12 18 -6 26 Z" />
      <path d="M60 46 c-10 -4 -14 -18 -6 -26 c8 6 12 18 6 26 Z" />
      <path d="M60 46 c10 -4 14 -18 6 -26 c-8 6 -12 18 -6 26 Z" />
      <path d="M60 30 c-6 -6 -6 -14 0 -18 c6 4 6 12 0 18 Z" />
      <path d="M60 90 c-12 0 -20 -8 -20 -18 c12 0 20 8 20 18 Z M60 104 c12 0 20 -8 20 -18 c-12 0 -20 8 -20 18 Z" />
    </svg>
  );
}

const ART: Record<StickerName, () => ReactElement> = {
  flower: Flower,
  ladybug: Ladybug,
  cloud: Cloud,
  fish: Fish,
  sprig: Sprig,
  fern: Fern,
};

/** Which sticker each card slot shows, per theme. Themes not listed render nothing. */
export const STICKER_MAP: Record<string, Partial<Record<"mission" | "todo" | "session" | "streak", [StickerName, StickerCorner]>>> = {
  notebook: {
    mission: ["flower", "top-right"],
    todo: ["ladybug", "bottom-right"],
    session: ["cloud", "top-left"],
    streak: ["fish", "bottom-left"],
  },
  botanical: {
    mission: ["sprig", "bottom-right"],
    streak: ["fern", "bottom-right"],
  },
};

/**
 * Decorative card ornament. Place inside a `position: relative` card.
 * Reads the active theme from the ThemeProvider (not the DOM attribute, so a
 * preview that overrides data-theme locally does not change which sticker the
 * real card shows); renders nothing for
 * themes without an entry. Never overlaps text: corners only.
 */
export function Sticker({ slot }: { slot: "mission" | "todo" | "session" | "streak" }) {
  const { theme } = useTheme();
  const entry = STICKER_MAP[theme]?.[slot];
  if (!entry) return null;
  const [name, corner] = entry;
  const Art = ART[name];
  return (
    <span style={{ position: "absolute", pointerEvents: "none", lineHeight: 0, ...CORNER[corner] }} aria-hidden="true">
      <Art />
    </span>
  );
}
