// src/modules/cache.js — 每联系人的召回缓存（内存），写后失效
export function createCache({ maxContacts = 32 } = {}) {
  const map = new Map();

  function get(contactId) {
    const hit = map.get(contactId);
    if (!hit) return null;
    hit.at = Date.now();
    return hit.view;
  }

  function set(contactId, view) {
    if (map.size >= maxContacts && !map.has(contactId)) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, v] of map) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestKey = k;
        }
      }
      if (oldestKey) map.delete(oldestKey);
    }
    map.set(contactId, { view, at: Date.now() });
  }

  function invalidate(contactId) {
    map.delete(contactId);
  }

  function clear() {
    map.clear();
  }

  function stats() {
    return { contacts: map.size };
  }

  return { get, set, invalidate, clear, stats };
}
