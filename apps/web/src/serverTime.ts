import { onValue, ref } from "firebase/database";
import { db } from "@lock-in/firebase";

/**
 * The server's clock, from Firebase's estimate of this PC's offset. The rules
 * judge a guarded session's end and its Bail out fuse by server time (B2).
 */
let offset = 0;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  onValue(ref(db, ".info/serverTimeOffset"), (s) => {
    const v = s.val();
    if (typeof v === "number") offset = v;
  });
}

export function serverOffset(): number {
  listen();
  return offset;
}

export function serverNow(): number {
  return Date.now() + serverOffset();
}
