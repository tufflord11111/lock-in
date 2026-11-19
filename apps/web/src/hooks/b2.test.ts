import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SESSION_GUARD, DELETE_DURING_SESSION, PACK_TEXT, VERIFY_FIRST,
  guardedSessionLive, endRetryDelayMs, endWithOneRetry, bailoutEndFor, deleteCleanupUpdates,
  publicNameToWrite, inviteText, friendRequestWrite,
} from "./b2";
import { mayWriteSnapshot, ACCOUNT_LOCAL_KEYS } from "../snapshot";

// 1.3.1 B2 — privacy and Web Guard trust, webview side.
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const MIN = 60_000;
const T = 1_800_000_000_000;
const denied = Object.assign(new Error("PERMISSION_DENIED: Permission denied"), { code: "PERMISSION_DENIED" });

describe("item 1: sessions this build starts are guarded, and their ends get through", () => {
  it("the start write stamps guard: 2", () => {
    expect(SESSION_GUARD).toBe(2);
    expect(src("./useFocusSession.ts")).toMatch(/isActive: true,\n\s+guard: SESSION_GUARD,/);
  });

  it("knows a guarded session the rules still hold, as the rules do", () => {
    const s = { isActive: true, guard: 2, endTime: T + 30 * MIN };
    expect(guardedSessionLive(s, T)).toBe(true);
    expect(guardedSessionLive({ ...s, endTime: T + 60_000 }, T)).toBe(false); // inside the 120 s grace
    expect(guardedSessionLive({ ...s, bailoutEnd: T - 1 }, T)).toBe(false);
    expect(guardedSessionLive({ ...s, bailoutEnd: T + MIN }, T)).toBe(true);
    expect(guardedSessionLive({ ...s, guard: undefined }, T)).toBe(false); // 1.3.0's sessions
    expect(guardedSessionLive({ ...s, isActive: false }, T)).toBe(false);
    expect(guardedSessionLive(null, T)).toBe(false);
  });

  it("the one retry waits until the rules will take the end", () => {
    const s = { isActive: true, guard: 2, endTime: T + 3 * MIN };
    expect(endRetryDelayMs(s, T)).toBe(MIN + 2_000); // endTime - 120 s - now + 2 s
    expect(endRetryDelayMs({ ...s, bailoutEnd: T + 10_000 }, T)).toBe(12_000);
    expect(endRetryDelayMs(s, T + 5 * MIN)).toBe(2_000);
    expect(endRetryDelayMs(null, T)).toBe(2_000);
    expect(endRetryDelayMs({ ...s, endTime: T + 600 * MIN }, T)).toBe(6 * MIN); // capped
  });

  it("a refused end is retried once, then the error stands", async () => {
    const waits: number[] = [];
    let calls = 0;
    const sleep = async (ms: number) => void waits.push(ms);
    await endWithOneRetry(async () => { if (++calls === 1) throw denied; }, async () => ({ isActive: true, guard: 2, endTime: T + 2 * MIN + 30_000 }), () => T, sleep);
    expect(calls).toBe(2);
    expect(waits).toEqual([32_000]);
    calls = 0;
    await expect(endWithOneRetry(async () => { calls++; throw denied; }, async () => null, () => T, sleep)).rejects.toThrow(/PERMISSION_DENIED/);
    expect(calls).toBe(2);
    // Anything other than a refusal is not retried.
    calls = 0;
    await expect(endWithOneRetry(async () => { calls++; throw new Error("network"); }, async () => null, () => T, sleep)).rejects.toThrow("network");
    expect(calls).toBe(1);
  });

  it("every end write goes through the retry: session end, the record flush and reconcile", () => {
    const f = src("./useFocusSession.ts");
    expect(f.match(/endWithOneRetry\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("Bail out writes the fuse's end in server time", () => {
    expect(bailoutEndFor(T + 5 * MIN, -1500)).toBe(T + 5 * MIN - 1500);
    const b = src("../components/BailOut.tsx");
    expect(b).toContain("sessionState/bailoutEnd");
    expect(b).toContain("bailoutEndFor(res.deadline, serverOffset())");
  });
});

describe("item 2: presence for friends who added you, and friend requests", () => {
  it("adding someone writes your list first, then the request, separately", () => {
    expect(friendRequestWrite("a", "b")).toEqual({ path: "friendRequests/b/a", from: "a" });
    const f = src("./useFriends.ts");
    const own = f.indexOf("await set(ref(db, `users/${currentUserId}/friends/${uid}`), true);");
    const req = f.indexOf("sendFriendRequest(currentUserId, uid)");
    expect(own).toBeGreaterThan(-1);
    expect(req).toBeGreaterThan(own);
  });

  it("the Pack says it the way the spec does", () => {
    expect(PACK_TEXT.waiting).toBe("Waiting for them to add you back.");
    expect(PACK_TEXT.request("ALICE")).toBe("ALICE added you. Add back?");
    expect(PACK_TEXT.addBack).toBe("Add back");
    expect(PACK_TEXT.dismiss).toBe("Dismiss");
    const p = src("../screens/ThePack.tsx");
    expect(p).toContain("PACK_TEXT.waiting");
    expect(p).toContain("PACK_TEXT.request(");
    expect(p).toMatch(/friendRequests\/\$\{userId\}/);
    // A refused presence read is "waiting", not "offline".
    expect(p).toMatch(/waiting\[fId\] = true/);
  });

  it("the invite link carries no uid", () => {
    expect(inviteText("alice")).not.toMatch(/uid/);
    expect(inviteText("alice")).toContain("alice");
    expect(inviteText(null)).not.toMatch(/uid=/);
    expect(src("../screens/ThePack.tsx")).not.toContain("?uid=");
  });
});

describe("item 3 (M6): nothing of the account is left on this PC after sign-out or delete", () => {
  it("a snapshot is written only for the account signed in now", () => {
    expect(mayWriteSnapshot("u1", "u1")).toBe(true);
    expect(mayWriteSnapshot("u1", null)).toBe(false); // signed out: the unmount write is dropped
    expect(mayWriteSnapshot("u1", "u2")).toBe(false);
  });

  it("sign-out and delete clear the snapshot and the account's cached settings", () => {
    expect(ACCOUNT_LOCAL_KEYS).toContain("parrot.settings");
    const a = src("./useAuth.ts");
    expect(a).toContain("setSnapshotOwner(u?.uid ?? null)");
    expect(a).toMatch(/const logout = async \(\) => \{\n\s+try \{\n\s+await forgetAccountLocally\(\);/);
    const d = src("../components/DeleteAccountButton.tsx");
    expect(d).toContain("await forgetAccountLocally(userId)");
    expect(d.indexOf("await forgetAccountLocally(userId)")).toBeLessThan(d.indexOf("await removeAuthUser()"));
  });
});

describe("item 4 (L3): what friends see is always a handle", () => {
  it("writes the name if it is one, else the handle, else nothing", () => {
    expect(publicNameToWrite("ALICE_1", "alice_1")).toBe("ALICE_1");
    expect(publicNameToWrite("Operator Prime", "op")).toBe("OP");
    expect(publicNameToWrite("Operator Prime", null)).toBeNull();
    expect(publicNameToWrite("x".repeat(21), undefined)).toBeNull();
  });

  it("a refused name sync is quiet: no toast on every launch", () => {
    const app = src("../App.tsx");
    expect(app).toContain("publicNameToWrite(profile.userName, profile.handle)");
    expect(app).not.toContain("Couldn't update the name your friends see");
  });

  it("an unverified refusal says to verify", () => {
    expect(VERIFY_FIRST).toBe("Verify your email to add friends or change your handle.");
    expect(src("./useFriends.ts")).toContain("VERIFY_FIRST");
  });
});

describe("item 5 (L4): Delete account", () => {
  it("is refused during a live guarded session, with the text", () => {
    expect(DELETE_DURING_SESSION).toBe("Finish or bail out of your session before deleting your account.");
    expect(src("../components/DeleteAccountButton.tsx")).toContain("DELETE_DURING_SESSION");
  });

  it("takes you out of friends' lists and both kinds of request", () => {
    expect(deleteCleanupUpdates("me", ["f1", "f2"])).toEqual({
      "users/f1/friends/me": null, "users/f2/friends/me": null,
      "friendRequests/f1/me": null, "friendRequests/f2/me": null,
      "friendRequests/me": null,
    });
  });

  it("cancels presence's onDisconnect, then cleans up, then deletes", () => {
    const d = src("../components/DeleteAccountButton.tsx");
    const cancel = d.indexOf(".cancel()");
    const cleanup = d.indexOf("deleteCleanupUpdates(");
    const del = d.indexOf("[`users/${userId}`]: null");
    expect(cancel).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(cancel);
    expect(del).toBeGreaterThan(cleanup);
  });
});
