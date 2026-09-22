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

    const unsubscribe = onValue(friendsRef, (snapshot) => {
      // ... (existing friends logic)
      // Canonical shape (useFriends): friends/{uid} = true — the uid is the
      // KEY. Object.values() here yielded [true] and a lookup at
      // users/true/presence. Tolerates a legacy {pushKey: "uid"} entry, since
      // live data can't be inspected from the repo: a string value is a uid.
      const friendIdsObj = (snapshot.val() || {}) as Record<string, unknown>;
      const friendIds = Object.entries(friendIdsObj)
        .map(([key, value]) => (typeof value === "string" ? value : key))
        .filter((id) => typeof id === "string" && id.length > 0);

      if (friendIds.length === 0) {
        setFriends([]);
        return;
      }

      friendIds.forEach((fId) => {
        const presenceRef = ref(db, `users/${fId}/presence`);
        // public/userName is the ONLY field of another user's readable by a
        // friend. config is owner-only — it carries their email.
        const publicRef = ref(db, `users/${fId}/public`);

        onValue(presenceRef, (pSnap) => {
          const presence = pSnap.val();
          onValue(publicRef, (pubSnap) => {
            const pub = pubSnap.val();
            const name = pub?.userName || fId;
            const status = (presence?.state as any) || "offline";
            const lastChanged = presence?.lastChanged || 0;

            setFriends((prev) => {
              const existing = prev.filter((f) => f.id !== fId);
              return [...existing, { id: fId, name, status, lastChanged }];
            });
          });
        });
      });
    });

    return () => unsubscribe();
  }, []);

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
      <div className="flex flex-row justify-between items-center gap-6 p-4 border-b-2 border-[#002855] mb-8">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-bold text-[#002855]">Add Operator</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={inviteUsername}
              onChange={(e) => setInviteUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddFriend()}
              placeholder="Handle..."
              disabled={isAdding}
              className={`w-48 bg-white border-2 border-[#002855] rounded-xl px-4 py-2 text-sm font-bold text-[#002855] placeholder-[#002855]/40 outline-none focus:translate-y-[2px] transition-all shadow-[2px_2px_0px_#002855] focus:shadow-none ${isAdding ? 'opacity-50' : ''}`}
            />
            <button 
              onClick={handleAddFriend}
              disabled={isAdding || !inviteUsername.trim()}
              className={`${addSuccess ? 'bg-green-500 text-white' : 'bg-[#002855] text-white'} border-2 border-[#002855] w-10 h-10 rounded-xl font-black text-xl flex items-center justify-center shadow-[2px_2px_0px_#002855] active:translate-y-[2px] active:shadow-none transition-all disabled:opacity-50`}
            >
              {isAdding ? "..." : (addSuccess ? "✓" : "+")}
            </button>
          </div>
        </div>
        
        <div className="relative flex flex-col items-center">
          <button
            onClick={handleCopy}
            className="bg-[#FFD166] text-[#002855] border-2 border-[#002855] rounded-xl py-2 px-6 font-black uppercase text-sm shadow-[4px_4px_0px_#002855] active:translate-y-[4px] active:shadow-none hover:translate-y-[2px] hover:shadow-[2px_2px_0px_#002855] transition-all whitespace-nowrap"
          >
            Copy Invite Link
          </button>
          {copied && (
            <div className="absolute top-full mt-2 bg-[#F5C842] text-[#1B2A4A] px-3 py-1 rounded border-2 border-[#1B2A4A] font-mono uppercase text-[10px] font-bold whitespace-nowrap z-10 animate-in fade-in slide-in-from-top-1">
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
            <h2 className="text-xl font-bold text-[#002855]">Active Operators // Live Status</h2>
          </div>
          <div className="flex flex-col gap-3 mb-8">
            {activeFriends.map((friend) => (
              <div 
                key={friend.id}
                className="flex items-center justify-between py-3 px-4 rounded-xl bg-white border-2 border-[#002855] shadow-[2px_2px_0px_#002855]"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-[#FF4F4F] rounded-full animate-pulse border border-[#002855] shadow-[0_0_8px_rgba(255,79,79,0.5)]"></div>
                  <span className="text-base font-bold text-[#002855] capitalize tracking-tight">
                    {friend.name}
                  </span>
                </div>
                
                <div className="bg-[#FFD166] text-[#002855] border-2 border-[#002855] px-3 py-1.5 rounded-full font-bold text-[10px] tracking-widest uppercase">
                  Locked In
                </div>
              </div>
            ))}

            {onlineFriends.map((friend) => (
              <div 
                key={friend.id}
                className="flex items-center justify-between py-3 px-4 rounded-xl bg-white border-2 border-[#002855] shadow-[2px_2px_0px_#002855]"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-[#4ADE80] rounded-full border border-[#002855] shadow-[0_0_8px_rgba(74,222,128,0.5)]"></div>
                  <span className="text-base font-bold text-[#002855] capitalize tracking-tight">
                    {friend.name}
                  </span>
                </div>
                
                <div className="text-[#002855]/40 font-bold text-[10px] tracking-widest uppercase">
                  Online
                </div>
              </div>
            ))}
          </div>

          {/* Offline Operators */}
          <div className="mb-4">
            <h2 className="text-xl font-bold text-[#002855]">Offline Operators</h2>
          </div>
          <div className="flex flex-col gap-3">
            {offlineFriends.slice(0, Math.max(0, visibleFriends - activeFriends.length - onlineFriends.length)).map((friend) => (
              <div 
                key={friend.id}
                className="flex items-center justify-between py-3 px-4 rounded-xl bg-white border-2 border-[#002855]/30 shadow-none border-dashed opacity-50"
              >
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 bg-gray-300 rounded-full border border-[#002855]/20"></div>
                  <span className="text-base font-bold text-[#002855]/50 capitalize tracking-tight">
                    {friend.name}
                  </span>
                </div>
                
                <div className="text-[#002855]/40 font-bold text-[10px] tracking-widest uppercase">
                  Offline
                </div>
              </div>
            ))}
            
            {visibleFriends < sortedFriends.length && (
              <button 
                onClick={handleShowMoreFriends}
                className="w-full bg-white border-2 border-[#002855] text-[#002855] font-bold py-3 mt-2 rounded-xl hover:bg-[#F9F8F4] transition-all"
              >
                SHOW MORE ↓
              </button>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: THE ARENA */}
        <div className="flex-1 flex flex-col min-w-0 border-l-2 border-[#002855]/10 pl-12">
          <div className="mb-6 flex items-center justify-between">
            <h2 className="text-xl font-bold text-[#002855]">The Weekly Arena // Leaderboard</h2>
            <button 
              onClick={fetchLeaderboard}
              disabled={isLoadingLeaderboard}
              className="bg-white border-2 border-[#002855] text-[#002855] px-3 py-1 rounded-lg font-black text-[10px] tracking-widest uppercase shadow-[2px_2px_0px_#002855] active:translate-y-[2px] active:shadow-none transition-all disabled:opacity-50"
            >
              {isLoadingLeaderboard ? "SYNCING..." : "Refresh Ranks"}
            </button>
          </div>
          
          <div className="flex flex-col gap-3">
            {leaderboard.length === 0 && !isLoadingLeaderboard && (
              <div className="py-20 flex flex-col items-center justify-center border-2 border-dashed border-[#002855]/20 rounded-3xl bg-[#F9F8F4]/50">
                <span className="text-[10px] font-black text-[#002855]/30 tracking-[0.3em] uppercase mb-2">No Records Found</span>
                <p className="text-sm font-bold text-[#002855]/40 italic">"THE BOARD IS CLEAR. BE THE FIRST."</p>
              </div>
            )}

            {leaderboard.slice(0, visibleLeaderboard).map((user) => (
              <div 
                key={user.rank}
                className={`flex items-center justify-between py-3 px-4 rounded-xl ${
                  user.rank === 1 
                    ? "bg-[#FFD166] border-2 border-[#002855] shadow-[2px_2px_0px_#002855]" 
                    : "bg-white border-2 border-[#002855] shadow-[2px_2px_0px_#002855]"
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className="w-6 text-left">
                    <span className={`text-xl ${user.rank === 1 ? "font-black text-[#002855]" : "font-bold text-[#002855]"}`}>
                      {user.rank}.
                    </span>
                  </div>
                  <span className={`text-base capitalize tracking-tight ${user.rank === 1 ? "font-black text-[#002855]" : "font-bold text-[#002855]"}`}>
                    {user.name}
                  </span>
                </div>
                
                <div className="flex flex-col items-end">
                  <span className={`text-xl leading-none ${user.rank === 1 ? "font-black text-[#002855]" : "font-bold text-[#002855]"}`}>
                    {user.hours} <span className="text-xs opacity-60 ml-0.5 font-bold">HRS</span>
                  </span>
                </div>
              </div>
            ))}
            
            {visibleLeaderboard < leaderboard.length && (
              <button 
                onClick={handleShowMoreLeaderboard}
                className="w-full bg-white border-2 border-[#002855] text-[#002855] font-bold py-3 mt-2 rounded-xl hover:bg-[#F9F8F4] transition-all"
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
