// src/modules/graph.js — 实体图：按 (contact_id, name) 去重、写边、别名命中、1–2 跳邻居
import { now } from '../store/db.js';

const HOP2 = 0.6; // 第 2 跳权重折扣
const uid = (prefix) => prefix + now().toString(36) + Math.random().toString(36).slice(2, 8);

function pj(v, dflt) {
  try {
    const x = JSON.parse(v);
    return x ?? dflt;
  } catch {
    return dflt;
  }
}
const asArr = (v) => {
  const a = pj(v, []);
  return Array.isArray(a) ? a.map(String).filter(Boolean) : [];
};
const asObj = (v) => {
  const o = pj(v, {});
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
};
const uniq = (a) => [...new Set(a.filter(Boolean))];
const num = (v, dflt) => (v === null || v === undefined || v === '' ? dflt : Number.isFinite(Number(v)) ? Number(v) : dflt);

export function createGraph(db) {
  const st = {
    byName: db.prepare('SELECT * FROM entities WHERE contact_id = ? AND name = ?'),
    all: db.prepare('SELECT * FROM entities WHERE contact_id = ?'),
    ins: db.prepare(`INSERT INTO entities (id, contact_id, type, name, aliases, attrs, importance, last_seen)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    upd: db.prepare('UPDATE entities SET type = ?, aliases = ?, attrs = ?, importance = ?, last_seen = ? WHERE id = ?'),
    insEdge: db.prepare(`INSERT INTO edges (id, contact_id, src, dst, rel, weight, valid_from, valid_to, source_memory, confidence)
                         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`),
    edgesOf: db.prepare('SELECT * FROM edges WHERE contact_id = ? AND valid_to IS NULL AND (src = ? OR dst = ?)'),
  };

  // 按 (contact_id, name) 去重；命中则合并 aliases/attrs 并刷新 last_seen。
  function upsertEntity(contactId, e = {}) {
    const name = String(e.name ?? '').trim();
    if (name.length < 2 || name.length > 12) return null;
    const type = String(e.type || 'thing');
    const aliases = uniq([
      ...(Array.isArray(e.aliases) ? e.aliases : []),
      ...(typeof e.alias === 'string' ? [e.alias] : []),
    ].map((s) => String(s).trim()));
    const attrs = e.attrs && typeof e.attrs === 'object' ? e.attrs : {};
    const at = now();
    const row = st.byName.get(contactId, name);
    if (row) {
      const merged = uniq([...asArr(row.aliases), ...aliases]);
      const prevAttrs = asObj(row.attrs);
      const nextAttrs = { ...prevAttrs, ...attrs };
      // 事实改值：留上一条，别直接覆盖
      if (attrs.value !== undefined && prevAttrs.value !== undefined && String(attrs.value) !== String(prevAttrs.value)) {
        nextAttrs.prev = prevAttrs.value;
        nextAttrs.prevAt = at;
      }
      const importance = Math.max(num(row.importance, 1), num(e.importance, 1));
      // 事实类实体不因普通同名实体改写 type。
      const nextType = row.type === 'fact' ? 'fact' : type;
      st.upd.run(nextType, JSON.stringify(merged), JSON.stringify(nextAttrs), importance, at, row.id);
      return row.id;
    }
    const id = uid('n_');
    st.ins.run(id, contactId, type, name, JSON.stringify(aliases), JSON.stringify(attrs), num(e.importance, 1), at);
    return id;
  }

  // 写一条边（只追加，作废用 valid_to）。
  function link(contactId, src, dst, rel, o = {}) {
    if (!src || !dst) return null;
    const id = uid('l_');
    st.insEdge.run(
      id, contactId, src, dst, String(rel || 'related'),
      num(o.weight, 1),
      num(o.validFrom, now()),
      o.source ?? null,
      num(o.confidence, 0.6),
    );
    return id;
  }

  // name / aliases 包含匹配：实体名出现在 text 里，或 text 被实体名包含。
  function findByAlias(contactId, text) {
    const t = String(text ?? '').trim().toLowerCase();
    if (!t) return [];
    const out = [];
    for (const row of st.all.all(contactId)) {
      const names = uniq([row.name, ...asArr(row.aliases)]).map((s) => s.toLowerCase());
      let best = 0;
      for (const n of names) {
        if (!n) continue;
        if (t.includes(n)) best = Math.max(best, n.length);
        else if (t.length >= 2 && n.includes(t)) best = Math.max(best, t.length);
      }
      if (best > 0) out.push({ id: row.id, name: row.name, type: row.type, score: best });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 8).map(({ id, name, type }) => ({ id, name, type }));
  }

  // 1–2 跳邻居，第 2 跳权重 ×0.6；返回 [{id, weight, path}]。
  function neighbors(contactId, entityId, hops = 1) {
    if (!entityId) return [];
    const max = Math.min(Math.max(Math.trunc(num(hops, 1)), 1), 2);
    const seen = new Map([[entityId, { weight: 1, path: [entityId] }]]);
    let frontier = [{ id: entityId, weight: 1, path: [entityId] }];
    for (let depth = 1; depth <= max; depth++) {
      const next = [];
      for (const f of frontier) {
        for (const e of st.edgesOf.all(contactId, f.id, f.id)) {
          const other = e.src === f.id ? e.dst : e.src;
          if (!other || other === entityId) continue;
          const w = f.weight * num(e.weight, 1) * (depth === 2 ? HOP2 : 1);
          if (w <= 0) continue;
          const prev = seen.get(other);
          if (prev && prev.weight >= w) continue;
          const path = [...f.path, other];
          seen.set(other, { weight: w, path });
          next.push({ id: other, weight: w, path });
        }
      }
      frontier = next;
    }
    return [...seen.entries()]
      .filter(([id]) => id !== entityId)
      .map(([id, v]) => ({ id, weight: v.weight, path: v.path }))
      .sort((a, b) => b.weight - a.weight);
  }

  return { upsertEntity, link, findByAlias, neighbors };
}
