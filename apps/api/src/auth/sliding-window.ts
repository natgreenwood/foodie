// Admits at most `limit` events per key in any `windowMs`. It lives in
// memory, so each api process counts on its own, and it forgets everything
// on restart. At most `maxKeys` keys are kept; past that the key used least
// recently is dropped, so the memory it takes is bounded whatever the
// callers send. NATG-237 decides whether a limiter package replaces it.
export interface SlidingWindow {
  // Counts the event and answers true, or answers false without counting it
  // when the key has had `limit` events in the window already.
  admit(key: string): boolean;
  // How many keys it holds.
  size(): number;
}

export function slidingWindow({
  limit,
  windowMs,
  maxKeys,
  clock = () => Date.now(),
}: {
  limit: number;
  windowMs: number;
  maxKeys: number;
  clock?: () => number;
}): SlidingWindow {
  // Insertion order is recency: a key is deleted and set again on each use,
  // so the first key is the one used least recently.
  const hits = new Map<string, number[]>();

  return {
    admit(key) {
      const now = clock();
      const recent = (hits.get(key) ?? []).filter((at) => at > now - windowMs);
      hits.delete(key);
      const admitted = recent.length < limit;
      if (admitted) recent.push(now);
      hits.set(key, recent);
      if (hits.size > maxKeys) {
        const [oldest] = hits.keys();
        if (oldest !== undefined) hits.delete(oldest);
      }
      return admitted;
    },
    size: () => hits.size,
  };
}
