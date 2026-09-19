import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Info, X } from "lucide-react";
import {
  dismissWriteFailure,
  onWriteFailure,
  onWriteFailureDismissed,
  recentWriteFailures,
  type WriteFailure,
} from "../writeFailures";

const AUTO_DISMISS_MS = 10000;
const MAX_VISIBLE = 3;

/**
 * Keep at most MAX_VISIBLE, dropping the oldest NON-sticky toast first: a
 * burst of ordinary failures must not push out a notice that is still true.
 */
function capVisible(list: WriteFailure[]): WriteFailure[] {
  const out = [...list];
  while (out.length > MAX_VISIBLE) {
    const i = out.findIndex((f) => !f.sticky);
    out.splice(i === -1 ? 0 : i, 1);
  }
  return out;
}

/**
 * The single visible channel for background write failures. Non-blocking:
 * it never covers the primary controls and auto-dismisses, but it tells the
 * operator exactly what did not save.
 */
export function WriteFailureToasts() {
  // Seeded from the replay buffer so a failure reported moments before this
  // host mounted (a sign-out swapping the tree) is still shown.
  const [items, setItems] = useState<WriteFailure[]>(() =>
    capVisible(recentWriteFailures())
  );

  useEffect(
    () =>
      onWriteFailure((failure) =>
        setItems((prev) => capVisible([...prev, failure]))
      ),
    []
  );

  // A caller clearing its own toast (e.g. the queued write was acknowledged).
  useEffect(
    () =>
      onWriteFailureDismissed((id) =>
        setItems((prev) => prev.filter((i) => i.id !== id))
      ),
    []
  );

  // Drop the oldest NON-sticky toast on a timer so a burst still clears.
  // Sticky toasts are never timed out: an info toast raised while the window
  // was in the background used to be gone before anyone looked.
  useEffect(() => {
    const target = items.find((i) => !i.sticky);
    if (!target) return;
    const timer = setTimeout(
      () => setItems((prev) => prev.filter((i) => i.id !== target.id)),
      AUTO_DISMISS_MS
    );
    return () => clearTimeout(timer);
  }, [items]);

  // Goes through dismissWriteFailure so the replay buffer forgets it too, and
  // a closed sticky toast doesn't reappear when this host remounts.
  const dismiss = (id: number) => dismissWriteFailure(id);

  return (
    // z-[110]: above the Dashboard's Telemetry modal (z-[100]), which would
    // otherwise dim a toast raised while it is open — e.g. a session ending.
    <div className="fixed bottom-6 left-6 z-[110] flex flex-col gap-2 max-w-[380px] pointer-events-none">
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className={
              item.kind === "info"
                ? "pointer-events-auto flex items-start gap-3 bg-white border-2 border-[#002855] shadow-[4px_4px_0px_#002855] rounded-xl px-4 py-3"
                : "pointer-events-auto flex items-start gap-3 bg-white border-2 border-[#B3261E] shadow-[4px_4px_0px_#7f1d1d] rounded-xl px-4 py-3"
            }
            style={{ fontFamily: "'Space Mono', monospace" }}
            role={item.kind === "info" ? "status" : "alert"}
          >
            {item.kind === "info" ? (
              <Info size={16} className="text-[#002855] shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle size={16} className="text-[#B3261E] shrink-0 mt-0.5" />
            )}
            <span className="text-[10px] font-bold text-[#002855] leading-relaxed flex-1">
              {item.message}
            </span>
            <button
              onClick={() => dismiss(item.id)}
              className="text-[#002855]/30 hover:text-[#002855] transition-colors shrink-0"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
