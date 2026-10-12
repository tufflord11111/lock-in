import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A button that only fires after it has been held down.
 *
 * Used where a single click would be too cheap for what it does: starting a
 * long session you cannot stop, and bailing out of one. The fill is the whole
 * affordance — it tells you the hold is working and how much longer to wait.
 *
 * Keyboard reaches it too: Space or Enter held down fills at the same rate, so
 * this is not a mouse-only control.
 */
const TICK_MS = 16;

export function HoldButton({
  holdMs = 2000,
  onComplete,
  disabled = false,
  className = "",
  fillClassName = "bg-ink/20",
  children,
  ariaLabel,
}: {
  holdMs?: number;
  onComplete: () => void;
  disabled?: boolean;
  className?: string;
  fillClassName?: string;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  const [progress, setProgress] = useState(0);
  const startedAt = useRef<number | null>(null);
  const raf = useRef<number | undefined>(undefined);
  const done = useRef(false);

  const stop = useCallback(() => {
    startedAt.current = null;
    done.current = false;
    if (raf.current) window.clearInterval(raf.current);
    raf.current = undefined;
    setProgress(0);
  }, []);

  const begin = useCallback(() => {
    if (disabled || startedAt.current !== null) return;
    startedAt.current = Date.now();
    done.current = false;
    raf.current = window.setInterval(() => {
      if (startedAt.current === null) return;
      const p = Math.min(1, (Date.now() - startedAt.current) / holdMs);
      setProgress(p);
      if (p >= 1 && !done.current) {
        done.current = true;
        stop();
        onComplete();
      }
    }, TICK_MS);
  }, [disabled, holdMs, onComplete, stop]);

  useEffect(() => stop, [stop]);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      onBlur={stop}
      className={`relative overflow-hidden select-none touch-none ${className}`}
    >
      {/* The fill sits behind the label and never intercepts the pointer. */}
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 pointer-events-none transition-none ${fillClassName}`}
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative">{children}</span>
    </button>
  );
}
