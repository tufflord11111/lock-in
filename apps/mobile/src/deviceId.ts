/**
 * Stable per-install identity, persisted in localStorage.
 *
 * Copy of apps/web/src/deviceId.ts — same key, same logic — kept local so the
 * mobile build never reaches into the desktop workspace. On a phone this is a
 * different browser origin, so the id is naturally distinct from any desktop's.
 * That is the whole point: the desktop's cross-device mirror compares
 * sessionState.originDeviceId against ITS id and treats a mismatch as REMOTE,
 * which is what makes it arm via update_enforcement(fromRemote: true).
 */
const DEVICE_ID_KEY = "lockin_device_id";

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
