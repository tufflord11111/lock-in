import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence } from "framer-motion";

interface KillEvent {
  name: string;
  timestamp: number;
}

export function KillFeed() {
  const [logs, setLogs] = useState<KillEvent[]>([]);

  useEffect(() => {
    const isTauri = "__TAURI_IPC__" in window;
    if (!isTauri) return;

    const unlisten = listen<KillEvent>("process-killed", (event) => {
      setLogs((prev) => [event.payload, ...prev].slice(0, 10));
    });

    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  if (logs.length === 0) return null;

  return (
    <div className="fixed top-24 right-10 z-[60] w-72 max-h-[400px] overflow-hidden pointer-events-none">
      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {logs.map((log, i) => (
            <motion.div
              key={`${log.name}-${log.timestamp}-${i}`}
              initial={{ opacity: 0, x: 100, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 50, scale: 0.9 }}
              className="bg-surface border-1 border-ink p-5 rounded-xl shadow-[shadow:var(--shadow-2)] flex flex-col"
            >
              <div className="flex justify-between items-center mb-2">
                <span className="text-[9px] font-black text-ink/40 label-plain tracking-[0.2em]">
                  {new Date(log.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="text-ink text-[8px] font-black px-2 py-0.5 label-plain border-1 border-ink rounded-full bg-highlight">
                  Terminated
                </span>
              </div>
              <p className="text-ink font-black label-plain text-xs tracking-tight">
                Extraction: <span className="underline decoration-2">{log.name}</span>
              </p>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
