import { useEffect, useState } from "react";

/**
 * Whether Firebase is actually reachable right now.
 *
 * navigator.onLine is useless here: in a country that blocks Google the NIC is
 * up and the internet works, so onLine is true while every Firebase request
 * sits until TCP gives up ~21 s later. .info/connected is no better — it is
 * delivered over the same blocked transport, so offline it never arrives.
 *
 * So we ask directly, with our own deadline: one request to the database host,
 * raced against 3 s. We never read the response — any answer at all, including
 * a CORS rejection, proves packets are getting there and back.
 */
const DB_HOST = "https://synchrofocus-ac0f2-default-rtdb.asia-southeast1.firebasedatabase.app/.json?shallow=true";
const FIRST_PROBE_MS = 3000;
const REPROBE_MS = 30000;

async function probe(timeoutMs: number): Promise<boolean> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  try {
    await fetch(DB_HOST, { method: "GET", mode: "no-cors", cache: "no-store", signal: control.signal });
    return true;
  } catch (err) {
    // An abort is our deadline: unreachable. Anything else came back from the
    // network — a 401 or an opaque response still means the host answered.
    return !(err instanceof DOMException && err.name === "AbortError");
  } finally {
    clearTimeout(timer);
  }
}

export function useReachable(): { reachable: boolean; settled: boolean } {
  // Optimistic until the first probe lands, so an online boot never flashes
  // the pill; the probe settles well before anyone could read it.
  const [reachable, setReachable] = useState(true);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const run = async (timeout: number) => {
      const ok = await probe(timeout);
      if (!alive) return;
      setReachable(ok);
      setSettled(true);
      timer = window.setTimeout(() => run(REPROBE_MS > 3000 ? 3000 : REPROBE_MS), REPROBE_MS);
    };

    run(FIRST_PROBE_MS);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return { reachable, settled };
}
