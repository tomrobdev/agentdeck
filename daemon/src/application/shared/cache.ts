// A cache of promises for immutable results: the least recently used is dropped past its size, and a failed one is forgotten.
export function promiseCache<T>(size: number): (key: string, make: () => Promise<T>) => Promise<T> {
  const entries = new Map<string, Promise<T>>();
  return (key, make) => {
    let hit = entries.get(key);
    if (hit) entries.delete(key);
    else
      hit = make().catch((err: unknown) => {
        entries.delete(key);
        throw err;
      });
    entries.set(key, hit);
    if (entries.size > size) {
      const [oldest] = entries.keys();
      entries.delete(oldest);
    }
    return hit;
  };
}
