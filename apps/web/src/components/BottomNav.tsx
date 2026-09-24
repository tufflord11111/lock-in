import { Calendar, Home, Settings, Users } from "lucide-react";

export type AppTab = "home" | "analytics" | "settings" | "pack";

type BottomNavProps = {
  currentTab: AppTab;
  onChange: (tab: AppTab) => void;
};

export function BottomNav({ currentTab, onChange }: BottomNavProps) {
  return (
    <nav className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50 bg-white border-2 border-navy p-2 rounded-[2rem] shadow-[4px_4px_0px_var(--navy)] min-w-[340px]">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onChange("home")}
          className={`flex flex-1 flex-col items-center gap-1.5 py-3.5 px-3 text-[9px] font-black uppercase tracking-[0.2em] transition-all rounded-2xl ${
            currentTab === "home"
              ? "bg-gold text-navy border-2 border-navy shadow-[2px_2px_0px_var(--navy)]"
              : "text-navy/40 hover:text-navy"
          }`}
        >
          <Home className="h-4 w-4" strokeWidth={3} />
          <span>Cockpit</span>
        </button>
        <button
          type="button"
          onClick={() => onChange("analytics")}
          className={`flex flex-1 flex-col items-center gap-1.5 py-3.5 px-3 text-[9px] font-black uppercase tracking-[0.2em] transition-all rounded-2xl ${
            currentTab === "analytics"
              ? "bg-gold text-navy border-2 border-navy shadow-[2px_2px_0px_var(--navy)]"
              : "text-navy/40 hover:text-navy"
          }`}
        >
          <Calendar className="h-4 w-4" strokeWidth={3} />
          <span>Planner</span>
        </button>
        <button
          type="button"
          onClick={() => onChange("pack")}
          className={`flex flex-1 flex-col items-center gap-1.5 py-3.5 px-3 text-[9px] font-black uppercase tracking-[0.2em] transition-all rounded-2xl ${
            currentTab === "pack"
              ? "bg-gold text-navy border-2 border-navy shadow-[2px_2px_0px_var(--navy)]"
              : "text-navy/40 hover:text-navy"
          }`}
        >
          <Users className="h-4 w-4" strokeWidth={3} />
          <span>The Pack</span>
        </button>
        <button
          type="button"
          onClick={() => onChange("settings")}
          className={`flex flex-1 flex-col items-center gap-1.5 py-3.5 px-3 text-[9px] font-black uppercase tracking-[0.2em] transition-all rounded-2xl ${
            currentTab === "settings"
              ? "bg-gold text-navy border-2 border-navy shadow-[2px_2px_0px_var(--navy)]"
              : "text-navy/40 hover:text-navy"
          }`}
        >
          <Settings className="h-4 w-4" strokeWidth={3} />
          <span>Protocols</span>
        </button>
      </div>
    </nav>
  );
}


