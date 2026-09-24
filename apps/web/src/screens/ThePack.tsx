import { useState, useEffect, useMemo } from "react";
import { db } from "@lock-in/firebase";
import { ref, onValue, get, child } from "firebase/database";
import { useFriends, FriendAddError } from "../hooks/useFriends";
import { reportWriteFailure } from "../writeFailures";

interface FriendStatus {
  id: string;
  name: string;
  status: "online" | "offline" | "locked-in";
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
  const [visibleFriends, setVisibleFriends] = useState(10);
  const [visibleLeaderboard, setVisibleLeaderboard] = useState(10);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isLoadingLeaderboard, setIsLoadingLeaderboard] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addSuccess, setAddSuccess] = useState(false);

  const { addFriend } = useFriends(userId);

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

    const publish = () =>
      setFriends(
        Array.from(perFriend.keys()).map((fId) => ({
          id: fId,
          name: names[fId] || fId,
          status: ((presence[fId]?.state as FriendStatus["status"]) || "offline"),
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

      for (const [fId, off] of perFriend) {
        if (!friendIds.has(fId)) {
          off();
          perFriend.delete(fId);
          delete presence[fId];
          delete names[fId];
        }
      }

      for (const fId of friendIds) {
        if (perFriend.has(fId)) continue;
        // public/userName is the ONLY field of another user's readable by a
        // friend. config is owner-only — it carries their email.
        const offPresence = onValue(ref(db, `users/${fId}/presence`), (pSnap) => {
          presence[fId] = pSnap.val();
          publish();
        });
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
    try {
      const snapshot = await get(child(ref(db), 'leaderboard/all_time'));
      if (snapshot.exists()) {
        const data = snapshot.val();
        
        // Convert to array of raw data objects
        const rawData = Object.entries(data).map(([key, value]) => {
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
            name: user.username || "Unknown Operator",
            hours: Number(user.displayUptime)
          }));
          
        setLeaderboard(sorted);
      } else {
        setLeaderboard([]);
      }
    } catch (err) {
      console.error("Leaderboard fetch failed:", err);
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
    const inviteText = ` Join me on Lock-In — the hardcore focus vault for Windows.\n\nClick to download and add me: https://lockinme.com?uid=${userId}`;
    navigator.clipboard.writeText(inviteText);
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
  
  const sortedFriends = useMemo(() => [...activeFriends, ...onlineFriends, ...offlineFriends], [activeFriends, onlineFriends, offlineFriends]);

  return (
    <div className="h-full overflow-y-auto pb-40 animate-in fade-in slide-in-from-bottom-4 duration-700">
      
      {/* TOP RECRUITMENT BAR */}
      <div className="flex flex-row justify-between items-center gap-6 p-4 border-b-2 border-navy mb-8">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-bold text-navy">Add Operator</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={inviteUsername}
              onChange={(e) => setInviteUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddFriend()}
              placeholder="Handle..."
              disabled={isAdding}
              className={`w-48 bg-white border-2 border-navy rounded-xl px-4 py-2 text-sm font-bold text-navy placeholder-navy/40 outline-none focus:translate-y-[2px] transition-all shadow-[2px_2px_0px_var(--navy)] focus:shadow-none ${isAdding ? 'opacity-50' : ''}`}
            />
            <button 
              onClick={handleAddFriend}
              disabled={isAdding || !inviteUsername.trim()}
              className={`${addSuccess ? 'bg-green-500 text-white' : 'bg-navy text-white'} border-2 border-navy w-10 h-10 rounded-xl font-black text-xl flex items-center justify-center shadow-[2px_2px_0px_var(--navy)] active:translate-y-[2px] active:shadow-none transition-all disabled:opacity-50`}
            >
              {isAdding ? "..." : (addSuccess ? "✓" : "+")}
            </button>
          </div>
        </div>
        
        <div className="relative flex flex-col items-center">
          <button
            onClick={handleCopy}
            className="bg-gold text-navy border-2 border-navy rounded-xl py-2 px-6 font-black uppercase text-sm shadow-[4px_4px_0px_var(--navy)] active:translate-y-[4px] active:shadow-none hover:translate-y-[2px] hover:shadow-[2px_2px_0px_var(--navy)] transition-all whitespace-nowrap"
          >
            Copy Invite Link
          </button>
          {copied && (
            <div className="absolute top-full mt-2 bg-gold-2 text-navy-2 px-3 py-1 rounded border-2 border-navy-2 font-mono uppercase text-[10px] font-bold whitespace-nowrap z-10 animate-in fade-in slide-in-from-top-1">
              INVITE LINK COPIED
            </div>
          )}
        </div>
      </div>

      {/* TWO COLUMN GRID */}
      <div className="flex gap-12 px-8">
        
        {/* LEFT COLUMN: LIVE STATUS */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Active Operators */}
          <div className="mb-4">
            <h2 className="text-xl font-bold text-navy">Active Operators // Live Status</h2>
          </div>
          <div className="flex flex-col gap-3 mb-8">
            {activeFriends.map((friend) => (
              <div 
                key={friend.id}
                className="flex items-center justify-between py-3 px-4 rounded-xl bg-white border-2 border-navy shadow-[2px_2px_0px_var(--navy)]"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-alert-bright rounded-full animate-pulse border border-navy shadow-[0_0_8px_rgb(var(--alert-bright-rgb)/0.5)]"></div>
                  <span className="text-base font-bold text-navy capitalize tracking-tight">
                    {friend.name}
                  </span>
                </div>
                
                <div className="bg-gold text-navy border-2 border-navy px-3 py-1.5 rounded-full font-bold text-[10px] tracking-widest uppercase">
                  Locked In
                </div>
              </div>
            ))}

            {onlineFriends.map((friend) => (
              <div 
                key={friend.id}
                className="flex items-center justify-between py-3 px-4 rounded-xl bg-white border-2 border-navy shadow-[2px_2px_0px_var(--navy)]"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-online rounded-full border border-navy shadow-[0_0_8px_rgb(var(--online-rgb)/0.5)]"></div>
                  <span className="text-base font-bold text-navy capitalize tracking-tight">
                    {friend.name}
                  </span>
                </div>
                
                <div className="text-navy/40 font-bold text-[10px] tracking-widest uppercase">
                  Online
                </div>
              </div>
            ))}
          </div>

          {/* Offline Operators */}
          <div className="mb-4">
            <h2 className="text-xl font-bold text-navy">Offline Operators</h2>
          </div>
          <div className="flex flex-col gap-3">
            {offlineFriends.slice(0, Math.max(0, visibleFriends - activeFriends.length - onlineFriends.length)).map((friend) => (
              <div 
                key={friend.id}
                className="flex items-center justify-between py-3 px-4 rounded-xl bg-white border-2 border-navy/30 shadow-none border-dashed opacity-50"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-gray-300 rounded-full border border-navy/20"></div>
                  <span className="text-base font-bold text-navy/50 capitalize tracking-tight">
                    {friend.name}
                  </span>
                </div>
                
                <div className="text-navy/40 font-bold text-[10px] tracking-widest uppercase">
                  Offline
                </div>
              </div>
            ))}
            
            {visibleFriends < sortedFriends.length && (
              <button 
                onClick={handleShowMoreFriends}
                className="w-full bg-white border-2 border-navy text-navy font-bold py-3 mt-2 rounded-xl hover:bg-paper transition-all"
              >
                SHOW MORE ↓
              </button>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: THE ARENA */}
        <div className="flex-1 flex flex-col min-w-0 border-l-2 border-navy/10 pl-12">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-xl font-bold text-navy">The Weekly Arena // Leaderboard</h2>
            <button 
              onClick={fetchLeaderboard}
              disabled={isLoadingLeaderboard}
              className="bg-white border-2 border-navy text-navy px-3 py-1 rounded-lg font-black text-[10px] tracking-widest uppercase shadow-[2px_2px_0px_var(--navy)] active:translate-y-[2px] active:shadow-none transition-all disabled:opacity-50"
            >
              {isLoadingLeaderboard ? "SYNCING..." : "Refresh Ranks"}
            </button>
          </div>
          
          <div className="flex flex-col gap-3">
            {leaderboard.length === 0 && !isLoadingLeaderboard && (
              <div className="py-20 flex flex-col items-center justify-center border-2 border-dashed border-navy/20 rounded-3xl bg-paper/50">
                <span className="text-[10px] font-black text-navy/30 tracking-[0.3em] uppercase mb-2">No Records Found</span>
                <p className="text-sm font-bold text-navy/40 italic">"THE BOARD IS CLEAR. BE THE FIRST."</p>
              </div>
            )}

            {leaderboard.slice(0, visibleLeaderboard).map((user) => (
              <div 
                key={user.rank}
                className={`flex items-center justify-between py-3 px-4 rounded-xl ${
                  user.rank === 1 
                    ? "bg-gold border-2 border-navy shadow-[2px_2px_0px_var(--navy)]" 
                    : "bg-white border-2 border-navy shadow-[2px_2px_0px_var(--navy)]"
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className="w-6 text-left">
                    <span className={`text-xl ${user.rank === 1 ? "font-black text-navy" : "font-bold text-navy"}`}>
                      {user.rank}.
                    </span>
                  </div>
                  <span className={`text-base capitalize tracking-tight ${user.rank === 1 ? "font-black text-navy" : "font-bold text-navy"}`}>
                    {user.name}
                  </span>
                </div>
                
                <div className="flex flex-col items-end">
                  <span className={`text-xl leading-none ${user.rank === 1 ? "font-black text-navy" : "font-bold text-navy"}`}>
                    {user.hours} <span className="text-xs opacity-60 ml-0.5 font-bold">HRS</span>
                  </span>
                </div>
              </div>
            ))}
            
            {visibleLeaderboard < leaderboard.length && (
              <button 
                onClick={handleShowMoreLeaderboard}
                className="w-full bg-white border-2 border-navy text-navy font-bold py-3 mt-2 rounded-xl hover:bg-paper transition-all"
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
