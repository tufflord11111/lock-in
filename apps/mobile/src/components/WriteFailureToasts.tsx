import { useEffect, useState } from "react";
import { onWriteFailure, type WriteFailure } from "../writeFailures";

const AUTO_DISMISS_MS = 10000;
const MAX_VISIBLE = 2;

/**
 * The single visible channel for background write failures on mobile.
 * Sits above the tab bar, auto-dismisses, and never blocks interaction.
 */
export function WriteFailureToasts() {
  const [items, setItems] = useState<WriteFailure[]>([]);

  useEffect(
    () =>
      onWriteFailure((failure) =>
        setItems((prev) => [...prev, failure].slice(-MAX_VISIBLE))
      ),
    []
  );

  useEffect(() => {
    if (items.length === 0) return;
    const timer = setTimeout(
      () => setItems((prev) => prev.slice(1)),
      AUTO_DISMISS_MS
    );
    return () => clearTimeout(timer);
  }, [items]);

  if (items.length === 0) return null;

  return (
    <div className="toast-stack">
      {items.map((item) => (
        <div key={item.id} className="toast">
          <span>{item.message}</span>
          <button
            onClick={() => setItems((prev) => prev.filter((i) => i.id !== item.id))}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
