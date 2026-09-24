/** @type {import('tailwindcss').Config} */

/**
 * Colour names resolve to the CSS custom properties defined in
 * packages/ui/src/global.css. The <alpha-value> placeholder is what lets
 * opacity modifiers (text-navy/40, border-navy/20 …) keep working against a
 * variable — without it Tailwind would emit the colour and drop the alpha.
 *
 * The previous block hardcoded hexes that had drifted from what the app
 * actually rendered (brand.bg #F5F5F0 vs the real #F9F8F4, cockpit.gold
 * #D97706 vs #FFD166, royal.navy #334155 vs #1B2A4A). Those names are gone;
 * the two classes that relied on their stale values now use tokens that
 * preserve exactly the colour they rendered before (slate-ink, amber-deep).
 */
const token = (name) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

module.exports = {
  theme: {
    extend: {
      colors: {
        navy: token("navy"),
        "navy-2": token("navy-2"),
        paper: token("paper"),
        canvas: token("canvas"),
        sand: token("sand"),
        gold: token("gold"),
        "gold-2": token("gold-2"),
        danger: token("danger"),
        "danger-2": token("danger-2"),
        surface: token("surface"),

        // One-offs, each its own token: no two of them are close enough to
        // merge (every measured pair was ΔE76 > 4).
        track: token("track"),
        alert: token("alert"),
        "alert-bright": token("alert-bright"),
        "alert-soft": token("alert-soft"),
        "danger-deep": token("danger-deep"),
        online: token("online"),
        success: token("success"),
        "success-solid": token("success-solid"),
        "success-edge": token("success-edge"),
        hero: token("hero"),
        "hero-panel": token("hero-panel"),
        "shadow-ink": token("shadow-ink"),
        "slate-ink": token("slate-ink"),
        "amber-deep": token("amber-deep"),
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        "4xl": "2rem",
        "5xl": "2.5rem",
      },
    },
  },
};
