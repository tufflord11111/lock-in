/**
 * Stable per-install identity, persisted in localStorage.
 *
 * Shared by useOmniSync (device heartbeat / minutes) and useFocusSession
 * (sessionState origin tagging) so both agree on which writes are "ours".
 * Logic is unchanged from the original inline useMemo in useOmniSync — it
 * was extracted so the two hooks can never drift onto different ids.
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
