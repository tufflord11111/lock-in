import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, X } from "lucide-react";
import {
  onWriteFailure,
  recentWriteFailures,
  type WriteFailure,
} from "../writeFailures";

const AUTO_DISMISS_MS = 10000;
const MAX_VISIBLE = 3;

/**
 * The single visible channel for background write failures. Non-blocking:
 * it never covers the primary controls and auto-dismisses, but it tells the
 * operator exactly what did not save.
 */
export function WriteFailureToasts() {
  // Seeded from the replay buffer so a failure reported moments before this
  // host mounted (a sign-out swapping the tree) is still shown.
  const [items, setItems] = useState<WriteFailure[]>(() =>
    recentWriteFailures().slice(-MAX_VISIBLE)
  );

  useEffect(
    () =>
      onWriteFailure((failure) =>
        setItems((prev) => [...prev, failure].slice(-MAX_VISIBLE))
      ),
    []
  );

  // Drop the oldest on a timer so a burst of failures still clears.
  useEffect(() => {
    if (items.length === 0) return;
    const timer = setTimeout(
      () => setItems((prev) => prev.slice(1)),
      AUTO_DISMISS_MS
    );
    return () => clearTimeout(timer);
  }, [items]);

  const dismiss = (id: number) =>
    setItems((prev) => prev.filter((i) => i.id !== id));

  return (
    <div className="fixed bottom-6 left-6 z-[100] flex flex-col gap-2 max-w-[380px] pointer-events-none">
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="pointer-events-auto flex items-start gap-3 bg-white border-2 border-[#B3261E] shadow-[4px_4px_0px_#7f1d1d] rounded-xl px-4 py-3"
            style={{ fontFamily: "'Space Mono', monospace" }}
          >
            <AlertTriangle size={16} className="text-[#B3261E] shrink-0 mt-0.5" />
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
