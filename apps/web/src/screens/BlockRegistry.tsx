import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Trash2, ShieldAlert, AlertTriangle, Lock, Clock, User, Search, MousePointer2, FolderOpen, RefreshCcw, X, Power } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { db } from "@lock-in/firebase";
import { ref, onValue, set, remove, update } from "firebase/database";
import { guardWrite, reportWriteFailure } from "../writeFailures";
import { getDeviceId } from "../deviceId";
import { DeleteAccountButton } from "../components/DeleteAccountButton";

const DEFAULT_WEB_BLOCKS = [
  'tiktok.com', 'youtube.com', 'netflix.com', 'instagram.com', 'facebook.com',
  'twitter.com', 'crazygames.com', 'reddit.com', 'twitch.tv', 'x.com',
  'pinterest.com', 'snapchat.com',
];

interface BlockRegistryProps {
  userId: string;
  userName: string;
  blockedApps: string[];
  addBlock: (exe: string) => Promise<void>;
  removeBlock: (exe: string) => Promise<void>;
  totalMinutesToday: number;
  _updateAutostart: (enabled: boolean) => Promise<void>;
  isSyncing: boolean;
  engineOffline: boolean;
}

export function BlockRegistry({
  userId,
  userName,
  blockedApps,
  addBlock,
  removeBlock,
  totalMinutesToday,
  _updateAutostart,
  isSyncing,
  engineOffline
}: BlockRegistryProps) {
  const [newExe, setNewExe] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [runningApps, setRunningApps] = useState<string[]>([]);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scannerSearch, setScannerSearch] = useState("");

  // Permanent lock state
  const [permanentApps, setPermanentApps] = useState<string[]>([]);
  const [permanentWebBlocks, setPermanentWebBlocks] = useState<Record<string, string>>({});
  // Opt-in: renders OFF until the OS says otherwise. Was `true`, which showed
  // the toggle lit before get_autostart_state had answered.
  const [autostartOn, setAutostartOn] = useState(false);

  // Vault Status Panel state
  const [extensionLastSeen, setExtensionLastSeen] = useState<number | null>(null);
  const [blockedAppsCount, setBlockedAppsCount] = useState(0);
  const [lastSessionMins, setLastSessionMins] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // Web Blocker Registry state
  const [customWebBlocks, setCustomWebBlocks] = useState<Record<string, boolean>>({});
  const [removedDefaults, setRemovedDefaults] = useState<string[]>([]);
  const [newWebDomain, setNewWebDomain] = useState('');

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(interval);
  }, []);

  // Read real OS autostart state on mount
  useEffect(() => {
    invoke<boolean>('get_autostart_state')
      .then((enabled) => setAutostartOn(enabled))
      // A failed read must not claim autostart is on. Opt-in means OFF unless
      // the OS positively confirms it.
      .catch(() => setAutostartOn(false));
  }, []);

  useEffect(() => {
    if (!userId) return;
    const extRef = ref(db, `users/${userId}/extension_state/last_seen`);
    const unsubExt = onValue(extRef, (snap) => setExtensionLastSeen(snap.val()));

    const blocksRef = ref(db, `users/${userId}/blockedApps`);
    const unsubBlocks = onValue(blocksRef, (snap) => {
      const d = snap.val();
      setBlockedAppsCount(d ? Object.keys(d).length : 0);
    });

    const histRef = ref(db, `users/${userId}/sessionHistory`);
    const unsubHist = onValue(histRef, (snap) => {
      const d = snap.val();
      if (!d) { setLastSessionMins(null); return; }
      const entries = Object.values(d) as any[];
      entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setLastSessionMins(entries[0]?.minutes ?? null);
    });

    const permExeRef = ref(db, `users/${userId}/permanentExe`);
    const unsubPermExe = onValue(permExeRef, (snap) => {
      const d = snap.val();
      setPermanentApps(d ? (Object.values(d) as string[]).filter(v => typeof v === 'string') : []);
    });

    const permWebRef = ref(db, `users/${userId}/permanentBlocks`);
    const unsubPermWeb = onValue(permWebRef, (snap) => {
      setPermanentWebBlocks(snap.val() || {});
    });

    return () => { unsubExt(); unsubBlocks(); unsubHist(); unsubPermExe(); unsubPermWeb(); };
  }, [userId]);

  const webGuardStatus = extensionLastSeen !== null && (now - extensionLastSeen) < 300000;

  // Web Blocker Registry — Firebase reads. The open-tabs scanner that used to
  // subscribe to users/{uid}/openTabs is gone: tab lists are no longer uploaded
  // (F5) and the rules now reject openTabs writes outright.
  useEffect(() => {
    if (!userId) return;
    const u2 = onValue(ref(db, `users/${userId}/customBlocks`), s => setCustomWebBlocks(s.val() || {}));
    const u3 = onValue(ref(db, `users/${userId}/removedDefaults`), s => setRemovedDefaults(s.val() || []));
    return () => { u2(); u3(); };
  }, [userId]);

  // ── Add-entry gate ────────────────────────────────────────────────────────
  // EVERY path that adds an exe (typed, picker, drag-drop, browse) goes
  // through here. Rust classifies the term first — ok / warn / rejected —
  // and nothing is written to Firebase until the operator confirms in a
  // dialog that states plainly the app will be force-closed, without a save
  // prompt, whenever a session runs. Rejections surface their reason in the
  // registry error banner instead of vanishing at the Rust boundary.
  type BlockEntryVerdict = {
    verdict: "ok" | "warn" | "rejected";
    cleaned: string | null;
    reason: string | null;
  };
  const [pendingAdd, setPendingAdd] = useState<{ exe: string; verdict: BlockEntryVerdict } | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);

  const requestAddBlock = useCallback(async (exe: string) => {
    if (blockedApps.includes(exe)) return;
    let verdict: BlockEntryVerdict;
    try {
      verdict = await invoke<BlockEntryVerdict>("classify_block_entry", { raw: exe });
    } catch {
      // Not running under Tauri (plain-browser dev). Still confirm — the
      // enforcer re-validates at its own boundary regardless.
      verdict = { verdict: "ok", cleaned: exe, reason: null };
    }
    if (verdict.verdict === "rejected") {
      setErrorMessage(`"${exe}" refused — ${verdict.reason ?? "invalid block entry"}`);
      return;
    }
    setErrorMessage("");
    setPendingAdd({ exe, verdict });
  }, [blockedApps]);

  const confirmPendingAdd = async () => {
    if (!pendingAdd) return;
    setPendingBusy(true);
    try {
      await addBlock(pendingAdd.exe);
      setPendingAdd(null);
    } catch (err) {
      setErrorMessage("Failed to save block entry.");
      console.error(err);
    } finally {
      setPendingBusy(false);
    }
  };

  useEffect(() => {
    const unlistenDrop = listen<string[]>('tauri://file-drop', async (event) => {
      setIsDragging(false);
      const filePaths = event.payload;
      if (!filePaths || filePaths.length === 0) return;
      
      const path = filePaths[0];
      const fileName = path.split('\\').pop()!.split('/').pop()!;
      const extension = fileName.split('.').pop()?.toLowerCase();

      // 1. Resolve Shortcuts (.lnk)
      if (extension === 'lnk') {
        try {
          const resolvedPath = await invoke<string>('resolve_shortcut', { shortcutPath: path });
          const resolvedFileName = resolvedPath.split('\\').pop()!.split('/').pop()!;
          const resolvedExtension = resolvedFileName.split('.').pop()?.toLowerCase();
          
          if (resolvedExtension !== 'exe') {
             setErrorMessage("Shortcut does not point to an .exe file.");
             return;
          }
          
          const normalizedExe = resolvedFileName.toLowerCase();
          setErrorMessage("");
          if (!blockedApps.includes(normalizedExe)) {
            requestAddBlock(normalizedExe);
          }
        } catch (err) {
          setErrorMessage("Failed to resolve shortcut.");
          console.error(err);
        }
        return;
      }
      
      // 2. Strict .exe Validation
      if (extension !== 'exe') {
        setErrorMessage("Only .exe files are supported.");
        return;
      }

      // 3. Prevent Duplicates and Normalize Case
      const normalizedExe = fileName.toLowerCase();
      setErrorMessage(""); // Clear errors
      
      if (!blockedApps.includes(normalizedExe)) {
        requestAddBlock(normalizedExe);
      }
    });

    const unlistenHover = listen('tauri://file-drop-hover', () => {
      setIsDragging(true);
    });

    const unlistenCancelled = listen('tauri://file-drop-cancelled', () => {
      setIsDragging(false);
    });

    return () => {
      unlistenDrop.then(f => f());
      unlistenHover.then(f => f());
      unlistenCancelled.then(f => f());
    };
  }, [blockedApps, requestAddBlock]);

  const handleAdd = async () => {
    if (!newExe.trim()) return;
    const name = newExe.trim().toLowerCase();
    const finalName = name.endsWith(".exe") ? name : `${name}.exe`;
    setNewExe("");
    // Gate, don't write. The confirm dialog carries the name from here.
    await requestAddBlock(finalName);
  };

  // Web Blocker helpers
  const visibleDefaultDomains = DEFAULT_WEB_BLOCKS.filter(d => !removedDefaults.includes(d));

  // Every Block Registry write goes through guardWrite: fire-and-forget so no
  // button can hang offline, and a refusal is a toast instead of an uncaught
  // rejection in a console nobody sees.
  const removeDefaultBlock = (domain: string) => {
    // removedDefaults is stored as an array; always write it whole. Deleting a
    // single index would turn it into an object and break every .includes().
    guardWrite(
      set(ref(db, `users/${userId}/removedDefaults`), [...removedDefaults, domain]),
      `Couldn't remove ${domain} from your default blocks. It's still blocked.`
    );
  };

  const removeCustomBlock = (domain: string) => {
    const safeKey = domain.replace(/\./g, '_');
    guardWrite(
      remove(ref(db, `users/${userId}/customBlocks/${safeKey}`)),
      `Couldn't remove ${domain}. It's still blocked.`
    );
  };

  const addWebBlockManual = () => {
    const raw = newWebDomain.trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/.*$/, '');
    if (!raw || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) return;
    const domain = raw.toLowerCase();
    const safeKey = domain.replace(/\./g, '_');
    setNewWebDomain('');
    guardWrite(
      set(ref(db, `users/${userId}/customBlocks/${safeKey}`), domain),
      `Couldn't add ${domain} to your blocks. It isn't blocked yet — try again.`
    );
  };

  const handleToggleAutostart = async () => {
    const previous = autostartOn;
    const newState = !previous;
    // Show the change at once; the OS registration is the truth, so undo the
    // switch if it fails. (The old handler said "Revert if Tauri call failed"
    // and then did nothing — and told the operator nothing either.)
    setAutostartOn(newState);
    try {
      await invoke('toggle_autostart', { enable: newState });
    } catch (err) {
      setAutostartOn(previous);
      reportWriteFailure(
        `Couldn't turn launch-on-startup ${newState ? 'on' : 'off'}, so it's still ${previous ? 'on' : 'off'}.`,
        err
      );
      return;
    }
    // Firebase only mirrors the setting for other surfaces; don't block on it.
    guardWrite(
      _updateAutostart(newState),
      "Launch-on-startup changed on this PC, but the setting didn't sync to your account."
    );
  };

  // Moving an entry between session and permanent is ONE multi-path update, so
  // it is always in exactly one list. These used to be 2-3 separate writes:
  // a failure part-way left an entry in both lists or neither, and between
  // the steps of a move to session it was briefly not blocked at all.
  const makeExePermanent = (exe: string) => {
    const safeKey = exe.replace(/\./g, '_');
    guardWrite(
      update(ref(db), {
        [`users/${userId}/permanentExe/${safeKey}`]: exe,
        [`users/${userId}/blockedApps/${safeKey}`]: null,
        [`users/${userId}/blockedApps_meta/${safeKey}`]: null,
      }),
      `Couldn't make ${exe} permanent. It's still a session block.`
    );
  };

  const makeExeSession = (exe: string) => {
    const safeKey = exe.replace(/\./g, '_');
    guardWrite(
      update(ref(db), {
        [`users/${userId}/permanentExe/${safeKey}`]: null,
        [`users/${userId}/blockedApps/${safeKey}`]: exe,
        // This device vouches for it, as handleAddExe does, so the enforcer
        // auto-approves it here instead of staging it for approval (H1).
        [`users/${userId}/blockedApps_meta/${safeKey}`]: getDeviceId(),
      }),
      `Couldn't move ${exe} back to session blocks. It's still permanent.`
    );
  };

  const removePermanentExe = (exe: string) => {
    const safeKey = exe.replace(/\./g, '_');
    guardWrite(
      remove(ref(db, `users/${userId}/permanentExe/${safeKey}`)),
      `Couldn't remove the permanent block on ${exe}. It's still blocked.`
    );
  };

  // PERM is only offered on custom entries, so removedDefaults is deliberately
  // left alone. (This used to delete the whole removedDefaults list, turning
  // every default the user had removed back on.)
  const makeWebPermanent = (domain: string) => {
    const safeKey = domain.replace(/\./g, '_');
    guardWrite(
      update(ref(db), {
        [`users/${userId}/permanentBlocks/${safeKey}`]: domain,
        [`users/${userId}/customBlocks/${safeKey}`]: null,
      }),
      `Couldn't make ${domain} permanent. It's still a session block.`
    );
  };

  const makeWebSession = (domain: string) => {
    const safeKey = domain.replace(/\./g, '_');
    guardWrite(
      update(ref(db), {
        [`users/${userId}/permanentBlocks/${safeKey}`]: null,
        [`users/${userId}/customBlocks/${safeKey}`]: domain,
      }),
      `Couldn't move ${domain} back to session blocks. It's still permanent.`
    );
  };

  const removePermanentWeb = (key: string, domain: string) => {
    guardWrite(
      remove(ref(db, `users/${userId}/permanentBlocks/${key}`)),
      `Couldn't remove the permanent block on ${domain}. It's still blocked.`
    );
  };

  const handleBrowse = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Applications', extensions: ['exe', 'lnk'] }]
      });
      if (!selected) return;
      
      const path = selected;
      const fileName = path.split('\\').pop()!.split('/').pop()!;
      const extension = fileName.split('.').pop()?.toLowerCase();
      
      if (extension === 'lnk') {
        const targetPath = await invoke<string>('resolve_shortcut', { shortcutPath: path });
        const targetFileName = targetPath.split('\\').pop()!.split('/').pop()!;
        const normalizedExe = targetFileName.toLowerCase();
        if (!blockedApps.includes(normalizedExe)) {
          await requestAddBlock(normalizedExe);
        }
      } else if (extension === 'exe') {
        const normalizedExe = fileName.toLowerCase();
        if (!blockedApps.includes(normalizedExe)) {
          await requestAddBlock(normalizedExe);
        }
      }
    } catch (err) {
      setErrorMessage("Failed to browse files.");
      console.error(err);
    }
  };

  const handleOpenScanner = async () => {
    setIsScannerOpen(true);
    setIsScanning(true);
    try {
      const apps = await invoke<string[]>('get_running_apps');
      setRunningApps(apps);
    } catch (err) {
      console.error("Failed to scan running apps:", err);
      setErrorMessage("Scanner failed.");
    } finally {
      setIsScanning(false);
    }
  };

  const filteredRunningApps = runningApps.filter(app => 
    app.toLowerCase().includes(scannerSearch.toLowerCase())
  );

  return (
    <div className="h-full overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
      <div className="flex flex-row gap-8 w-full" style={{ paddingBottom: '200px', alignItems: 'flex-start' }}>
        {/* LEFT COLUMN: GLOBAL CONTROLS */}
        <div className="w-[450px] shrink-0 flex flex-col gap-8 self-start" style={{ minWidth: '280px' }}>
        {/* IDENTITY */}
        <section className="bg-white border-2 border-[#002855] p-8 rounded-3xl shadow-[4px_4px_0px_#002855]">
          <div className="flex items-center gap-3 mb-6">
            <User size={18} className="text-royal-blue" />
            <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-royal-blue/30">Operator Identity</h2>
          </div>
          <input
            value={userName}
            readOnly
            className="w-full bg-[#F9F8F4] border-2 border-dashed border-[#002855]/20 rounded-xl px-5 py-4 text-3xl font-bold text-[#002855]/40 outline-none cursor-not-allowed select-none transition-all"
            spellCheck="false"
            placeholder="DESIGNATION"
          />
          <p className="text-[9px] font-bold text-royal-blue/30 uppercase mt-3 italic tracking-wider">
            OPERATOR HANDLE LOCKED — SET ON REGISTRATION
          </p>
        </section>

        {/* UPTIME TRACKER */}
        <section className="bg-white border-2 border-[#002855] p-8 rounded-3xl shadow-[4px_4px_0px_#002855] flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-3 mb-8">
              <Clock size={18} className="text-royal-blue" />
              <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-royal-blue/30">Session Telemetry</h2>
            </div>
            
            <div className="flex flex-col gap-6 mb-8">
              <div className="flex justify-between items-end">
                <span className="text-5xl font-black text-[#002855] tracking-tighter tabular-nums">
                  {!totalMinutesToday ? "00:00 — STANDBY" : `${String(Math.floor(totalMinutesToday / 60)).padStart(2, '0')}:${String(Math.floor(totalMinutesToday % 60)).padStart(2, '0')}`}
                </span>
              </div>
            </div>
          </div>
          
          <div className="w-full bg-[#F9F8F4] border-2 border-dashed border-[#002855]/20 py-4 rounded-xl flex items-center justify-center">
             <span className="font-black uppercase text-[10px] tracking-widest text-[#002855]/40">Operator Uptime</span>
          </div>
        </section>

        {/* BOOT INITIALIZATION */}
        <section className="bg-white border-2 border-[#002855] p-6 rounded-3xl shadow-[4px_4px_0px_#002855]">
          <div className="flex items-center gap-3 mb-4">
            <Power size={18} className="text-royal-blue" />
            <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-royal-blue/30">Boot Initialization</h2>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-black text-[#002855] uppercase tracking-tight">LAUNCH ON STARTUP</p>
              <p className="text-[9px] font-bold text-[#002855]/40 mt-1">Lock-In opens when your PC starts so uptime tracking begins automatically</p>
            </div>
            <button
              onClick={handleToggleAutostart}
              style={{
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
                width: '48px',
                height: '26px',
                borderRadius: '999px',
                border: '2px solid #1B2A4A',
                background: autostartOn ? '#F5C842' : 'transparent',
                cursor: 'pointer',
                transition: 'background 0.2s',
                flexShrink: 0,
                padding: 0,
                outline: 'none',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: '2px',
                  left: autostartOn ? '24px' : '2px',
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  background: '#1B2A4A',
                  transition: 'left 0.2s',
                }}
              />
            </button>
          </div>
        </section>

        {/* ACCOUNT DELETION (F6) */}
        <DeleteAccountButton userId={userId} />

        {/* WEB BLOCKER REGISTRY */}
        <section className="w-full bg-[#F2EDE4] border-2 border-[#1B2A4A] p-6 rounded-3xl shadow-[4px_4px_0px_#1B2A4A] flex flex-col gap-4" style={{ height: 'auto', alignSelf: 'flex-start' }}>
          <div className="flex items-center gap-3">
            <Lock size={18} className="text-[#1B2A4A]" />
            <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-[#1B2A4A]/60">Web Blocker Registry</h2>
          </div>

          {/* BLOCKED SITES REGISTRY */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[9px] font-black uppercase tracking-widest text-[#1B2A4A]/50">BLOCKED SITES</span>
              <span className="text-[8px] font-black bg-[#1B2A4A] text-white px-1.5 py-0.5 rounded-full">{visibleDefaultDomains.length + Object.keys(customWebBlocks).length}</span>
            </div>
            <div style={{ maxHeight: '200px', overflowY: 'auto' }} className="flex flex-col gap-1">
              <p className="text-[8px] font-black uppercase tracking-[0.3em] text-[#1B2A4A]/30 mb-1">// DEFAULT</p>
              {visibleDefaultDomains.map(domain => (
                <div key={domain} className="flex items-center justify-between px-3 py-1.5 bg-white border border-[#1B2A4A]/10 rounded-lg">
                  <span className="text-[10px] font-mono text-[#1B2A4A]/70">{domain}</span>
                  <button onClick={() => removeDefaultBlock(domain)} className="text-[8px] font-black text-red-500 hover:text-red-700 uppercase tracking-widest transition-colors">REMOVE</button>
                </div>
              ))}
              <p className="text-[8px] font-black uppercase tracking-[0.3em] text-[#1B2A4A]/30 mt-2 mb-1">// CUSTOM</p>
              {Object.keys(customWebBlocks).length === 0 && Object.keys(permanentWebBlocks).length === 0 ? (
                <p className="text-[9px] font-black uppercase tracking-wider text-[#1B2A4A]/25 py-2 text-center">NO CUSTOM BLOCKS ADDED</p>
              ) : (
                <>
                  {Object.entries(customWebBlocks).map(([key, value]) => {
                    const displayDomain = typeof value === 'string' ? value : key.replace(/_/g, '.');
                    return (
                      <div key={key} className="flex items-center justify-between px-3 py-1.5 bg-white border border-[#1B2A4A]/10 rounded-lg gap-2">
                        <span className="text-[10px] font-mono text-[#1B2A4A]/70 flex-1 truncate">{displayDomain}</span>
                        <button onClick={() => makeWebPermanent(displayDomain)} className="text-[7px] font-black uppercase px-1.5 py-0.5 border border-[#1B2A4A]/30 rounded text-[#1B2A4A]/50 hover:bg-[#1B2A4A] hover:text-white transition-colors">PERM</button>
                        <button onClick={() => removeCustomBlock(displayDomain)} className="text-[8px] font-black text-red-500 hover:text-red-700 uppercase tracking-widest transition-colors">✕</button>
                      </div>
                    );
                  })}
                  {Object.entries(permanentWebBlocks).map(([key, value]) => {
                    const displayDomain = typeof value === 'string' ? value : key.replace(/_/g, '.');
                    return (
                      <div key={key} className="flex items-center justify-between px-3 py-1.5 bg-[#F5C842]/10 border border-[#F5C842] rounded-lg gap-2">
                        <span className="text-[10px] font-mono text-[#1B2A4A] flex-1 truncate">{displayDomain}</span>
                        <span className="text-[7px] font-black uppercase px-1.5 py-0.5 bg-[#F5C842] text-[#1B2A4A] border border-[#1B2A4A] rounded">24/7</span>
                        <button onClick={() => makeWebSession(displayDomain)} className="text-[8px] font-black text-[#1B2A4A]/40 hover:text-[#1B2A4A] uppercase tracking-widest transition-colors">SESSION</button>
                        <button onClick={() => removePermanentWeb(key, displayDomain)} className="text-[8px] font-black text-red-500 hover:text-red-700 uppercase tracking-widest transition-colors">✕</button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* C: MANUAL ADD */}
          <div className="flex gap-2 pt-3 border-t border-[#1B2A4A]/10">
            <input type="text" value={newWebDomain} onChange={(e) => setNewWebDomain(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addWebBlockManual()} placeholder="e.g. twitch.tv" className="flex-1 bg-white border border-[#1B2A4A]/30 rounded-xl px-3 py-2 text-[10px] font-mono text-[#1B2A4A] placeholder:text-[#1B2A4A]/30 outline-none focus:border-[#1B2A4A] transition-colors" />
            <button onClick={addWebBlockManual} className="bg-[#1B2A4A] text-white px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-[#002855] transition-colors">+ ADD</button>
          </div>
        </section>
      </div>

      {/* RIGHT COLUMN: BLACKLIST REGISTRY */}
      <div className="flex-1 flex flex-col gap-8 self-start">
        <section className="bg-white border-2 border-[#002855] rounded-3xl p-8 shadow-[4px_4px_0px_#002855] flex flex-col" style={{ paddingBottom: '40px' }}>
          <div className="flex items-center gap-3 mb-8">
            <ShieldAlert size={18} className="text-royal-blue" />
            <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-royal-blue/30">Restricted Registry</h2>
          </div>

          {errorMessage && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-6 p-4 bg-red-50 border-2 border-red-200 text-red-600 text-[10px] font-bold uppercase tracking-wider rounded-2xl flex items-center gap-3"
            >
              <ShieldAlert size={16} />
              {errorMessage}
            </motion.div>
          )}

          <div 
            className={`relative mb-8 border-2 border-dashed rounded-3xl p-10 flex flex-col items-center justify-center transition-all duration-300 ${
              isDragging 
                ? "border-royal-blue bg-royal-blue/5 scale-[1.02] shadow-lg" 
                : "border-royal-blue/10 bg-[#F9F8F4] hover:border-royal-blue/20"
            }`}
          >
             <Plus size={40} strokeWidth={1} className={`mb-4 transition-colors duration-300 ${isDragging ? 'text-royal-blue' : 'text-royal-blue/20'}`} />
             <p className={`text-[10px] font-black uppercase tracking-[0.3em] text-center mb-6 transition-colors duration-300 ${isDragging ? 'text-royal-blue' : 'text-royal-blue/40'}`}>
               {isDragging ? "DROP TO REGISTER" : "Drag & Drop .exe files here"}
             </p>

             <button
               onClick={handleBrowse}
               className="bg-white text-[#002855] border-2 border-[#002855] px-6 py-3 rounded-xl font-black text-[9px] uppercase tracking-widest flex items-center gap-3 hover:-translate-y-1 hover:shadow-[4px_4px_0px_#002855] active:translate-y-[2px] active:shadow-none transition-all shadow-[2px_2px_0px_#002855]"
             >
               <FolderOpen size={14} />
               Browse Files
             </button>
          </div>
          
          <div className="flex gap-4 mb-8">
            <input
              type="text"
              value={newExe}
              onChange={(e) => setNewExe(e.target.value)}
              placeholder="e.g. discord.exe"
              className="flex-1 bg-white border-2 border-[#002855] shadow-[2px_2px_0px_#002855] focus:translate-y-[2px] focus:shadow-none rounded-xl px-6 py-4 font-bold text-sm text-[#002855] placeholder:text-[#002855]/40 focus:outline-none transition-all disabled:opacity-50"
            />
            <button
              onClick={handleAdd}
              disabled={!newExe.trim() || isSyncing}
              className="bg-[#002855] text-white border-2 border-[#002855] px-8 rounded-xl font-black transition-all hover:-translate-y-1 hover:shadow-[4px_4px_0px_#002855] active:translate-y-[2px] active:shadow-none disabled:opacity-50 flex items-center justify-center shadow-[2px_2px_0px_#002855] min-w-[140px]"
            >
              {isSyncing ? (
                <span className="text-[10px] tracking-widest flex items-center gap-2">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                  >
                    <Clock size={14} />
                  </motion.div>
                  SYNCING...
                </span>
              ) : (
                <Plus size={22} strokeWidth={3} className="text-[#FFD166]" />
              )}
            </button>
          </div>

          <button
            onClick={handleOpenScanner}
            className="mb-8 w-full bg-[#F9F8F4] border-2 border-[#002855] border-dashed p-4 rounded-2xl flex items-center justify-center gap-4 text-royal-blue/40 hover:text-royal-blue hover:border-solid hover:bg-white transition-all group"
          >
            <MousePointer2 size={16} className="group-hover:animate-bounce" />
            <span className="text-[10px] font-black uppercase tracking-widest">Choose from Running Apps</span>
          </button>

          <div className="space-y-3 pr-2 pb-4">
            <h3 className="text-[9px] font-black uppercase tracking-[0.4em] text-royal-blue/20 mb-4 px-2">
              LISTED PROTOCOLS // {blockedApps.length + permanentApps.length}
            </h3>
            <style>
              {`
                .custom-scrollbar::-webkit-scrollbar { width: 4px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #1B2A4A; border-radius: 2px; }
              `}
            </style>
            <div className="grid grid-cols-1 gap-3 overflow-y-auto custom-scrollbar" style={{ maxHeight: '200px', overflowY: 'auto', scrollbarWidth: 'thin', paddingRight: '4px' }}>
              {blockedApps.map((exe) => (
                <motion.div
                  layout
                  key={exe}
                  className="group flex items-center justify-between bg-white border-2 border-[#002855] p-4 rounded-2xl hover:-translate-y-1 hover:shadow-[4px_4px_0px_#002855] transition-all shadow-[2px_2px_0px_#002855]"
                >
                  <span className="font-bold text-sm truncate pr-2 text-royal-blue/80 tracking-tight italic flex-1">{exe}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[7px] font-black uppercase px-2 py-0.5 border-2 border-[#002855] rounded text-[#002855]">SESSION</span>
                    <button onClick={() => makeExePermanent(exe)} className="text-[7px] font-black uppercase px-2 py-0.5 border border-[#002855]/30 rounded text-[#002855]/40 hover:border-[#F5C842] hover:text-[#002855] transition-colors">PERM</button>
                    <button onClick={() => removeBlock(exe)} className="text-royal-blue/20 hover:text-red-500 transition-colors ml-1">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </motion.div>
              ))}
              {permanentApps.map((exe) => (
                <motion.div
                  layout
                  key={exe}
                  className="group flex items-center justify-between bg-[#F5C842]/10 border-2 border-[#F5C842] p-4 rounded-2xl transition-all"
                >
                  <span className="font-bold text-sm truncate pr-2 text-royal-blue tracking-tight italic flex-1">{exe}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => makeExeSession(exe)} className="text-[7px] font-black uppercase px-2 py-0.5 border border-[#002855]/30 rounded text-[#002855]/40 hover:border-[#002855] transition-colors">SESSION</button>
                    <span className="text-[7px] font-black uppercase px-2 py-0.5 bg-[#F5C842] border-2 border-[#002855] rounded text-[#002855]">24/7</span>
                    <button onClick={() => removePermanentExe(exe)} className="text-royal-blue/20 hover:text-red-500 transition-colors ml-1">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </motion.div>
              ))}
              {blockedApps.length === 0 && permanentApps.length === 0 && (
                <div className="flex flex-col items-center justify-center p-4 opacity-10" style={{ height: '80px', padding: '1rem' }}>
                  <ShieldAlert size={32} strokeWidth={1} />
                  <p className="text-[10px] font-black uppercase tracking-[0.3em] mt-2">Registry Clear</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <footer className="p-6 rounded-3xl border-2 border-[#002855] shadow-[6px_6px_0px_#002855] bg-[#002855] text-white" style={{ marginBottom: '180px' }}>
          <p className="text-[9px] font-black uppercase tracking-widest mb-4 text-white/40">Vault Status</p>
          <div className="grid grid-cols-2 gap-px bg-white/10 rounded-xl overflow-hidden border border-white/10">
            {/* WEB GUARD */}
            <div className="bg-[#002855] p-4 flex flex-col gap-1">
              <span className="text-[9px] font-black uppercase tracking-widest text-white/40">Web Guard</span>
              <span className={`text-sm font-black uppercase tracking-tight ${webGuardStatus ? 'text-[#F5C842]' : 'text-[#FF4444]'}`}>
                {webGuardStatus ? 'PAIRED' : 'OFFLINE'}
              </span>
            </div>
            {/* RUST SNIPER */}
            <div className="bg-[#002855] p-4 flex flex-col gap-1 border-l border-white/10">
              <span className="text-[9px] font-black uppercase tracking-widest text-white/40">Rust Sniper</span>
              <span className={`text-sm font-black uppercase tracking-tight ${!engineOffline ? 'text-[#F5C842]' : 'text-[#FF4444]'}`}>
                {!engineOffline ? 'ACTIVE' : 'OFFLINE'}
              </span>
            </div>
            {/* BLOCKED APPS */}
            <div className="bg-[#002855] p-4 flex flex-col gap-1 border-t border-white/10">
              <span className="text-[9px] font-black uppercase tracking-widest text-white/40">Blocked Apps</span>
              <span className="text-sm font-black text-[#F5C842]">{blockedAppsCount}</span>
            </div>
            {/* LAST SESSION */}
            <div className="bg-[#002855] p-4 flex flex-col gap-1 border-t border-l border-white/10">
              <span className="text-[9px] font-black uppercase tracking-widest text-white/40">Last Session</span>
              <span className={`text-sm font-black uppercase ${lastSessionMins !== null ? 'text-[#F5C842]' : 'text-white/20'}`}>
                {lastSessionMins !== null ? `${lastSessionMins} MIN` : 'NONE'}
              </span>
            </div>
          </div>
        </footer>
      </div>
    </div>

      {/* ADD-ENTRY CONFIRMATION — every add path lands here before any write */}
      <AnimatePresence>
        {pendingAdd && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !pendingBusy && setPendingAdd(null)}
              className="absolute inset-0 bg-[#002855]/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className={`relative w-full max-w-[480px] bg-white border-4 p-8 flex flex-col gap-6 ${
                pendingAdd.verdict.verdict === "warn"
                  ? "border-red-600 shadow-[12px_12px_0px_#b91c1c]"
                  : "border-[#002855] shadow-[12px_12px_0px_#002855]"
              }`}
            >
              <div className="flex items-center gap-4">
                <div
                  className={`w-10 h-10 border-2 flex items-center justify-center ${
                    pendingAdd.verdict.verdict === "warn"
                      ? "bg-red-100 border-red-600"
                      : "bg-[#FFD166] border-[#002855]"
                  }`}
                >
                  {pendingAdd.verdict.verdict === "warn" ? (
                    <AlertTriangle size={20} className="text-red-600" />
                  ) : (
                    <ShieldAlert size={20} />
                  )}
                </div>
                <div>
                  <h2 className="text-xl font-black text-[#002855] uppercase tracking-tight">
                    {pendingAdd.verdict.verdict === "warn" ? "Block a work app?" : "Confirm block"}
                  </h2>
                  <p className="text-[9px] font-black text-royal-blue/30 uppercase tracking-widest">
                    {pendingAdd.exe}
                  </p>
                </div>
              </div>

              <p className="text-sm font-bold text-[#002855] leading-relaxed">
                <span className="font-black">{pendingAdd.exe}</span> will be closed
                immediately, without saving, every 2 seconds for as long as a
                session is running.
              </p>

              {pendingAdd.verdict.verdict === "warn" && (
                <p className="text-[11px] font-bold text-red-700 leading-relaxed bg-red-50 border-2 border-red-200 p-4">
                  {pendingAdd.verdict.reason} Anything unsaved in it is lost the
                  moment a session starts.
                </p>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setPendingAdd(null)}
                  disabled={pendingBusy}
                  className="flex-1 py-4 border-2 border-[#002855] bg-white text-[#002855] font-black text-[10px] uppercase tracking-widest hover:bg-[#F9F8F4] transition-all disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmPendingAdd}
                  disabled={pendingBusy}
                  className={`flex-1 py-4 border-2 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-40 ${
                    pendingAdd.verdict.verdict === "warn"
                      ? "bg-red-600 border-red-800 text-white hover:bg-red-700"
                      : "bg-[#002855] border-[#002855] text-white hover:bg-[#FFD166] hover:text-[#002855]"
                  }`}
                >
                  {pendingBusy
                    ? "Saving..."
                    : pendingAdd.verdict.verdict === "warn"
                      ? "Block it anyway"
                      : "Block it"}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* SCANNER MODAL */}
      <AnimatePresence>
        {isScannerOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsScannerOpen(false)}
              className="absolute inset-0 bg-[#002855]/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative w-full max-w-[500px] bg-white border-4 border-[#002855] shadow-[12px_12px_0px_#002855] p-8 flex flex-col max-h-[80vh]"
            >
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-[#FFD166] border-2 border-[#002855] flex items-center justify-center">
                    <RefreshCcw size={20} className={isScanning ? "animate-spin" : ""} />
                  </div>
                  <div>
                    <h2 className="text-xl font-black text-[#002855] uppercase tracking-tight">Live Scanner</h2>
                    <p className="text-[9px] font-black text-royal-blue/30 uppercase tracking-widest">Select Active Process</p>
                  </div>
                </div>
                <button onClick={() => setIsScannerOpen(false)} className="text-royal-blue/20 hover:text-royal-blue transition-colors">
                  <X size={24} />
                </button>
              </div>

              <div className="relative mb-6">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-royal-blue/20" size={18} />
                <input 
                  autoFocus
                  placeholder="FILTER PROCESSES..."
                  value={scannerSearch}
                  onChange={(e) => setScannerSearch(e.target.value)}
                  className="w-full bg-[#F9F8F4] border-2 border-[#002855] rounded-xl pl-12 pr-6 py-4 font-bold text-sm outline-none focus:bg-white transition-all"
                />
              </div>

              <div className="flex-1 overflow-y-auto pr-2 space-y-2 no-scrollbar">
                {isScanning ? (
                  <div className="py-20 flex flex-col items-center justify-center opacity-20">
                    <RefreshCcw size={40} className="animate-spin mb-4" />
                    <p className="text-[10px] font-black uppercase tracking-widest">Polling OS...</p>
                  </div>
                ) : filteredRunningApps.length > 0 ? (
                  filteredRunningApps.map(app => (
                    <button
                      key={app}
                      onClick={async () => {
                        // Close the scanner FIRST so the confirm dialog is not
                        // stacked under it, then gate — never write directly.
                        setIsScannerOpen(false);
                        await requestAddBlock(app);
                      }}
                      className="w-full text-left bg-white border-2 border-[#002855] p-4 flex items-center justify-between group hover:bg-[#FFD166] transition-all hover:-translate-y-1 hover:shadow-[4px_4px_0px_#002855] active:translate-y-0 active:shadow-none"
                    >
                      <span className="font-bold text-sm text-royal-blue">{app}</span>
                      <Plus size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  ))
                ) : (
                  <div className="py-20 flex flex-col items-center justify-center opacity-20">
                    <Search size={40} className="mb-4" />
                    <p className="text-[10px] font-black uppercase tracking-widest">No Matches Found</p>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
