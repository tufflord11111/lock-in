import { useEffect, useState } from "react";
import {
  dismissWriteFailure,
  onWriteFailure,
  onWriteFailureDismissed,
  type WriteFailure,
} from "../writeFailures";

const AUTO_DISMISS_MS = 10000;
const MAX_VISIBLE = 2;

/** Keep at most MAX_VISIBLE, dropping the oldest non-sticky toast first. */
function capVisible(list: WriteFailure[]): WriteFailure[] {
  const out = [...list];
  while (out.length > MAX_VISIBLE) {
    const i = out.findIndex((f) => !f.sticky);
    out.splice(i === -1 ? 0 : i, 1);
  }
  return out;
}

/**
 * The single visible channel for background write failures on mobile.
 * Sits above the tab bar and never blocks interaction. Ordinary toasts
 * auto-dismiss; sticky ones stay until closed or cleared by their caller.
 */
export function WriteFailureToasts() {
  const [items, setItems] = useState<WriteFailure[]>([]);

  useEffect(
    () =>
      onWriteFailure((failure) =>
        setItems((prev) => capVisible([...prev, failure]))
      ),
    []
  );

  useEffect(
    () =>
      onWriteFailureDismissed((id) =>
        setItems((prev) => prev.filter((i) => i.id !== id))
      ),
    []
  );

  useEffect(() => {
    const target = items.find((i) => !i.sticky);
    if (!target) return;
    const timer = setTimeout(
      () => setItems((prev) => prev.filter((i) => i.id !== target.id)),
      AUTO_DISMISS_MS
    );
    return () => clearTimeout(timer);
  }, [items]);

  if (items.length === 0) return null;

  return (
    <div className="toast-stack">
      {items.map((item) => (
        <div
          key={item.id}
          className={item.kind === "info" ? "toast info" : "toast"}
          role={item.kind === "info" ? "status" : "alert"}
        >
          <span>{item.message}</span>
          <button onClick={() => dismissWriteFailure(item.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
