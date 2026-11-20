// src/modules/memory.js — 事件写入、召回委托、细节展开、7/30/180 天衰减
import { now } from '../store/db.js';
import { createGraph } from './graph.js';
import { createRetriever, bigramTf } from './retrieve.js';

const DAY = 86400000;
const GIST_MAX = 40;

export const clip = (s, n = GIST_MAX) => String(s ?? '').trim().slice(0, n);

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
  return Array.isArray(a) ? a : [];
};
const num = (v, dflt) => (v === null || v === undefined || v === '' ? dflt : Number.isFinite(Number(v)) ? Number(v) : dflt);

function firstSentence(text, n = 60) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  const m = s.split(/(?<=[。！？!?\n])/)[0] || s;
  return m.trim().slice(0, n);
}

// 结构化的实体/关系/事实统一成 {type,name,aliases,attrs}
function asEntity(e) {
  if (typeof e === 'string') return e.trim() ? { type: 'thing', name: e.trim() } : null;
  if (!e || !e.name) return null;
  return { ...e, type: e.type || 'thing', name: String(e.name).trim() };
}

export function createMemory(db, opts = {}) {
  const graph = createGraph(db);
  const retriever = createRetriever({ db, graph, cache: opts.cache });
  const cache = opts.cache || null;

  const st = {
    insMem: db.prepare(`INSERT INTO memories
      (id, contact_id, level, parent_id, title, gist, detail, topics, people, valence, arousal,
       importance, strength, ts, last_access, access_count, detail_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insME: db.prepare('INSERT OR IGNORE INTO mem_entities (memory_id, entity_id) VALUES (?, ?)'),
    insEmb: db.prepare("INSERT OR REPLACE INTO embeddings (owner_type, owner_id, vec, model) VALUES ('memory', ?, ?, ?)"),
    facts: db.prepare("SELECT name, attrs FROM entities WHERE contact_id = ? AND type = 'fact' ORDER BY importance DESC, last_seen DESC LIMIT ?"),
    lvl: db.prepare('SELECT level FROM memories WHERE id = ?'),
    one: db.prepare('SELECT detail, gist FROM memories WHERE contact_id = ? AND id = ?'),
    recent: db.prepare('SELECT id, gist, detail, level FROM memories WHERE contact_id = ? ORDER BY ts DESC LIMIT ?'),
    setName: db.prepare('UPDATE persons SET name = ? WHERE contact_id = ?'),
    setLikes: db.prepare('UPDATE persons SET likes = ? WHERE contact_id = ?'),
    personRow: db.prepare('SELECT name, likes FROM persons WHERE contact_id = ?'),
    touch: db.prepare('UPDATE memories SET last_access = ?, access_count = access_count + 1, strength = strength + 1 WHERE id = ?'),
    stale: db.prepare('SELECT * FROM memories WHERE contact_id = ?'),
    setDetail: db.prepare('UPDATE memories SET level = ?, detail_level = ?, detail = ? WHERE id = ?'),
  };

  const saveEmb = (id, text) => st.insEmb.run(id, JSON.stringify(bigramTf(text)), 'bigram-tfidf');

  // 写一条事件记忆，并同步实体/边/事实。
  function writeUnsafe(contactId, rec = {}) {
    const episode = String(rec.episode ?? '').trim();
    const at = now();
    const id = 'm_' + at + Math.random().toString(36).slice(2, 6);
    const detail = typeof rec.detail === 'string' && rec.detail.trim() ? rec.detail.trim() : null;
    const topics = Array.isArray(rec.topics) ? rec.topics.map(String).filter(Boolean) : [];
    const kind = String(rec.kind || 'event');
    if (!topics.some((t) => t.startsWith('kind:'))) topics.push(`kind:${kind}`);
    const people = Array.isArray(rec.people) ? rec.people.map(String).filter(Boolean) : [];
    const gist = clip(episode || detail || '（无描述）');

    st.insMem.run(
      id, contactId, 1, rec.parentId ?? null, clip(rec.title ?? gist, 20), gist, detail,
      JSON.stringify(topics), JSON.stringify(people),
      num(rec.valence, 0), num(rec.arousal, 0), num(rec.importance, 3), 1,
      at, at, 0, detail ? 3 : 2,
    );
    saveEmb(id, [gist, detail || '', topics.join(' '), people.join(' ')].join(' '));

    const entityIds = [];
    const byName = new Map();
    const addEntity = (raw) => {
      const e = asEntity(raw);
      if (!e) return null;
      const eid = graph.upsertEntity(contactId, e);
      if (!eid) return null;
      byName.set(e.name, eid);
      if (!entityIds.includes(eid)) entityIds.push(eid);
      return eid;
    };

    for (const e of Array.isArray(rec.entities) ? rec.entities : []) addEntity(e);
    for (const p of people) if (!byName.has(p)) addEntity({ type: 'person', name: p });

    const resolve = (v) => {
      const key = String(v ?? '').trim();
      if (!key) return null;
      return byName.get(key) || addEntity({ type: 'thing', name: key });
    };

    const edgeIds = [];
    for (const r of Array.isArray(rec.relations) ? rec.relations : []) {
      if (!r) continue;
      const src = resolve(r.src ?? r.from);
      const dst = resolve(r.dst ?? r.to);
      if (!src || !dst) continue;
      const eid = graph.link(contactId, src, dst, String(r.rel || r.relation || 'related'), {
        weight: num(r.weight, 1),
        source: id,
        confidence: num(r.confidence, 0.6),
      });
      if (eid) edgeIds.push(eid);
    }

    // facts 存成 type='fact' 的实体，name=key、attrs={value}（值做长度裁剪，防注入撑爆）
    for (const f of Array.isArray(rec.facts) ? rec.facts : []) {
      const key = typeof f === 'string' ? f.trim() : String(f?.key ?? f?.name ?? '').trim();
      if (!key) continue;
      const raw = typeof f === 'string' ? '' : (f?.value ?? f?.v ?? '');
      const value = String(raw).replace(/[\r\n]+/g, ' ').slice(0, 60);
      const eid = graph.upsertEntity(contactId, { type: 'fact', name: key, attrs: { value }, importance: num(rec.importance, 3) });
      if (eid) {
        if (!entityIds.includes(eid)) entityIds.push(eid);
        st.insME.run(id, eid);
      }
      // 画像：名字/喜好顺手写进 persons，供召回偏置用
      if (/^(名字|称呼|昵称|姓名)$/.test(key) && value) st.setName.run(value, contactId);
      if (/喜欢/.test(key) && value) {
        const row = st.personRow.get(contactId);
        const likes = pj(row?.likes, []);
        if (!likes.includes(value)) st.setLikes.run(JSON.stringify([...likes, value].slice(0, 20)), contactId);
      }
    }

    for (const eid of entityIds) st.insME.run(id, eid);
    return { id, entityIds, edgeIds };
  }

  // 事务包一层：要么整条记忆（含实体/边/事实）落库，要么全不落；写完让缓存失效
  function write(contactId, rec = {}) {
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = writeUnsafe(contactId, rec);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    cache?.invalidate?.(contactId);
    return result;
  }

  // 召回交给 retriever（图 + BM25 + tf-idf），facts 单独取。
  function recall(contactId, text, opts = {}) {
    const limit = Math.max(1, num(opts.limit, 3));
    const items = retriever.search(contactId, text, { limit }).map((h) => ({
      id: h.id,
      gist: h.gist,
      score: h.score,
      level: st.lvl.get(h.id)?.level ?? 1,
      why: h.why,
    }));
    const facts = st.facts.all(contactId, Math.max(1, num(opts.facts, 5))).map((r) => ({
      key: r.name,
      value: pj(r.attrs, {}).value ?? '',
    }));
    return { items, facts };
  }

  // 最近一条（给“那次/上次”这类指代兜底）
  function recent(contactId, limit = 1) {
    return st.recent.all(contactId, Math.max(1, num(limit, 1))).map((r) => ({
      id: r.id,
      gist: r.gist,
      score: 0,
      level: num(r.level, 1),
      why: 'recent',
    }));
  }

  // 按需展开 L0 原文。
  function expand(contactId, id) {
    const row = st.one.get(contactId, id);
    if (!row) return { detail: null, gist: null };
    st.touch.run(now(), id);
    return { detail: row.detail || row.gist || null, gist: row.gist ?? null };
  }

  // 7 天压成摘要 / 30 天并入章节只留 gist / 180 天只留 topics。返回改动条数。
  function decay(contactId, at = now()) {
    const t = num(at, now());
    let changed = 0;
    for (const r of st.stale.all(contactId)) {
      const age = t - num(r.last_access ?? r.ts, t);
      const hit = age >= 180 * DAY ? 180 : age >= 30 * DAY ? 30 : age >= 7 * DAY ? 7 : 0;
      if (!hit) continue;
      let level = num(r.level, 1);
      let dl = num(r.detail_level, 2);
      let detail = r.detail;
      if (hit === 7) {
        if (!detail && dl <= 2) continue;
        dl = Math.min(dl, 2);
        detail = num(r.importance, 3) >= 4 && detail ? firstSentence(detail) : null;
      } else if (hit === 30) {
        level = Math.max(level, 2);
        dl = Math.min(dl, 1);
        detail = null;
      } else {
        level = 3;
        dl = 0;
        detail = null;
      }
      if (level === r.level && dl === r.detail_level && detail === r.detail) continue;
      st.setDetail.run(level, dl, detail, r.id);
      changed++;
    }
    if (changed) cache?.invalidate?.(contactId);
    return changed;
  }

  // 接口占位：字符 bigram tf-idf 向量（已归一化）。
  const embed = (text) => bigramTf(text);

  return { write, recall, expand, decay, embed, recent };
}
