/** @type {import('tailwindcss').Config} */

/**
 * Colour, radius and border names resolve to the theme tokens defined in
 * apps/web/src/theme/tokens.css. Components name a ROLE (bg-surface,
 * text-ink, border-line), never a colour, so a theme is a block of variables.
 *
 * The <alpha-value> placeholder is what lets opacity modifiers (text-ink/40)
 * keep working against a variable — without it Tailwind emits the colour and
 * drops the alpha.
 */
const token = (name) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

module.exports = {
  theme: {
    extend: {
      colors: {
        // Surfaces and ink
        ground: token("ground"),
        "ground-deep": token("ground-deep"),
        surface: token("surface"),
        "surface-alt": token("surface-alt"),
        "surface-inverse": token("surface-inverse"),
        "highlight-ink": token("highlight-ink"),
        "surface-tint": token("surface-tint"),
        "surface-dark": token("surface-dark"),
        ink: token("ink"),
        "ink-2": token("ink-2"),
        // Fixed alpha (ink at the most-used opacity), so no <alpha-value>.
        "ink-muted": "var(--ink-muted)",
        line: token("line"),

        // Accent and navigation
        accent: token("accent"),
        "accent-ink": token("accent-ink"),
        highlight: token("highlight"),
        "highlight-2": token("highlight-2"),
        "nav-active-bg": token("nav-active-bg"),
        "nav-active-ink": token("nav-active-ink"),

        // Structural one-offs
        track: token("track"),
        hero: token("hero"),
        "hero-panel": token("hero-panel"),
        "slate-ink": token("slate-ink"),
        "amber-deep": token("amber-deep"),
        "shadow-ink": token("shadow-ink"),

        // States. The scale steps exist because no two of them are within
        // ΔE76 2 of each other, so merging any pair would shift pixels.
        danger: token("danger"),
        "danger-soft": token("danger-soft"),
        "danger-deep": token("danger-deep"),
        "danger-shadow": token("danger-shadow"),
        "danger-50": token("danger-50"),
        "danger-100": token("danger-100"),
        "danger-200": token("danger-200"),
        "danger-400": token("danger-400"),
        "danger-600": token("danger-600"),
        "danger-800": token("danger-800"),
        alert: token("alert"),
        "alert-bright": token("alert-bright"),
        success: token("success"),
        "success-strong": token("success-strong"),
        "success-edge": token("success-edge"),
        "success-50": token("success-50"),
        "success-500": token("success-500"),
        "success-700": token("success-700"),
        online: token("online"),
        warn: token("warn"),
        offline: token("offline"),
        "info-50": token("info-50"),
      },
      borderRadius: {
        "auth-card": "var(--radius-auth-card)",
        "auth-field": "var(--radius-auth-field)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        "3xl": "var(--radius-3xl)",
        nav: "var(--radius-nav)",
      },
      borderWidth: {
        1: "var(--border-1)",
        2: "var(--border-2)",
        auth: "var(--border-auth)",
      },
      fontFamily: {
        display: "var(--font-display)",
        sans: "var(--font-ui)",
        label: "var(--font-label)",
        mono: "var(--font-mono)",
      },
      fontWeight: {
        display: "var(--weight-display)",
        ui: "var(--weight-ui)",
      },
    },
  },
};
