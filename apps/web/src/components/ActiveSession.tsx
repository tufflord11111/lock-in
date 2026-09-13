import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, AlertTriangle } from "lucide-react";

function formatMmSs(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

type ActiveSessionProps = {
  taskLabel: string;
  timeLeft: number;
  totalMinutesFocused: number;
  totalMinutesToday: number;
  thresholdLimit: number;
  onEmergencyExit: () => void;
};

export function ActiveSession({
  taskLabel,
  timeLeft,
  totalMinutesFocused,
  totalMinutesToday,
  thresholdLimit,
  onEmergencyExit,
}: ActiveSessionProps) {
  const [showExitModal, setShowExitModal] = useState(false);
  const isCompleted = timeLeft <= 0;

  if (isCompleted) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-[#F9F8F4] text-[#002855] p-6 text-center animate-in fade-in duration-1000 overflow-hidden">
        <div className="mb-12 relative">
          <motion.div 
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="rounded-full border-4 border-[#002855] p-12 bg-[#FFD166] shadow-[12px_12px_0px_#002855]"
          >
            <Check size={80} strokeWidth={4} className="text-[#002855]" />
          </motion.div>
        </div>
        <h1 className="text-7xl font-black uppercase text-[#002855] mb-6 tracking-tight drop-shadow-[4px_4px_0px_#FFD166]">
          Objective Secured
        </h1>
        <p className="text-sm font-black uppercase tracking-widest text-[#002855]/60 mb-16">
          Protocol Satisfied // Telemetry Logged
        </p>
        <button
          onClick={onEmergencyExit}
          className="bg-[#002855] text-white px-16 py-6 font-black uppercase tracking-widest text-lg rounded-full border-2 border-[#002855] shadow-[6px_6px_0px_#002855] hover:translate-y-[2px] transition-all active:shadow-none active:translate-y-[6px]"
        >
          Return to Cockpit
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex h-screen w-full flex-col items-center justify-center bg-[#F9F8F4] text-[#002855] p-6 text-center overflow-hidden">
      <div className="relative z-10 flex flex-col items-center w-full max-w-2xl px-4">
        {/* Core Target / Mission */}
        <div className="mb-12 border-2 border-[#002855] bg-white px-8 py-4 rounded-2xl shadow-[6px_6px_0px_#002855] inline-flex items-center gap-4">
          <div className="w-3 h-3 bg-[#FFD166] border-2 border-[#002855] rounded-full animate-pulse" />
          <p className="text-xs font-black uppercase tracking-widest text-[#002855]">
            Core Target // {taskLabel || "Untitled"}
          </p>
        </div>

        {/* Massive Countdown Timer */}
        <div className="mb-20">
          <h1 className="text-[12rem] md:text-[16rem] font-black tracking-tighter leading-none text-[#002855] drop-shadow-[8px_8px_0px_#FFD166]">
            {formatMmSs(timeLeft)}
          </h1>
        </div>

        {/* Action Buttons */}
        <div className="grid grid-cols-2 gap-8 w-full max-w-lg mb-16">
          <div className="bg-white p-7 rounded-3xl border-2 border-[#002855] text-left shadow-[4px_4px_0px_#002855]">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#002855]/60 mb-2">Uptime today</p>
            <h4 className="text-4xl font-black text-[#002855]">{Math.floor(totalMinutesToday)}<span className="text-xs ml-1 opacity-60">MIN</span></h4>
          </div>
          <div className="bg-white p-7 rounded-3xl border-2 border-[#002855] text-left shadow-[4px_4px_0px_#002855]">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#002855]/60 mb-2">System cap</p>
            <h4 className="text-4xl font-black text-[#002855]">{Math.floor(thresholdLimit / 60)}<span className="text-xs ml-1 opacity-60">HRS</span></h4>
          </div>
        </div>

        <button
          onClick={() => setShowExitModal(true)}
          className="bg-[#FFD166] text-[#002855] px-12 py-6 rounded-full font-black uppercase tracking-widest text-lg border-4 border-[#002855] shadow-[8px_8px_0px_#002855] hover:translate-y-[2px] hover:shadow-[6px_6px_0px_#002855] transition-all active:translate-y-[8px] active:shadow-none"
        >
          Emergency Abort
        </button>
      </div>

      <AnimatePresence>
        {showExitModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#F9F8F4]/90 backdrop-blur-md p-6 text-center"
          >
            <div className="bg-white p-12 rounded-[3rem] border-4 border-[#002855] shadow-[12px_12px_0px_#002855] max-w-xl w-full">
              <AlertTriangle size={80} strokeWidth={2.5} className="mb-8 text-[#FFD166] mx-auto drop-shadow-[4px_4px_0px_#002855]" />
              <h2 className="text-5xl font-black uppercase tracking-wide text-[#002855] mb-6">
                Confirm Abort
              </h2>
              <p className="text-sm font-bold uppercase tracking-widest text-[#002855]/60 mb-12">
                Premature telemetry termination will be permanently recorded in mission logs.
              </p>

              <div className="flex gap-6 w-full">
                <button
                  onClick={() => setShowExitModal(false)}
                  className="flex-1 bg-white border-4 border-[#002855] text-[#002855] py-6 rounded-full text-lg font-black uppercase tracking-widest shadow-[6px_6px_0px_#002855] hover:translate-y-[2px] hover:shadow-[4px_4px_0px_#002855] transition-all active:shadow-none active:translate-y-[6px]"
                >
                  Cancel
                </button>
                <button
                  onClick={onEmergencyExit}
                  className="flex-1 bg-[#FFD166] border-4 border-[#002855] text-[#002855] py-6 rounded-full text-lg font-black uppercase tracking-widest shadow-[6px_6px_0px_#002855] hover:translate-y-[2px] hover:shadow-[4px_4px_0px_#002855] transition-all active:shadow-none active:translate-y-[6px]"
                >
                  Confirm
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}



