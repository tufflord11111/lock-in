import {
  ACCENTS,
  THEMES,
  useTheme,
  type AccentName,
  type ThemeName,
} from "./ThemeProvider";

const THEME_COPY: Record<ThemeName, { name: string; blurb: string }> = {
  operator: { name: "Operator", blurb: "Hard edges, all caps. The original." },
  notebook: { name: "Notebook", blurb: "Paper, stickers, softer words." },
  bento: { name: "Bento", blurb: "Tiles, big numbers, one accent." },
  botanical: { name: "Botanical", blurb: "Forest green, linen, serif. Calm." },
};

const ACCENT_NAME: Record<AccentName, string> = {
  orange: "Orange",
  sage: "Sage",
  lavender: "Lavender",
  teal: "Teal",
};

/**
 * A miniature of the theme, drawn from that theme's own tokens rather than a
 * screenshot — so it can never drift from the real thing. The data-theme
 * attribute on the wrapper is what re-points every var() inside it.
 */
function Preview({ theme, accent }: { theme: ThemeName; accent: AccentName }) {
  return (
    <div
      data-theme={theme}
      data-accent={accent}
      aria-hidden
      className="pointer-events-none w-full h-20 p-2 flex gap-1.5 bg-ground rounded-md overflow-hidden"
      style={{ backgroundImage: "var(--grid-image)", backgroundSize: "var(--grid-size)" }}
    >
      <div className="flex-1 bg-surface border-1 border-line rounded-lg shadow-[var(--shadow-1)] p-1.5 flex flex-col gap-1">
        <span className="label-sm text-ink-muted text-[5px] leading-none">Focus</span>
        <span
          className="text-ink text-[13px] leading-none"
          style={{ fontFamily: "var(--font-display)", fontWeight: "var(--weight-display)" as never }}
        >
          25
        </span>
        <span className="mt-auto h-1.5 w-full rounded-sm bg-accent" />
      </div>
      <div className="w-6 flex flex-col gap-1">
        <span className="h-1.5 w-full rounded-sm bg-highlight" />
        <span className="h-1.5 w-2/3 rounded-sm bg-ink-muted" />
        <span className="mt-auto h-4 w-full rounded-nav bg-nav-active-bg" />
      </div>
    </div>
  );
}

/**
 * Appearance. Lives at the top of Protocols because it changes the whole app,
 * and the sub-line says plainly what it does not change.
 */
export function AppearancePicker() {
  const { theme, accent, setTheme, setAccent } = useTheme();

  return (
    <section className="bg-surface border-1 border-ink p-6 rounded-2xl shadow-[var(--shadow-2)]">
      <h2 className="text-sm font-black text-ink label-plain tracking-tight">Theme</h2>
      <p className="text-[9px] font-bold text-ink-muted mt-1 mb-4 leading-relaxed">
        Changes the look and the wording. Blocking works the same in every theme.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {THEMES.map((name) => {
          const selected = theme === name;
          return (
            <div key={name} className="flex flex-col gap-2">
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => setTheme(name)}
                className={`text-left p-2 rounded-xl border-1 transition-all ${
                  selected
                    ? "border-ink shadow-[var(--shadow-1)] bg-surface-alt"
                    : "border-ink/20 bg-surface hover:border-ink/50"
                }`}
              >
                <Preview theme={name} accent={accent} />
                <span className="mt-2 block text-[11px] font-black text-ink label-plain tracking-tight">
                  {THEME_COPY[name].name}
                  {selected && <span className="ml-2 text-[8px] text-ink-muted">Selected</span>}
                </span>
                <span className="block text-[9px] font-bold text-ink-muted leading-snug">
                  {THEME_COPY[name].blurb}
                </span>
              </button>

              {/* Bento is the only theme with a choice of accent. */}
              {name === "bento" && (
                <div className="flex items-center gap-2 px-2">
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      aria-pressed={accent === a}
                      aria-label={`${ACCENT_NAME[a]} accent`}
                      title={ACCENT_NAME[a]}
                      onClick={() => {
                        setAccent(a);
                        if (theme !== "bento") setTheme("bento");
                      }}
                      data-theme="bento"
                      data-accent={a}
                      className={`w-6 h-6 rounded-full bg-accent border-1 ${
                        accent === a ? "border-ink scale-110" : "border-ink/20"
                      } transition-transform`}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
