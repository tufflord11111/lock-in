import { useEffect, useState, useMemo, useRef } from "react";
import { db } from "@lock-in/firebase";
import { ref, onValue, get, increment, update, set } from "firebase/database";
import { invoke } from "@tauri-apps/api/core";
import { getDeviceId } from "../deviceId";

interface DeviceStats {
  id: string;
  name: string;
  minutes: number;
}

export function useOmniSync(
  userId: string | undefined,
  localMinutes: number,
  setLocalMinutes: (minutes: number) => void
) {
  const [deviceBreakdown, setDeviceBreakdown] = useState<DeviceStats[]>([]);
  // Defaults to "soft" — nothing should opt a user into fullscreen window
  // seizure they never asked for. See the is_locked notes in lib.rs.
  const [lockMode, setLockMode] = useState<"soft" | "hard">("soft");
  const [totalMinutesToday, setTotalMinutesToday] = useState(0);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [customBlocks, setCustomBlocks] = useState<string[]>([]);
  const [focusActive, setFocusActive] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [engineOffline, setEngineOffline] = useState(false);

  // 1. Stable per-install Device ID — shared with useFocusSession, which stamps
  //    it onto sessionState writes so the cross-device mirror can skip its own.
  const deviceId = useMemo(getDeviceId, []);

  // 2. Detect Platform Name
  const deviceName = useMemo(() => {
    const isTauri = "__TAURI_IPC__" in window;
    return isTauri ? "Windows Desktop" : "Web Browser";
  }, []);

  // ── DAILY RESET LOGIC ──────────────────────────────────────────
  const checkDailyReset = async () => {
    if (!userId) return;
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    const configRef = ref(db, `users/${userId}/config`);
    const snapshot = await get(configRef);
    const data = snapshot.val();
    
    if (data?.lastResetDate !== today) {
      // New day detected! Wipe all devices to reset everyone to 0 mins.
      const devicesRef = ref(db, `users/${userId}/devices`);
      await set(devicesRef, null);
      await update(configRef, { lastResetDate: today });
      console.log(`🌅 [System] New day detected (${today}). Daily minutes reset.`);
    }
  };


  // 3. Heartbeat — credit the time that has actually passed since the last tick.
  //
  // This used to add exactly 1 minute per setInterval(60000) call. WebView2
  // throttles, then suspends, timers in a hidden or covered window, and Tauri
  // can't turn that off on Windows — so a backgrounded app fired far fewer
  // than one call a minute and undercounted. minutesToday feeds the header's
  // "Uptime today" and the extension's daily-limit lock, which therefore
  // locked late or never. The same flaw the session countdown had.
  //
  // Now each tick measures the wall-clock gap since the previous one and
  // credits it in whole minutes, carrying the remainder. A single gap is
  // capped at MAX_CREDITED_GAP_MS: a longer one is the machine asleep, not
  // the app running, and must not be credited as uptime.
  const lastTickRef = useRef<number | null>(null);
  const carryMsRef = useRef(0);
  useEffect(() => {
    const MAX_CREDITED_GAP_MS = 15 * 60_000;
    lastTickRef.current = Date.now();
    carryMsRef.current = 0;

    const tick = async () => {
      if (!userId) return;
      const now = Date.now();
      const gap = Math.max(0, now - (lastTickRef.current ?? now));
      lastTickRef.current = now;
      carryMsRef.current += Math.min(gap, MAX_CREDITED_GAP_MS);
      const minutes = Math.floor(carryMsRef.current / 60_000);
      carryMsRef.current -= minutes * 60_000;

      try {
        // Check for midnight reset before heartbeat
        await checkDailyReset();

        const deviceRef = ref(db, `users/${userId}/devices/${deviceId}`);
        await update(deviceRef, {
          name: deviceName,
          ...(minutes > 0 ? { minutesToday: increment(minutes) } : {}),
          lastSync: now,
        });
      } catch (error) {
        // Give the minutes back so the next tick retries them.
        carryMsRef.current += minutes * 60_000;
        console.error("❌ OMNI-SYNC ERROR:", error);
      }
    };

    tick();
    const interval = setInterval(tick, 60000);
    return () => clearInterval(interval);
  }, [userId, deviceId, deviceName]);

  // 4. Listen to Firebase State (Devices, Config, Blocks)
  useEffect(() => {
    if (!userId) return;
    const devicesRef = ref(db, `users/${userId}/devices`);
    const configRef = ref(db, `users/${userId}/config`);
    const blocksRef = ref(db, `users/${userId}/customBlocks`);

    const unsubs = [
      onValue(configRef, (snapshot) => {
        const data = snapshot.val();
        if (data?.lockMode) setLockMode(data.lockMode);
        if (data?.autostartEnabled !== undefined) setAutostartEnabled(data.autostartEnabled);
        if (data?.focusActive !== undefined) setFocusActive(data.focusActive);
      }),
      onValue(blocksRef, (snapshot) => {
        const data = snapshot.val();
        const blocks = data ? (Object.values(data) as string[]) : [];
        setCustomBlocks(blocks);
      }),
      onValue(devicesRef, (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        let total = 0;
        const stats: DeviceStats[] = [];

        Object.entries(data).forEach(([id, device]: [string, any]) => {
          const mins = device.minutesToday || 0;
          total += mins;
          stats.push({
            id,
            name: device.name || (id === deviceId ? deviceName : id),
            minutes: mins,
          });
        });

        setDeviceBreakdown(stats);
        setTotalMinutesToday(total);
        
      })
    ];

    return () => unsubs.forEach(unsub => unsub());
  }, [userId, deviceId, deviceName]);

  // 5. Sync Minutes only
  useEffect(() => {
    if (!userId) return;
    const balanceRef = ref(db, `users/${userId}/balance`);
    get(balanceRef).then((snapshot) => {
      const data = snapshot.val();
      if (data) {
        if (data.minutes !== undefined) setLocalMinutes(data.minutes);
      }
    });

    const balanceSyncRef = ref(db, `users/${userId}/balance`);
    update(balanceSyncRef, {
      minutes: localMinutes,
    });
  }, [localMinutes, userId]);

  const syncWithRustEngine = async (blockList: string[]) => {
    setIsSyncing(true);
    try {
      // sync_lock_state returns Result<String,String> — resolves → online, rejects → offline
      // In a plain browser (non-Tauri) this will throw and set engineOffline=true
      await invoke("sync_lock_state", {
        isLocked: false,
        lockMode: lockMode,
        blacklist: blockList,
        focusActive: focusActive
      });
      setEngineOffline(false);
    } catch (err) {
      console.warn("[Enforcer] sync_lock_state failed (not in Tauri or IPC error):", err);
      setEngineOffline(true);
    } finally {
      setIsSyncing(false);
    }
  };

  // 6. Tauri Enforcer Sync (background — fires whenever lock state or blocklist changes)
  useEffect(() => {
    syncWithRustEngine(customBlocks);
  }, [lockMode, customBlocks, focusActive]);



  const updateLockMode = async (mode: "soft" | "hard") => {
    if (!userId) return;
    const configRef = ref(db, `users/${userId}/config`);
    await update(configRef, { lockMode: mode });
  };

  const updateAutostart = async (enabled: boolean) => {
    if (!userId) return;
    const configRef = ref(db, `users/${userId}/config`);
    await update(configRef, { autostartEnabled: enabled });
  };

  const addBlock = async (exeName: string) => {
    if (!userId) return;
    const blocksRef = ref(db, `users/${userId}/customBlocks`);
    const newBlocks = [...customBlocks, exeName];
    await update(blocksRef, { [exeName.replace(/\./g, "_")]: exeName });
    await syncWithRustEngine(newBlocks);
  };

  const removeBlock = async (exeName: string) => {
    if (!userId) return;
    const newBlocks = customBlocks.filter(b => b !== exeName);
    await update(ref(db, `users/${userId}/customBlocks`), { [exeName.replace(/\./g, "_")]: null });
    await syncWithRustEngine(newBlocks);
  };


  return { 
    deviceBreakdown, 
    lockMode,
    updateLockMode,
    totalMinutesToday,
    autostartEnabled,
    updateAutostart,
    customBlocks,
    addBlock,
    removeBlock,
    isSyncing,
    engineOffline
  };
}

