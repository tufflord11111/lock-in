import { useState, useEffect } from "react";
import { CheckCircle, Circle, Plus, Trash2, X, Calendar } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { db } from "@lock-in/firebase";
import { ref, onValue, set, remove } from "firebase/database";
import { awaitWriteOrQueue } from "../offlineWrite";
import { guardWrite, reportWriteFailure } from "../writeFailures";

const WEEK_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
type WeekDay = typeof WEEK_DAYS[number];
type Task = { id: string; text: string; completed: boolean };
type WeeklyPlan = Record<WeekDay, Task[]>;

const initialPlan: WeeklyPlan = {
  Sun: [], Mon: [], Tue: [], Wed: [], Thu: [], Fri: [], Sat: []
};

// Start of week (Sunday)
function getStartOfWeek(date: Date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day; 
  return new Date(d.setDate(diff));
}

interface PerformanceLogProps {
  userId: string;
}

export function PerformanceLog({ userId }: PerformanceLogProps) {
  const [plan, setPlan] = useState<WeeklyPlan>(() => {
    const saved = localStorage.getItem("lockin_weekly_plan");
    return saved ? JSON.parse(saved) : initialPlan;
  });

  useEffect(() => {
    localStorage.setItem("lockin_weekly_plan", JSON.stringify(plan));
  }, [plan]);

  const [newTasks, setNewTasks] = useState<Record<WeekDay, string>>({
    Sun: "", Mon: "", Tue: "", Wed: "", Thu: "", Fri: "", Sat: ""
  });

  const addTask = (day: WeekDay) => {
    const text = newTasks[day].trim();
    if (!text) return;
    
    setPlan(prev => ({
      ...prev,
      [day]: [...prev[day], { id: crypto.randomUUID(), text, completed: false }]
    }));
    
    setNewTasks(prev => ({ ...prev, [day]: "" }));
  };

  const toggleTask = (day: WeekDay, id: string) => {
    setPlan(prev => ({
      ...prev,
      [day]: prev[day].map(t => t.id === id ? { ...t, completed: !t.completed } : t)
    }));
  };

  const deleteTask = (day: WeekDay, id: string) => {
    setPlan(prev => ({
      ...prev,
      [day]: prev[day].filter(t => t.id !== id)
    }));
  };

  // Google Calendar state
  const [calendarUrl, setCalendarUrl] = useState<string | null>(null);
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [calendarInput, setCalendarInput] = useState("");

  useEffect(() => {
    if (!userId) return;
    const calRef = ref(db, `users/${userId}/settings/calendarUrl`);
    const unsub = onValue(calRef, (snap) => {
      setCalendarUrl(snap.val() || null);
    });
    return () => unsub();
  }, [userId]);

  const saveCalendarUrl = async () => {
    const raw = calendarInput.trim();
    if (!raw || !raw.startsWith('https://calendar.google.com')) return;
    // Raced: offline, the modal used to stay open forever.
    const lateErrorMessage = "Couldn't save your calendar link — it was refused.";
    try {
      await awaitWriteOrQueue(set(ref(db, `users/${userId}/settings/calendarUrl`), raw), {
        lateErrorMessage,
      });
      setShowCalendarModal(false);
      setCalendarInput("");
    } catch (err) {
      reportWriteFailure("Couldn't save your calendar link. Check your connection and try again.", err);
    }
  };

  const disconnectCalendar = () => {
    guardWrite(
      remove(ref(db, `users/${userId}/settings/calendarUrl`)),
      "Couldn't disconnect your calendar. It's still linked."
    );
  };

  const now = new Date();
  const todayDateStr = now.toDateString();
  const monthYear = now.toLocaleString("default", { month: "long", year: "numeric" });
  
  const startOfWeek = getStartOfWeek(now);
  const weekDatesInfo = WEEK_DAYS.map((dayName, i) => {
    const d = new Date(startOfWeek);
    d.setDate(d.getDate() + i);
    return {
      name: dayName,
      dateNum: d.getDate(),
      isToday: d.toDateString() === todayDateStr
    };
  });

  return (
    <div className="flex flex-col h-full overflow-y-auto pb-40 animate-in fade-in slide-in-from-bottom-4 duration-700 w-full gap-6">

      {/* GOOGLE CALENDAR SECTION */}
      <div className="bg-[#F2EDE4] border-2 border-[#1B2A4A] rounded-2xl p-6 shadow-[4px_4px_0px_#1B2A4A]">
        <p className="text-[8px] font-black uppercase tracking-[0.3em] text-[#1B2A4A]/40 mb-1">// GOOGLE CALENDAR SYNC</p>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-black text-[#1B2A4A] uppercase tracking-tight">YOUR SCHEDULE</h2>
          {calendarUrl && (
            <button onClick={disconnectCalendar} className="text-[9px] font-black uppercase tracking-widest text-[#1B2A4A]/40 hover:text-red-500 transition-colors">DISCONNECT</button>
          )}
        </div>

        {calendarUrl ? (
          <iframe
            src={`${calendarUrl}&mode=WEEK&showTitle=0&showNav=1&showDate=1&showPrint=0&showTabs=0&showCalendars=0`}
            style={{ width: '100%', height: '500px', border: '2px solid #1B2A4A', borderRadius: '8px' }}
            frameBorder="0"
            scrolling="no"
            title="Google Calendar"
          />
        ) : (
          <div className="flex flex-col items-center justify-center py-12 gap-4 border-2 border-dashed border-[#1B2A4A]/20 rounded-xl">
            <Calendar size={40} className="text-[#1B2A4A]/20" />
            <p className="text-[10px] font-black uppercase tracking-widest text-[#1B2A4A]/40 text-center">Connect your Google Calendar<br />to see your schedule here</p>
            <button
              onClick={() => setShowCalendarModal(true)}
              className="bg-[#1B2A4A] text-white px-6 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-[#002855] transition-colors"
            >
              CONNECT GOOGLE CALENDAR
            </button>
          </div>
        )}
      </div>

      {/* CALENDAR CONNECT MODAL */}
      <AnimatePresence>
        {showCalendarModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowCalendarModal(false)}
              className="absolute inset-0 bg-[#1B2A4A]/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative w-full max-w-[480px] bg-[#F2EDE4] border-2 border-[#1B2A4A] shadow-[8px_8px_0px_#1B2A4A] p-8 rounded-2xl"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-black text-[#1B2A4A] uppercase tracking-tight">Connect Calendar</h2>
                <button onClick={() => setShowCalendarModal(false)} className="text-[#1B2A4A]/30 hover:text-[#1B2A4A] transition-colors">
                  <X size={20} />
                </button>
              </div>
              <div className="text-[9px] font-mono text-[#1B2A4A]/60 mb-6 space-y-1">
                <p>1. Open Google Calendar in your browser</p>
                <p>2. Click the gear icon (Settings)</p>
                <p>3. Click your calendar name on the left</p>
                <p>4. Scroll to "Integrate calendar"</p>
                <p>5. Copy the "Public URL to this calendar"</p>
                <p>6. Paste it below</p>
              </div>
              <input
                type="text"
                value={calendarInput}
                onChange={e => setCalendarInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveCalendarUrl()}
                placeholder="https://calendar.google.com/calendar/embed?src=..."
                className="w-full bg-white border-2 border-[#1B2A4A] rounded-xl px-4 py-3 text-[10px] font-mono text-[#1B2A4A] placeholder:text-[#1B2A4A]/30 outline-none focus:border-[#002855] mb-4 transition-colors"
              />
              <button
                onClick={saveCalendarUrl}
                disabled={!calendarInput.trim().startsWith('https://calendar.google.com')}
                className="w-full bg-[#1B2A4A] text-white py-3 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-[#002855] transition-colors disabled:opacity-40"
              >
                SAVE & CONNECT
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="bg-white border-2 border-[#002855] shadow-[6px_6px_0px_#002855] rounded-2xl p-6 flex flex-col min-h-[700px] w-full">
        
        {/* CALENDAR HEADER */}
        <div className="mb-8 pb-6 border-b-2 border-[#002855]/10">
          <h2 className="text-3xl font-black text-[#002855] uppercase tracking-wide">
            {monthYear}
          </h2>
        </div>

        {/* 7-COLUMN INNER GRID */}
        <div className="grid grid-cols-7 flex-1">
          {weekDatesInfo.map((dayInfo, idx) => {
            const isLast = idx === weekDatesInfo.length - 1;
            const day = dayInfo.name;
            return (
              <div 
                key={day} 
                className={`flex flex-col px-4 min-h-0 ${isLast ? "" : "border-r border-[#002855]/20"} ${dayInfo.isToday ? "bg-[#FFD166]/5 rounded-xl border border-[#FFD166]/20" : ""}`}
              >
                {/* Header Row & Date Row */}
                <div className="flex flex-col items-center mb-6">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#002855]/40 mb-1">
                    {dayInfo.name}
                  </span>
                  <div className={`w-12 h-12 flex items-center justify-center rounded-full text-xl font-black ${
                    dayInfo.isToday ? "bg-[#FFD166] text-[#002855] border-2 border-[#002855] shadow-[2px_2px_0px_#002855]" : "text-[#002855]"
                  }`}>
                    {dayInfo.dateNum}
                  </div>
                </div>

                {/* Content Area */}
                <div className="flex gap-2 mb-6">
                  <input
                    type="text"
                    value={newTasks[day]}
                    onChange={e => setNewTasks(prev => ({ ...prev, [day]: e.target.value }))}
                    onKeyDown={e => e.key === "Enter" && addTask(day)}
                    placeholder="Log..."
                    className="flex-1 min-w-0 bg-[#F9F8F4] border-2 border-[#002855] shadow-[inset_0px_2px_0px_rgba(0,0,0,0.05)] rounded-xl px-3 py-2 text-xs font-bold text-[#002855] placeholder:text-[#002855]/30 outline-none focus:bg-white transition-all"
                  />
                  <button
                    onClick={() => addTask(day)}
                    className="shrink-0 bg-[#002855] text-white p-2 rounded-xl hover:-translate-y-px hover:shadow-[2px_2px_0px_#002855] active:translate-y-px active:shadow-none transition-all border-2 border-[#002855] flex items-center justify-center"
                  >
                    <Plus size={16} strokeWidth={3} className="text-[#FFD166]" />
                  </button>
                </div>

                <div className="flex flex-col space-y-3 overflow-y-auto max-h-[340px] pr-0.5" style={{ scrollbarWidth: 'thin', scrollbarColor: '#1B2A4A transparent' }}>
                  {plan[day].map(task => (
                    <motion.div 
                      layout
                      key={task.id}
                      className={`flex items-start justify-between p-3 rounded-xl transition-all group ${
                        task.completed 
                          ? "opacity-50" 
                          : "bg-white border-2 border-[#002855] shadow-[2px_2px_0px_#002855]"
                      }`}
                    >
                      <button 
                        onClick={() => toggleTask(day, task.id)}
                        className="flex items-start gap-3 flex-1 text-left min-w-0"
                      >
                        <div className="mt-0.5 shrink-0">
                          {task.completed ? (
                            <CheckCircle size={16} className="text-[#002855] fill-[#FFD166]" strokeWidth={2.5} />
                          ) : (
                            <Circle size={16} className="text-[#002855]" strokeWidth={3} />
                          )}
                        </div>
                        <span className={`text-xs font-bold tracking-tight leading-tight break-all whitespace-normal ${task.completed ? "line-through text-[#002855]/60" : "text-[#002855]"}`}>
                          {task.text}
                        </span>
                      </button>
                      <button 
                        onClick={() => deleteTask(day, task.id)}
                        className="shrink-0 text-[#002855]/0 group-hover:text-[#002855]/40 hover:!text-[red] transition-all"
                      >
                        <Trash2 size={14} strokeWidth={2.5} />
                      </button>
                    </motion.div>
                  ))}
                  {plan[day].length === 0 && (
                    <div className="flex flex-col items-center justify-center py-10 opacity-20 border-2 border-dashed border-[#002855]/20 rounded-xl mt-2">
                      <p className="text-[9px] font-black uppercase tracking-widest text-[#002855]">Empty</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
