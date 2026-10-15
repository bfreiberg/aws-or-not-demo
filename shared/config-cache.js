// Holds one frozen snapshot; concurrent requests share it read-only.
export function createConfigCache(load, { ttlMs = 30_000, now = Date.now } = {}) {
  let snapshot = null;
  return {
    async get() {
      if (!snapshot || now() - snapshot.at > ttlMs) {
        snapshot = Object.freeze({ value: Object.freeze(await load()), at: now() });
      }
      return snapshot.value;
    },
  };
}
