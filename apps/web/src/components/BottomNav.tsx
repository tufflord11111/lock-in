import { Calendar, Home, Settings, Users } from "lucide-react";
import { useCopy } from "../theme/copy";

export type AppTab = "home" | "analytics" | "settings" | "pack";

type BottomNavProps = {
  currentTab: AppTab;
  onChange: (tab: AppTab) => void;
};

export function BottomNav({ currentTab, onChange }: BottomNavProps) {
  const t = useCopy();
  return (
    <nav className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50 bg-surface border-1 border-ink p-2 rounded-nav shadow-[var(--shadow-2)] min-w-[340px]">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onChange("home")}
          className={`flex flex-1 flex-col items-center gap-1.5 py-3.5 px-3 text-[9px] font-black label-plain tracking-[0.2em] transition-all rounded-xl ${
            currentTab === "home"
              ? "bg-highlight text-ink border-1 border-ink shadow-[var(--shadow-1)]"
              : "text-ink/40 hover:text-ink"
          }`}
        >
          <Home className="h-4 w-4" strokeWidth={3} />
          <span>{t("nav.home")}</span>
        </button>
        <button
          type="button"
          onClick={() => onChange("analytics")}
          className={`flex flex-1 flex-col items-center gap-1.5 py-3.5 px-3 text-[9px] font-black label-plain tracking-[0.2em] transition-all rounded-xl ${
            currentTab === "analytics"
              ? "bg-highlight text-ink border-1 border-ink shadow-[var(--shadow-1)]"
              : "text-ink/40 hover:text-ink"
          }`}
        >
          <Calendar className="h-4 w-4" strokeWidth={3} />
          <span>{t("nav.plan")}</span>
        </button>
        <button
          type="button"
          onClick={() => onChange("pack")}
          className={`flex flex-1 flex-col items-center gap-1.5 py-3.5 px-3 text-[9px] font-black label-plain tracking-[0.2em] transition-all rounded-xl ${
            currentTab === "pack"
              ? "bg-highlight text-ink border-1 border-ink shadow-[var(--shadow-1)]"
              : "text-ink/40 hover:text-ink"
          }`}
        >
          <Users className="h-4 w-4" strokeWidth={3} />
          <span>{t("nav.pack")}</span>
        </button>
        <button
          type="button"
          onClick={() => onChange("settings")}
          className={`flex flex-1 flex-col items-center gap-1.5 py-3.5 px-3 text-[9px] font-black label-plain tracking-[0.2em] transition-all rounded-xl ${
            currentTab === "settings"
              ? "bg-highlight text-ink border-1 border-ink shadow-[var(--shadow-1)]"
              : "text-ink/40 hover:text-ink"
          }`}
        >
          <Settings className="h-4 w-4" strokeWidth={3} />
          <span>{t("nav.blocks")}</span>
        </button>
      </div>
    </nav>
  );
}


