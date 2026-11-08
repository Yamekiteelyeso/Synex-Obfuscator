/**
 * Removes expired entries and makes room before inserting into a short-lived map.
 * Entries are evicted in insertion order once the configured ceiling is reached.
 */
export function pruneBoundedMap<K, V>(
  map: Map<K, V>,
  now: number,
  maxEntries: number,
  expiresAt: (value: V) => number,
  reserveSlots = 0,
): void {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1
    || !Number.isSafeInteger(reserveSlots) || reserveSlots < 0 || reserveSlots >= maxEntries) {
    throw new RangeError('invalid bounded map capacity');
  }

  for (const [key, value] of map) {
    if (expiresAt(value) <= now) map.delete(key);
  }

  const targetSize = maxEntries - reserveSlots;
  while (map.size > targetSize) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
