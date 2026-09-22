import { useState, useEffect, useMemo } from "react";
import { Trash2, CheckCircle, Circle, Target } from "lucide-react";
import { db } from "@lock-in/firebase";
import { ref, onValue } from "firebase/database";

const presets = [
  { label: "Sprint", minutes: 25 },
  { label: "Flow", minutes: 45 },
  { label: "Deep", minutes: 60 },
  { label: "Lock", minutes: 90 },
];

/** Test-only: shown only when %APPDATA%\com.lockin.app\DEV_MODE exists. */
const MICRO_PRESET = { label: "Micro", minutes: 2 };

type Intention = { id: string; text: string; completed: boolean };

type DashboardProps = {
  userId: string;
  onStartSession: (minutes: number, taskLabel: string) => void;
  isActive: boolean;
  timeLeft: number;
  taskLabel: string;
  onEndSession: () => void;
  intentions: Intention[];
  setIntentions: (intentions: Intention[]) => void;
  /** False until the blockedApps listener has fired at least once. */
  blocklistHydrated: boolean;
  /** DEV_MODE file present: offer the 2-minute Micro session for testing. */
  devMode?: boolean;
};

export function Dashboard({
  userId,
  onStartSession,
  isActive,
  timeLeft,
  taskLabel,
  onEndSession,
  intentions,
  setIntentions,
  devMode = false,
  blocklistHydrated
}: DashboardProps) {
  const [objective, setObjective] = useState("");
  const [newIntention, setNewIntention] = useState("");
  const [selectedDay, setSelectedDay] = useState<any | null>(null);
  const [history, setHistory] = useState<Record<string, number>>({});
  const [avgSessionMins, setAvgSessionMins] = useState<number | null>(null);
  const dailyTarget = 2; // Hours

  // Task 1: Bridge Quick Capture from chrome.storage.local
  useEffect(() => {
    if (typeof (window as any).chrome !== 'undefined' && (window as any).chrome.storage) {
      const listener = (changes: any, namespace: string) => {
        if (namespace === 'local' && changes.lockin_intentions) {
          setIntentions(changes.lockin_intentions.newValue || []);
        }
      };
      (window as any).chrome.storage.onChanged.addListener(listener);
      return () => {
        (window as any).chrome.storage.onChanged.removeListener(listener);
      };
    }
  }, [setIntentions]);

  // Fetch History from Firebase
  useEffect(() => {
    const historyRef = ref(db, `users/${userId}/history`);
    const unsubscribe = onValue(historyRef, (snapshot) => {
      const data = snapshot.val();
      if (data) setHistory(data);
    });
    return () => unsubscribe();
  }, [userId]);

  // Fetch Session History for AVG SESSION stat
  useEffect(() => {
    if (!userId) return;
    const sessRef = ref(db, `users/${userId}/sessionHistory`);
    const unsub = onValue(sessRef, (snapshot) => {
      const d = snapshot.val();
      if (!d) { setAvgSessionMins(null); return; }
      const entries = Object.values(d) as any[];
      const withMins = entries.filter((e: any) => typeof e.minutes === 'number');
      if (withMins.length === 0) { setAvgSessionMins(null); return; }
      const avg = Math.round(
        withMins.reduce((s: number, e: any) => s + e.minutes, 0) / withMins.length
      );
      setAvgSessionMins(avg);
    });
    return () => unsub();
  }, [userId]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const formatLoggedTime = (mins: number) => {
    if (mins === 0) return "0 MINS";
    if (mins < 60) return `${mins} MINS`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (m === 0) return h === 1 ? "1 HR" : `${h} HRS`;
    return `${h} HR ${m} MINS`;
  };

  const startWithObjective = (minutes: number) => {
    onStartSession(minutes, objective || "Untitled Session");
  };

  const addIntention = () => {
    if (!newIntention.trim()) return;
    setIntentions([...intentions, { id: crypto.randomUUID(), text: newIntention.trim(), completed: false }]);
    setNewIntention("");
  };

  const toggleIntention = (id: string) => {
    setIntentions(intentions.map(i => i.id === id ? { ...i, completed: !i.completed } : i));
  };

  const deleteIntention = (id: string) => {
    setIntentions(intentions.filter(i => i.id !== id));
  };

  const heatmapData = useMemo(() => {
    return Array.from({ length: 30 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - (29 - i));
      const dateStr = date.toLocaleDateString('en-CA');
      
      const loggedMins = history[dateStr] || 0;
      const loggedHrs = loggedMins / 60;
      
      let state = 'empty';
      if (loggedHrs >= dailyTarget) state = 'met';
      else if (loggedHrs > 0) state = 'partial';
      
      return { 
        date: dateStr, 
        logged: Number(loggedHrs.toFixed(1)), 
        mins: loggedMins,
        state,
        dayIndex: i + 1 
      };
    });
  }, [history, dailyTarget]);

  // Calculate current streak (consecutive days where history[date] > 0)
  const { currentStreak, bestStreak } = useMemo(() => {
    let streak = 0;
    const today = new Date().toLocaleDateString('en-CA');
    let checkDate = new Date();
    if ((history[today] || 0) === 0) {
      checkDate.setDate(checkDate.getDate() - 1);
    }
    while (true) {
      const dStr = checkDate.toLocaleDateString('en-CA');
      if ((history[dStr] || 0) > 0) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }

    // Personal best: find longest run of consecutive days > 0
    const sortedDates = Object.keys(history).sort();
    let best = streak;
    let run = 0;
    for (let i = 0; i < sortedDates.length; i++) {
      if ((history[sortedDates[i]] || 0) > 0) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }

    return { currentStreak: streak, bestStreak: best };
  }, [history]);

  // Best day of week from last 7 days
  const bestDayOfWeek = useMemo(() => {
    const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const dayTotals: number[] = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toLocaleDateString('en-CA');
      const mins = history[dateStr] || 0;
      dayTotals[d.getDay()] += mins;
    }
    const maxMins = Math.max(...dayTotals);
    if (maxMins === 0) return null;
    return DOW[dayTotals.indexOf(maxMins)];
  }, [history]);

  return (
    <div className="flex flex-col h-full overflow-y-auto pb-40 gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700 pr-2">
      {/* FIX 1: webkit scrollbar styles for intentions list */}
      <style>{`
        .intentions-scroll::-webkit-scrollbar { width: 4px; }
        .intentions-scroll::-webkit-scrollbar-track { background: transparent; }
        .intentions-scroll::-webkit-scrollbar-thumb { background: #1B2A4A; border-radius: 2px; }
      `}</style>

      <div className="flex flex-col min-[1100px]:flex-row gap-8 shrink-0 w-full">
        {/* LEFT COLUMN: MISSION & INTENTIONS */}
        <div className="flex-1 flex flex-col gap-8 min-w-0">
          {/* STRATEGIC OBJECTIVE */}
          <section className="bg-white border-2 border-[#002855] rounded-3xl p-8 shadow-[4px_4px_0px_#002855]">
            <div className="flex items-center gap-3 mb-6">
              <Target size={18} className="text-royal-blue" />
              <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-royal-blue/30">Strategic Mission</h2>
            </div>
            <input
              type="text"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              disabled={isActive}
              placeholder="DEFINE CORE TARGET"
              className="w-full bg-transparent border-b border-royal-blue/10 py-3 text-4xl font-bold text-royal-blue outline-none focus:border-royal-blue transition-all disabled:opacity-50"
            />
          </section>

          {/* INTENTIONS / TO-DO LIST */}
          <section className="bg-white border-2 border-[#002855] rounded-3xl p-8 shadow-[4px_4px_0px_#002855] flex flex-col">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3">
                <CheckCircle size={18} className="text-royal-blue" />
                <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-royal-blue/30">Current Intentions</h2>
              </div>
              <span className="text-[10px] font-bold text-royal-blue/20 uppercase tracking-widest">
                {intentions.filter(i => i.completed).length}/{intentions.length} Secure
              </span>
            </div>

            {/* Input row — stays fixed above the scroll zone */}
            <div className="flex gap-3 mb-6">
              <input
                type="text"
                value={newIntention}
                onChange={(e) => setNewIntention(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addIntention()}
                placeholder="Add auxiliary intention..."
                className="flex-1 bg-white border-2 border-[#002855] shadow-[2px_2px_0px_#002855] rounded-xl px-5 py-3 text-sm font-bold text-[#002855] placeholder-[#002855]/40 outline-none focus:translate-y-[2px] focus:shadow-none transition-all"
              />
              <button
                onClick={addIntention}
                className="bg-[#002855] text-white px-5 rounded-xl text-xs font-black uppercase active:translate-y-[2px] transition-all border-2 border-[#002855] shadow-[4px_4px_0px_#002855] active:shadow-none"
              >
                Log
              </button>
            </div>

            {/* FIX 1: Scrollable intentions list */}
            <div
              className="intentions-scroll flex flex-col space-y-3"
              style={{ maxHeight: '280px', overflowY: 'auto', scrollbarWidth: 'thin' }}
            >
              {intentions.map((item) => (
                <div 
                  key={item.id}
                  className={`flex items-center justify-between p-4 rounded-2xl border-2 border-[#002855] transition-all group ${
                    item.completed ? "bg-[#F9F8F4] opacity-70 shadow-none translate-y-[2px]" : "bg-white shadow-[4px_4px_0px_#002855]"
                  }`}
                >
                  <button 
                    onClick={() => toggleIntention(item.id)}
                    className="flex items-center gap-4 flex-1 text-left"
                  >
                    {item.completed ? (
                      <CheckCircle size={22} className="text-[#002855] fill-[#FFD166]" strokeWidth={2.5} />
                    ) : (
                      <Circle size={22} className="text-[#002855]" strokeWidth={3} />
                    )}
                    <span className={`text-sm font-bold tracking-tight ${item.completed ? "line-through" : "text-royal-navy"}`}>
                      {item.text}
                    </span>
                  </button>
                  <button 
                    onClick={() => deleteIntention(item.id)}
                    className="text-royal-blue/0 group-hover:text-royal-blue/20 hover:text-amber-accent transition-all p-1"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {intentions.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 opacity-10">
                  <CheckCircle size={48} strokeWidth={1} />
                  <p className="text-[10px] font-black uppercase tracking-[0.3em] mt-4">No Intentions Logged</p>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN: TIMER & ENFORCEMENT */}
        <div className="w-full min-[1100px]:w-[400px] flex flex-col gap-8 shrink-0">
          {/* TIMER UNIT */}
          <section className="bg-white border-2 border-[#002855] rounded-[2.5rem] px-8 py-8 shadow-[6px_6px_0px_#002855] flex flex-col items-center justify-center text-center relative">
            {isActive ? (
              <div className="animate-in zoom-in-95 duration-500 w-full flex flex-col items-center">
                <p className="text-[10px] font-black uppercase tracking-[0.5em] text-[#002855] mb-6 animate-pulse">Session Active</p>
                
                <h1 className="text-[6rem] font-black text-[#002855] tracking-tighter tabular-nums mb-2 leading-none drop-shadow-[4px_4px_0px_#FFD166]">
                  {formatTime(timeLeft)}
                </h1>
                
                <p className="text-[10px] font-black uppercase tracking-widest text-[#002855]/60 mb-10 text-center w-full truncate px-4">
                  Core Target // {taskLabel || "Untitled"}
                </p>

                <button
                  onClick={onEndSession}
                  className="w-full bg-[#FFD166] text-[#002855] py-5 rounded-full font-black uppercase tracking-widest text-sm border-2 border-[#002855] shadow-[4px_4px_0px_#002855] hover:translate-y-[2px] hover:shadow-[2px_2px_0px_#002855] transition-all active:translate-y-[4px] active:shadow-none"
                >
                  Emergency Abort
                </button>
              </div>
            ) : (
              <div className="w-full flex flex-col items-center">
                <p className="text-[10px] font-black uppercase tracking-[0.4em] text-royal-blue/30 mb-8">Telemetry Initialization</p>
                
                <div className="grid grid-cols-2 gap-4 w-full mb-8">
                  {(devMode ? [...presets, MICRO_PRESET] : presets).map((p) => (
                    <button
                      key={p.minutes}
                      onClick={() => startWithObjective(p.minutes)}
                      className={`flex flex-col items-center p-6 bg-white border-2 border-[#002855] shadow-[2px_2px_0px_#002855] rounded-2xl hover:-translate-y-1 hover:shadow-[4px_4px_0px_#002855] transition-all group active:translate-y-[2px] active:shadow-none${p === MICRO_PRESET ? " col-span-2" : ""}`}
                    >
                      <span className="text-2xl font-black text-royal-blue leading-none mb-1">{p.minutes}</span>
                      <span className="text-[8px] font-black uppercase tracking-widest text-[#002855]/40 group-hover:text-[#002855]">{p.label}</span>
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => startWithObjective(25)}
                  className="w-full bg-[#002855] text-white py-6 rounded-full font-black uppercase tracking-widest text-sm border-2 border-[#002855] shadow-[4px_4px_0px_#002855] hover:translate-y-[2px] hover:shadow-[2px_2px_0px_#002855] transition-all active:translate-y-[4px] active:shadow-none"
                >
                  Engage Protocols
                </button>

                {/* Advisory, not a gate — starting offline is allowed, and the
                    enforcer falls back to its last persisted target list. */}
                {!blocklistHydrated && (
                  <p className="mt-4 text-[9px] font-black uppercase tracking-wider text-[#002855]/40 text-center leading-relaxed">
                    Blocklist syncing — starting now will use your last saved list
                  </p>
                )}
              </div>
            )}
          </section>

          {/* FIX 2: STREAK CARD — no emoji, three stat pills */}
          <section className="bg-white border-2 border-[#002855] rounded-3xl p-8 shadow-[4px_4px_0px_#002855]">
            <div className="flex items-center gap-3 mb-6">
              <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-royal-blue/30">OPERATOR STREAK</h2>
            </div>
            <div className="flex flex-col items-center text-center gap-2">
              <span className="text-[3rem] font-black text-[#002855] leading-none tabular-nums">
                {currentStreak === 0 ? "0" : currentStreak}
              </span>
              <span className="text-[10px] font-black uppercase tracking-[0.3em] text-[#002855]/30">
                {currentStreak === 0 ? "0 — Start Today" : "Day Streak"}
              </span>
              {/* FIX 2D: Three pills in one row */}
              <div className="mt-4 flex flex-row gap-2 flex-wrap justify-center">
                <div className="px-3 py-1.5 bg-[#F9F8F4] border border-[#002855]/10 rounded-xl">
                  <span className="text-[9px] font-black uppercase tracking-widest text-[#002855]/40">AVG SESSION: </span>
                  <span className="text-[9px] font-black text-[#002855]/60 uppercase tracking-widest">
                    {avgSessionMins !== null ? `${avgSessionMins} MIN` : '-- MIN'}
                  </span>
                </div>
                <div className="px-3 py-1.5 bg-[#F9F8F4] border border-[#002855]/10 rounded-xl">
                  <span className="text-[9px] font-black uppercase tracking-widest text-[#002855]/40">BEST DAY: </span>
                  <span className="text-[9px] font-black text-[#002855]/60 uppercase tracking-widest">
                    {bestDayOfWeek ?? '--'}
                  </span>
                </div>
                <div className="px-3 py-1.5 bg-[#F9F8F4] border border-[#002855]/10 rounded-xl">
                  <span className="text-[9px] font-black uppercase tracking-widest text-[#002855]/40">BEST: </span>
                  <span className="text-[9px] font-black text-[#F5C842] uppercase tracking-widest">{bestStreak} DAYS</span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* OPERATOR HEATMAP (BOTTOM FULL WIDTH) */}
      <section className="bg-white border-2 border-[#002855] rounded-3xl p-8 shadow-[4px_4px_0px_#002855] shrink-0 w-full mb-8">
        <div className="flex justify-between items-center mb-8">
          <h2 className="text-xl font-bold text-[#002855] tracking-tight">Operator Telemetry // 30-Day History</h2>
          
          <div className="flex items-center gap-6">
            <div className="bg-[#FFD166] border-2 border-[#002855] px-4 py-2 rounded-full shadow-[2px_2px_0px_#002855]">
              <span className="font-black text-[#002855] uppercase tracking-widest text-xs">Current Streak: {currentStreak} Days</span>
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-10 gap-3">
          {heatmapData.map((day, idx) => (
            <button 
              key={idx} 
              onClick={() => setSelectedDay(day)}
              className={`aspect-square rounded-lg cursor-pointer hover:-translate-y-1 transition-transform ${
                day.state === 'met' 
                  ? 'bg-[#FFD166] border-2 border-[#002855] shadow-[2px_2px_0px_#002855]' 
                  : day.state === 'partial'
                    ? 'bg-[#E2E8F0] border border-[#002855]/20'
                    : 'bg-[#F9F8F4] border border-[#002855]/20'
              }`}
            />
          ))}
        </div>

      </section>

      {/* TELEMETRY DETAIL MODAL */}
      {selectedDay && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center backdrop-blur-sm">
          <div className="bg-[#F9F8F4] border-2 border-[#002855] shadow-[4px_4px_0px_#002855] p-8 max-w-md w-full rounded-2xl flex flex-col animate-in zoom-in-95 duration-200">
            <h2 className="text-2xl font-black text-[#002855] mb-6">{selectedDay.date} // Telemetry Data</h2>
            
            <div className="flex flex-col gap-2 mb-8">
              <span className="text-sm font-bold text-[#002855]/60 uppercase tracking-widest">Total Locked In</span>
              <span className="text-5xl font-black text-[#002855] leading-none mb-2 tabular-nums">
                {formatLoggedTime(selectedDay.mins)} <span className="text-lg opacity-50">/ {dailyTarget} HRS</span>
              </span>
              
              <div className="mt-2 text-left">
                {selectedDay.mins >= (dailyTarget * 60) ? (
                  <span className="inline-block bg-[#FFD166] text-[#002855] border-2 border-[#002855] px-4 py-1.5 rounded-full font-black text-xs uppercase tracking-widest">
                    Status: Secured
                  </span>
                ) : selectedDay.mins > 0 ? (
                  <span className="inline-block bg-[#E2E8F0] text-[#002855] border-2 border-[#002855]/50 px-4 py-1.5 rounded-full font-black text-xs uppercase tracking-widest">
                    Status: On Track
                  </span>
                ) : (
                  <span className="inline-block bg-white text-[#002855]/50 border-2 border-[#002855]/20 px-4 py-1.5 rounded-full font-black text-xs uppercase tracking-widest">
                    Status: MIA
                  </span>
                )}
              </div>
            </div>

            <button 
              onClick={() => setSelectedDay(null)}
              className="w-full bg-white border-2 border-[#002855] text-[#002855] py-4 rounded-xl font-black uppercase text-sm shadow-[4px_4px_0px_#002855] active:translate-y-[4px] active:shadow-none hover:translate-y-[2px] hover:shadow-[2px_2px_0px_#002855] transition-all"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
