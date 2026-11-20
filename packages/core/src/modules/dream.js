// src/modules/dream.js — 空闲整理：把同一话题的零散事件合并成一条“梦”，再顺手做衰减
const DAY = 86400000;

export function createDreamer({ db, memory }) {
  function dream(contactId, at = Date.now()) {
    const rows = db
      .prepare(
        `SELECT id, gist, detail, topics, importance, ts FROM memories
         WHERE contact_id = ? AND ts >= ? AND level = 1 ORDER BY ts DESC LIMIT 300`,
      )
      .all(contactId, at - 14 * DAY);

    const groups = new Map();
    for (const r of rows) {
      let topics = [];
      try {
        topics = JSON.parse(r.topics || '[]');
      } catch {
        topics = [];
      }
      for (const t of topics) {
        if (!t || t.startsWith('kind:')) continue;
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(r);
      }
    }

    const merged = [];
    for (const [topic, list] of groups) {
      if (list.length < 3) continue;
      const detail = `关于「${topic}」：${list
        .slice(0, 3)
        .map((r) => r.gist)
        .join('；')}`.slice(0, 200);
      memory.write(contactId, {
        episode: `关于「${topic}」的几件事`,
        detail,
        topics: [topic, 'kind:dream'],
        importance: 3,
      });
      merged.push({ topic, count: list.length });
    }

    const decayed = memory.decay(contactId, at);
    return { scanned: rows.length, merged, decayed };
  }

  return { dream };
}
