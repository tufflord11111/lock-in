import { ref, type Database } from "firebase/database";

/** The two fields of the SDK's RepoInfo this touches. Not public API. */
type RepoInfoLike = { host: string; internalHost: string };

/**
 * Keep the Realtime Database SDK on the database's own host (1.3.1 M10).
 *
 * The server's handshake names a shard host (s-gke-….asia-southeast1.
 * firebasedatabase.app) and the SDK moves every later websocket and
 * long-polling connection there, caching it in localStorage. The desktop CSP
 * allows only the database's own host, so a reconnect to the shard would be
 * refused: the SDK then marks websockets as failed and stays on long-polling
 * against a host it can't reach. The database's own host serves every
 * connection, so the shard is never needed.
 *
 * Reaches the SDK's RepoInfo through ref(db)._repo (not public API). If a
 * future SDK changes that shape this returns false and changes nothing; the
 * CSP then still holds, and pinDatabaseHost.test.ts fails on the upgrade.
 * Starts the database's connection (ref() does) — call it once, at startup.
 */
export function pinDatabaseHost(db: Database): boolean {
  const info = (ref(db) as unknown as { _repo?: { repoInfo_?: RepoInfoLike } })._repo?.repoInfo_;
  if (!info || typeof info.host !== "string" || typeof info.internalHost !== "string") return false;
  const own = info.host;
  try {
    localStorage.removeItem(`firebase:host:${own}`);
  } catch {
    /* no localStorage: nothing was cached */
  }
  info.internalHost = own;
  Object.defineProperty(info, "host", {
    configurable: true,
    get: () => own,
    set: () => {
      /* the handshake's shard host, or a reset: stay on our own host */
    },
  });
  return true;
}
