// Newer Supabase realtime.send adds its own UUID id to otherwise empty hints.
// Accept that transport metadata, never application data, as our probe receipt.
export function isEmptyProbePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'id'
    && typeof payload.id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(payload.id));
}
