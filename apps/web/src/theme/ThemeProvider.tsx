import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { db } from "@lock-in/firebase";
import { ref, onValue, update } from "firebase/database";
import { awaitWriteOrQueue } from "../offlineWrite";
import { reportWriteFailure } from "../writeFailures";

export const THEMES = ["operator", "notebook", "bento", "botanical"] as const;
export type ThemeName = (typeof THEMES)[number];

export const ACCENTS = ["orange", "sage", "lavender", "teal"] as const;
export type AccentName = (typeof ACCENTS)[number];

export const DEFAULT_THEME: ThemeName = "operator";
export const DEFAULT_ACCENT: AccentName = "orange";

/** localStorage keys — the mirror that lets Login render in the last theme. */
export const THEME_KEY = "lockin.theme";
export const ACCENT_KEY = "lockin.accent";

export function isTheme(v: unknown): v is ThemeName {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}
export function isAccent(v: unknown): v is AccentName {
  return typeof v === "string" && (ACCENTS as readonly string[]).includes(v);
}

/**
 * Read the mirror. Called from main.tsx BEFORE React mounts as well as here,
 * so the first paint is already in the right theme — the config value arrives
 * a network round-trip later and would otherwise flash.
 */
export function readMirror(): { theme: ThemeName; accent: AccentName } {
  try {
    const t = localStorage.getItem(THEME_KEY);
    const a = localStorage.getItem(ACCENT_KEY);
    return {
      theme: isTheme(t) ? t : DEFAULT_THEME,
      accent: isAccent(a) ? a : DEFAULT_ACCENT,
    };
  } catch {
    // Private mode or blocked storage: the default is always safe.
    return { theme: DEFAULT_THEME, accent: DEFAULT_ACCENT };
  }
}

/** Apply to <html>. Everything else is CSS. */
export function applyTheme(theme: ThemeName, accent: AccentName): void {
  const el = document.documentElement;
  el.dataset.theme = theme;
  el.dataset.accent = accent;
}

function writeMirror(theme: ThemeName, accent: AccentName): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
    localStorage.setItem(ACCENT_KEY, accent);
  } catch {
    /* the account copy is the source of truth; the mirror is a convenience */
  }
}

type ThemeContextValue = {
  theme: ThemeName;
  accent: AccentName;
  setTheme: (t: ThemeName) => void;
  setAccent: (a: AccentName) => void;
  /** Adopt the account's stored choice without writing it back. */
  adopt: (t: unknown, a: unknown) => void;
  /** The signed-in uid, set by useAccountTheme so writes know where to go. */
  bindAccount: (uid: string | undefined) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  accent: DEFAULT_ACCENT,
  setTheme: () => {},
  setAccent: () => {},
  adopt: () => {},
  bindAccount: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * Owns the theme once React is running.
 *
 * Source of truth is users/{uid}/config/{theme,themeAccent}; localStorage is a
 * mirror so the pre-auth screens (Login, VerificationGate) render in the last
 * theme instead of flashing Operator. On sign-in config wins and overwrites
 * the mirror; on sign-out the mirror is kept.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const initial = useMemo(readMirror, []);
  const [theme, setThemeState] = useState<ThemeName>(initial.theme);
  const [accent, setAccentState] = useState<AccentName>(initial.accent);
  // Set by useAccountTheme. A ref, not state: binding must not re-render.
  const uidRef = useRef<string | undefined>(undefined);

  // Keep <html> and the mirror in step with state.
  useEffect(() => {
    applyTheme(theme, accent);
    writeMirror(theme, accent);
  }, [theme, accent]);

  const adopt = useCallback((t: unknown, a: unknown) => {
    if (isTheme(t)) setThemeState(t);
    if (isAccent(a)) setAccentState(a);
  }, []);

  const bindAccount = useCallback((uid: string | undefined) => {
    uidRef.current = uid;
  }, []);

  // Optimistic: the look changes at once, the write follows. Offline it is
  // queued and the operator is told, exactly like every other setting.
  const persist = useCallback(
    async (patch: Record<string, string>, what: string) => {
      const userId = uidRef.current;
      if (!userId) return;
      try {
        await awaitWriteOrQueue(update(ref(db, `users/${userId}/config`), patch), {
          lateErrorMessage: `Couldn't save your ${what}. It's applied on this PC but won't follow your account.`,
        });
      } catch (err) {
        reportWriteFailure(
          `Couldn't save your ${what}. It's applied on this PC but won't follow your account.`,
          err
        );
      }
    },
    []
  );

  const setTheme = useCallback(
    (t: ThemeName) => {
      setThemeState(t);
      void persist({ theme: t }, "theme");
    },
    [persist]
  );

  const setAccent = useCallback(
    (a: AccentName) => {
      setAccentState(a);
      void persist({ themeAccent: a }, "accent colour");
    },
    [persist]
  );

  const value = useMemo(
    () => ({ theme, accent, setTheme, setAccent, adopt, bindAccount }),
    [theme, accent, setTheme, setAccent, adopt, bindAccount]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Subscribes the signed-in account's stored choice into the provider. Called
 * once, from inside the app tree, so there is exactly one auth subscription
 * in the app and the provider itself stays uid-free.
 */
export function useAccountTheme(userId: string | undefined): void {
  const { adopt, bindAccount } = useTheme();
  useEffect(() => {
    bindAccount(userId);
  }, [userId, bindAccount]);
  useEffect(() => {
    if (!userId) return;
    const unsub = onValue(
      ref(db, `users/${userId}/config`),
      (snap) => {
        const cfg = (snap.val() ?? {}) as { theme?: unknown; themeAccent?: unknown };
        adopt(cfg.theme, cfg.themeAccent);
      },
      (err) => console.warn("[LOCK-IN] theme config listener error:", err)
    );
    return () => unsub();
  }, [userId, adopt]);
}
