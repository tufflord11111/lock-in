import { useState, useEffect, useMemo, useRef } from "react";
import { Sticker } from "../theme/stickers";
import { db } from "@lock-in/firebase";
import { ref, onValue, get, child } from "firebase/database";
import { useFriends, FriendAddError } from "../hooks/useFriends";
import { useCopy } from "../theme/copy";
import { reportWriteFailure } from "../writeFailures";
import { PACK_TEXT, inviteText } from "../hooks/b2";

interface FriendStatus {
  id: string;
  name: string;
  /** "waiting": you added them, they have not added you, so their status is theirs to share (B2). */
  status: "online" | "offline" | "locked-in" | "waiting";
  lastChanged: number;
}

interface LeaderboardEntry {
  rank: number;
  name: string;
  hours: number;
}

interface ThePackProps {
  userId: string;
}

export function ThePack({ userId }: ThePackProps) {
  const [friends, setFriends] = useState<FriendStatus[]>([]);
  const [copied, setCopied] = useState(false);
  const [inviteUsername, setInviteUsername] = useState("");
  const inviteInputRef = useRef<HTMLInputElement | null>(null);
  const [visibleFriends, setVisibleFriends] = useState(10);
  const [visibleLeaderboard, setVisibleLeaderboard] = useState(10);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardFailed, setLeaderboardFailed] = useState(false);
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addSuccess, setAddSuccess] = useState(false);

  const { addFriend, addBack, dismissRequest } = useFriends(userId);
  const t = useCopy();
  // People who added you and wait for you to add back: { uid, name }.
  const [requests, setRequests] = useState<{ id: string; name: string }[]>([]);
  const [friendIds, setFriendIds] = useState<Set<string>>(new Set());
  const [myHandle, setMyHandle] = useState<string | null>(null);

  useEffect(() => {
    get(ref(db, `users/${userId}/config/username`))
      .then((s) => setMyHandle(typeof s.val() === "string" ? s.val() : null))
      .catch(() => setMyHandle(null));
  }, [userId]);

  // Friend requests to you (1.3.1 B2). The rules before 1.3.1 refuse this
  // read: then there are simply none to show.
  useEffect(() => {
    const names: Record<string, string | undefined> = {};
    const offNames = new Map<string, () => void>();
    let ids: string[] = [];
    const publish = () => setRequests(ids.map((id) => ({ id, name: names[id] || id })));
    const off = onValue(
      ref(db, `friendRequests/${userId}`),
      (snap) => {
        ids = Object.keys((snap.val() ?? {}) as Record<string, unknown>);
        for (const [id, offName] of offNames) {
          if (!ids.includes(id)) {
            offName();
            offNames.delete(id);
          }
        }
        for (const id of ids) {
          if (offNames.has(id)) continue;
          offNames.set(
            id,
            onValue(
              ref(db, `users/${id}/public`),
              (p) => {
                names[id] = p.val()?.userName;
                publish();
              },
              () => {}
            )
          );
        }
        publish();
      },
      () => setRequests([])
    );
    return () => {
      off();
      for (const offName of offNames.values()) offName();
    };
  }, [userId]);

  useEffect(() => {
    const friendsRef = ref(db, `users/${userId}/friends`);

    // One presence listener and one public-name listener per friend, kept in a
    // map and torn down when that friend leaves the list or the screen
    // unmounts. They used to be nested — a new public listener created on
    // every presence change — and never unsubscribed, so listeners piled up
    // for as long as the app ran.
    const perFriend = new Map<string, () => void>();
    const presence: Record<string, { state?: string; lastChanged?: number } | null> = {};
    const names: Record<string, string | undefined> = {};
    // Presence refused: they haven't added you back (B2).
    const waiting: Record<string, boolean> = {};

    const publish = () =>
      setFriends(
        Array.from(perFriend.keys()).map((fId) => ({
          id: fId,
          name: names[fId] || fId,
          status: waiting[fId] ? "waiting" : ((presence[fId]?.state as FriendStatus["status"]) || "offline"),
          lastChanged: presence[fId]?.lastChanged || 0,
        }))
      );

    const unsubscribe = onValue(friendsRef, (snapshot) => {
      // Canonical shape (useFriends): friends/{uid} = true — the uid is the
      // KEY. Tolerates a legacy {pushKey: "uid"} entry: a string value is a uid.
      const friendIdsObj = (snapshot.val() || {}) as Record<string, unknown>;
      const friendIds = new Set(
        Object.entries(friendIdsObj)
          .map(([key, value]) => (typeof value === "string" ? value : key))
          .filter((id) => typeof id === "string" && id.length > 0)
      );
      setFriendIds(new Set(friendIds));

      for (const [fId, off] of perFriend) {
        if (!friendIds.has(fId)) {
          off();
          perFriend.delete(fId);
          delete presence[fId];
          delete names[fId];
          delete waiting[fId];
        }
      }

      for (const fId of friendIds) {
        if (perFriend.has(fId)) continue;
        // public/userName is the ONLY field of another user's readable by a
        // friend. config is owner-only — it carries their email.
        const offPresence = onValue(
          ref(db, `users/${fId}/presence`),
          (pSnap) => {
            waiting[fId] = false;
            presence[fId] = pSnap.val();
            publish();
          },
          () => {
            // Refused: only people they've added see their status.
            waiting[fId] = true;
            publish();
          }
        );
        const offName = onValue(ref(db, `users/${fId}/public`), (pubSnap) => {
          names[fId] = pubSnap.val()?.userName;
          publish();
        });
        perFriend.set(fId, () => {
          offPresence();
          offName();
        });
      }

      publish();
    });

    return () => {
      unsubscribe();
      for (const off of perFriend.values()) off();
      perFriend.clear();
    };
  }, [userId]);

  const fetchLeaderboard = async () => {
    setIsLoadingLeaderboard(true);
    setLeaderboardFailed(false);
    try {
      const snapshot = await get(child(ref(db), 'leaderboard/all_time'));
      if (snapshot.exists()) {
        const data = snapshot.val();
        
        // Convert to array of raw data objects
        // ghost_operator_* are seeded demo rows, not people.
        const rawData = Object.entries(data)
          .filter(([key]) => !key.startsWith('ghost_operator_'))
          .map(([key, value]) => {
            if (typeof value === 'number') return { username: key, uptimeToday: value * 60 };
            return value as any;
          });

        const formattedData = rawData.map(user => {
          // 1. Safely extract and cast to Numbers, defaulting to 0 if missing/corrupted
          const safeMinutes = Number(user.uptimeToday) || 0;
          const safeStreak = Number(user.currentStreak) || 0;
          
          // 2. Perform math safely
          const hours = safeMinutes / 60;
          
          return {
            ...user,
            uptimeToday: safeMinutes,
            currentStreak: safeStreak,
            displayUptime: hours.toFixed(1) // Now guaranteed to be a Number
          };
        });

        const sorted = formattedData
          .sort((a, b) => b.uptimeToday - a.uptimeToday)
          .map((user, index) => ({
            rank: index + 1,
            name: user.username || (t("pack.unknown") ?? ""),
            hours: Number(user.displayUptime)
          }));
          
        setLeaderboard(sorted);
      } else {
        setLeaderboard([]);
      }
    } catch (err) {
      console.error("Leaderboard fetch failed:", err);
      setLeaderboardFailed(true);
    } finally {
      setIsLoadingLeaderboard(false);
    }
  };

  useEffect(() => {
    fetchLeaderboard();
  }, []);

  const handleAddFriend = async () => {
    if (!inviteUsername.trim() || isAdding) return;
    setIsAdding(true);
    try {
      await addFriend(inviteUsername);
      setAddSuccess(true);
      setInviteUsername("");
      // Adding one friend is usually adding three, and the input is disabled
      // while the write is in flight, which drops focus. Put it back.
      inviteInputRef.current?.focus();
      setTimeout(() => setAddSuccess(false), 2000);
    } catch (err) {
      if (err instanceof FriendAddError) {
        // "Already in your Pack" is a no-op, not a failure.
        reportWriteFailure(err.message, undefined, err.code === "already" ? "info" : "error");
      } else {
        const code = (err as { code?: string; message?: string })?.code;
        reportWriteFailure(
          `Couldn't add that operator${code ? ` (${code})` : ""}. Check your connection and try again.`,
          err
        );
      }
    } finally {
      setIsAdding(false);
    }
  };

  const handleCopy = () => {
    // A handle to add, never a uid (B2).
    navigator.clipboard.writeText(inviteText(myHandle));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShowMoreFriends = () => setVisibleFriends(prev => prev + 10);
  const handleShowMoreLeaderboard = () => setVisibleLeaderboard(prev => prev + 10);

  // Group and sort friends
  const activeFriends = useMemo(() => 
    friends.filter(f => f.status === "locked-in").sort((a, b) => b.lastChanged - a.lastChanged),
    [friends]
  );
  
  const onlineFriends = useMemo(() => 
    friends.filter(f => f.status === "online").sort((a, b) => b.lastChanged - a.lastChanged),
    [friends]
  );

  const offlineFriends = useMemo(() => 
    friends.filter(f => f.status === "offline").sort((a, b) => b.lastChanged - a.lastChanged),
    [friends]
  );
  
  const waitingFriends = useMemo(() => friends.filter((f) => f.status === "waiting"), [friends]);

  const sortedFriends = useMemo(() => [...activeFriends, ...onlineFriends, ...offlineFriends], [activeFriends, onlineFriends, offlineFriends]);

  // A request from someone already in your Pack has nothing left to ask.
  const openRequests = useMemo(() => requests.filter((r) => !friendIds.has(r.id)), [requests, friendIds]);
  useEffect(() => {
    for (const r of requests) if (friendIds.has(r.id)) void dismissRequest(r.id).catch(() => {});
  }, [requests, friendIds]);

  const handleRequest = async (id: string, accept: boolean) => {
    try {
      if (accept) await addBack(id);
      else await dismissRequest(id);
    } catch (err) {
      if (err instanceof FriendAddError) reportWriteFailure(err.message, undefined, "error");
      else reportWriteFailure("Couldn't answer that request. Check your connection and try again.", err);
    }
  };

  return (
    <div className="h-full overflow-y-auto pt-8 -mt-8 pb-40 animate-in fade-in slide-in-from-bottom-4 duration-700">
      
      {/* TOP RECRUITMENT BAR */}
      <div className="flex flex-row justify-between items-center gap-6 p-4 border-b-1 border-ink mb-8">
        <div className="relative isolate flex items-center gap-4">
            <Sticker slot="pack.add" />
          <h2 className="text-lg font-bold text-ink">{t("pack.add")}</h2>
          <div className="flex gap-2">
            <input
              ref={inviteInputRef}
              type="text"
              value={inviteUsername}
              onChange={(e) => setInviteUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddFriend()}
              placeholder={t("pack.placeholder") ?? ""}
              disabled={isAdding}
              className={`w-48 bg-surface border-1 border-ink rounded-lg px-4 py-2 text-sm font-bold text-ink placeholder-ink/40 outline-none focus:translate-y-[2px] transition-all shadow-[shadow:var(--shadow-1)] focus:shadow-none ${isAdding ? 'opacity-50' : ''}`}
            />
            <button 
              onClick={handleAddFriend}
              disabled={isAdding || !inviteUsername.trim()}
              className={`${addSuccess ? 'bg-success-500 text-surface-inverse' : 'bg-ink text-surface-inverse'} border-1 border-ink w-10 h-10 rounded-lg font-black text-xl flex items-center justify-center shadow-[shadow:var(--shadow-1)] active:translate-y-[2px] active:shadow-none transition-all disabled:opacity-50`}
            >
              {isAdding ? "..." : (addSuccess ? "✓" : "+")}
            </button>
          </div>
        </div>
        
        <div className="relative flex flex-col items-center">
          <button
            onClick={handleCopy}
            className="bg-highlight text-ink border-1 border-ink rounded-lg py-2 px-6 font-black label-action-plain text-sm shadow-[shadow:var(--shadow-2)] active:translate-y-[4px] active:shadow-none hover:translate-y-[2px] hover:shadow-[shadow:var(--shadow-1)] transition-all whitespace-nowrap"
          >
            Copy Invite Link
          </button>
          {copied && (
            <div className="absolute top-full mt-2 bg-highlight-2 text-ink-2 px-3 py-1 rounded border-1 border-ink-2 font-mono label-plain text-[10px] font-bold whitespace-nowrap z-10 animate-in fade-in slide-in-from-top-1">
              INVITE LINK COPIED
            </div>
          )}
        </div>
      </div>

      {/* TWO COLUMN GRID */}
      <div className="flex gap-12 px-8">
        
        {/* LEFT COLUMN: LIVE STATUS */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Friend requests: they added you (B2). */}
          {openRequests.length > 0 && (
            <div className="flex flex-col gap-3 mb-8" aria-label="Friend requests">
              {openRequests.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-3 py-3 px-4 rounded-lg bg-highlight border-1 border-ink shadow-[shadow:var(--shadow-1)]"
                >
                  <span className="text-sm font-bold text-ink">{PACK_TEXT.request(r.name)}</span>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => void handleRequest(r.id, true)}
                      className="bg-ink text-surface-inverse border-1 border-ink px-3 py-1.5 rounded-md font-bold text-xs active:translate-y-[2px] transition-all"
                    >
                      {PACK_TEXT.addBack}
                    </button>
                    <button
                      onClick={() => void handleRequest(r.id, false)}
                      className="bg-surface text-ink border-1 border-ink px-3 py-1.5 rounded-md font-bold text-xs active:translate-y-[2px] transition-all"
                    >
                      {PACK_TEXT.dismiss}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Active Operators */}
          <div className="relative isolate mb-4">
            <Sticker slot="pack.online" />
            <h2 className="text-xl font-bold text-ink">{t("pack.online")}</h2>
          </div>
          <div className="flex flex-col gap-3 mb-8">
            {activeFriends.map((friend) => (
              <div 
                key={friend.id}
                className="flex items-center justify-between py-3 px-4 rounded-lg bg-surface border-1 border-ink shadow-[shadow:var(--shadow-1)]"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-alert-bright rounded-full animate-pulse border border-ink shadow-[0_0_8px_rgb(var(--alert-bright-rgb)/0.5)]"></div>
                  <span className="text-base font-bold text-ink capitalize tracking-tight">
                    {friend.name}
                  </span>
                </div>
                
                <div className="bg-highlight text-ink border-1 border-ink px-3 py-1.5 rounded-full font-bold text-[10px] label-sm">
                  Locked In
                </div>
              </div>
            ))}

            {onlineFriends.map((friend) => (
              <div 
                key={friend.id}
                className="flex items-center justify-between py-3 px-4 rounded-lg bg-surface border-1 border-ink shadow-[shadow:var(--shadow-1)]"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-online rounded-full border border-ink shadow-[0_0_8px_rgb(var(--online-rgb)/0.5)]"></div>
                  <span className="text-base font-bold text-ink capitalize tracking-tight">
                    {friend.name}
                  </span>
                </div>
                
                <div className="text-ink/40 font-bold text-[10px] label-sm">
                  Online
                </div>
              </div>
            ))}
          </div>

          {/* Offline Operators */}
          <div className="relative isolate mb-4">
            <Sticker slot="pack.offline" />
            <h2 className="text-xl font-bold text-ink">{t("pack.offline")}</h2>
          </div>
          <div className="flex flex-col gap-3">
            {offlineFriends.slice(0, Math.max(0, visibleFriends - activeFriends.length - onlineFriends.length)).map((friend) => (
              <div 
                key={friend.id}
                className="flex items-center justify-between py-3 px-4 rounded-lg bg-surface border-1 border-ink/30 shadow-none border-dashed opacity-50"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-offline rounded-full border border-ink/20"></div>
                  <span className="text-base font-bold text-ink/50 capitalize tracking-tight">
                    {friend.name}
                  </span>
                </div>
                
                <div className="text-ink/40 font-bold text-[10px] label-sm">
                  Offline
                </div>
              </div>
            ))}
            
            {/* You added them; they haven't added you. No status. */}
            {waitingFriends.map((friend) => (
              <div
                key={friend.id}
                className="flex items-center justify-between py-3 px-4 rounded-lg bg-surface border-1 border-ink/30 shadow-none border-dashed opacity-70"
              >
                <span className="text-base font-bold text-ink/60 capitalize tracking-tight">{friend.name}</span>
                <div className="text-ink/50 font-bold text-[10px]">{PACK_TEXT.waiting}</div>
              </div>
            ))}

            {visibleFriends < sortedFriends.length && (
              <button 
                onClick={handleShowMoreFriends}
                className="w-full bg-surface border-1 border-ink text-ink font-bold py-3 mt-2 rounded-lg hover:bg-ground transition-all"
              >
                SHOW MORE ↓
              </button>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: THE ARENA */}
        <div className="flex-1 flex flex-col min-w-0 border-l-1 border-ink/10 pl-12">
          <div className="relative isolate mb-6 flex items-center justify-between">
            <Sticker slot="pack.leaderboard" />
            <h2 className="text-xl font-bold text-ink">{t("pack.leaderboard")}</h2>
            <button 
              onClick={fetchLeaderboard}
              disabled={isLoadingLeaderboard}
              className="bg-surface border-1 border-ink text-ink px-3 py-1 rounded-md font-black text-[10px] label-action-sm shadow-[shadow:var(--shadow-1)] active:translate-y-[2px] active:shadow-none transition-all disabled:opacity-50"
            >
              {isLoadingLeaderboard ? t("pack.syncing") : t("pack.refresh")}
            </button>
          </div>
          
          <div className="flex flex-col gap-3">
            {leaderboard.length === 0 && !isLoadingLeaderboard && (
              <div className="py-20 flex flex-col items-center justify-center border-1 border-dashed border-ink/20 rounded-2xl bg-ground/50">
                {/* A failed read says nothing about who's on the board. */}
                <p className="text-sm font-bold text-ink/60 text-center">
                  {leaderboardFailed
                    ? "Couldn't load the board. Try refreshing."
                    : "You're the first in The Pack. Invite a friend"}
                </p>
              </div>
            )}

            {leaderboard.slice(0, visibleLeaderboard).map((user) => (
              <div 
                key={user.rank}
                className={`flex items-center justify-between py-3 px-4 rounded-lg ${
                  user.rank === 1 
                    ? "bg-highlight border-1 border-ink shadow-[shadow:var(--shadow-1)]" 
                    : "bg-surface border-1 border-ink shadow-[shadow:var(--shadow-1)]"
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className="w-6 text-left">
                    <span className={`text-xl ${user.rank === 1 ? "font-black text-ink" : "font-bold text-ink"}`}>
                      {user.rank}.
                    </span>
                  </div>
                  <span className={`text-base capitalize tracking-tight ${user.rank === 1 ? "font-black text-ink" : "font-bold text-ink"}`}>
                    {user.name}
                  </span>
                </div>
                
                <div className="flex flex-col items-end">
                  <span className={`text-xl leading-none ${user.rank === 1 ? "font-black text-ink" : "font-bold text-ink"}`}>
                    {user.hours} <span className="text-xs opacity-60 ml-0.5 font-bold">{t("pack.hours")}</span>
                  </span>
                </div>
              </div>
            ))}
            
            {visibleLeaderboard < leaderboard.length && (
              <button 
                onClick={handleShowMoreLeaderboard}
                className="w-full bg-surface border-1 border-ink text-ink font-bold py-3 mt-2 rounded-lg hover:bg-ground transition-all"
              >
                SHOW MORE ↓
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
