// src/modules/retrieve.js — 三路召回（图 / BM25 / tf-idf）+ RRF + 偏置
// 视图按联系人缓存在 cache 里：一次 warm 后查询只走内存。
import { now } from '../store/db.js';

const DAY = 86400000;
const K1 = 1.2;
const B = 0.75;
const RRF_K = 60;
const W = { fresh: 0.15, importance: 0.15, mood: 0.1, person: 0.1 };

const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+|[a-z0-9]+/g;
const CJK_CHAR = /[\u3400-\u9fff\uf900-\ufaff]/;

// 中文按「单字 + 相邻 bigram」切，英文/数字按词切。
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  CJK_RUN.lastIndex = 0;
  let m;
  while ((m = CJK_RUN.exec(s))) {
    const run = m[0];
    if (!CJK_CHAR.test(run[0])) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length; i++) {
      out.push(run[i]);
      if (i + 1 < run.length) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

export function bigramTf(text) {
  const counts = new Map();
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) || 0) + 1);
  const pairs = [];
  let sq = 0;
  for (const [t, c] of counts) {
    const w = 1 + Math.log(c);
    pairs.push([t, w]);
    sq += w * w;
  }
  const norm = Math.sqrt(sq) || 1;
  return pairs.map(([t, w]) => [t, +(w / norm).toFixed(4)]);
}

export function cosineOf(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const m = new Map(a);
  let dot = 0;
  for (const [t, w] of b) {
    const x = m.get(t);
    if (x) dot += x * w;
  }
  return dot;
}

const arr = (v) => {
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};

function parseVec(v) {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) ? a.filter((p) => Array.isArray(p) && p.length === 2) : [];
  } catch {
    return [];
  }
}

const moodFit = (mood, valence) => {
  const v = Number(valence || 0) * 50 + 50;
  return Math.max(0, 1 - Math.abs(v - Number(mood ?? 50)) / 100);
};

export function createRetriever({ db, graph, cache } = {}) {
  const st = {
    mems: db.prepare(`SELECT id, gist, detail, topics, people, valence, importance, ts, last_access, level
                      FROM memories WHERE contact_id = ? ORDER BY ts DESC LIMIT 500`),
    emb: db.prepare(`SELECT e.owner_id, e.vec FROM embeddings e
                     JOIN memories m ON m.id = e.owner_id
                     WHERE e.owner_type = 'memory' AND m.contact_id = ?`),
    person: db.prepare('SELECT mood, name, likes FROM persons WHERE contact_id = ?'),
    memEnt: db.prepare(`SELECT me.memory_id, me.entity_id FROM mem_entities me
                        JOIN memories m ON m.id = me.memory_id WHERE m.contact_id = ?`),
    ents: db.prepare('SELECT id, name, aliases FROM entities WHERE contact_id = ?'),
    edges: db.prepare('SELECT src, dst, weight FROM edges WHERE contact_id = ? AND valid_to IS NULL'),
    touch: db.prepare('UPDATE memories SET last_access = ?, access_count = access_count + 1, strength = strength + 1 WHERE id = ?'),
  };

  // 一次性把该联系人的检索数据装进内存视图
  function buildView(contactId) {
    const docs = st.mems
      .all(contactId)
      .map((r) => {
        const topicsArr = arr(r.topics);
        const peopleArr = arr(r.people);
        const txt = [r.gist, r.detail, ...topicsArr, ...peopleArr].filter(Boolean).join(' ');
        const tf = new Map();
        const toks = tokenize(txt);
        for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
        return { ...r, topicsArr, peopleArr, txt, tf, len: toks.length };
      })
      .filter((d) => d.gist || d.detail);

    const df = new Map();
    let sumLen = 0;
    for (const d of docs) {
      sumLen += d.len;
      for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }

    const vectors = new Map();
    for (const r of st.emb.all(contactId)) vectors.set(r.owner_id, parseVec(r.vec));

    const ents = st.ents.all(contactId).map((e) => ({ id: e.id, name: String(e.name), aliases: arr(e.aliases) }));

    const adj = new Map();
    const addAdj = (a, b, w) => {
      if (!adj.has(a)) adj.set(a, new Map());
      adj.get(a).set(b, Math.max(adj.get(a).get(b) || 0, w));
    };
    for (const e of st.edges.all(contactId)) {
      const w = Number(e.weight) || 1;
      addAdj(e.src, e.dst, w);
      addAdj(e.dst, e.src, w);
    }

    const memOfEnt = new Map();
    for (const r of st.memEnt.all(contactId)) {
      if (!memOfEnt.has(r.entity_id)) memOfEnt.set(r.entity_id, []);
      memOfEnt.get(r.entity_id).push(r.memory_id);
    }

    return {
      at: now(),
      docs,
      df,
      avgLen: sumLen / (docs.length || 1),
      vectors,
      ents,
      adj,
      memOfEnt,
      person: st.person.get(contactId) || {},
    };
  }

  function viewOf(contactId) {
    const hit = cache?.get?.(contactId);
    if (hit) return hit;
    const view = buildView(contactId);
    cache?.set?.(contactId, view);
    return view;
  }

  // 别名命中：名字出现在句子里，或句子是名字的一部分（≥2 字）
  function aliasHits(view, q) {
    const out = [];
    for (const e of view.ents) {
      const names = [e.name, ...e.aliases].filter(Boolean);
      const hit = names.find((n) => n && (q.includes(n) || (q.length >= 2 && n.includes(q))));
      if (hit) out.push({ id: e.id, w: Math.min(1, 0.5 + hit.length / 10) });
    }
    return out;
  }

  function expand(view, seeds) {
    const w = new Map(seeds.map((s) => [s.id, s.w]));
    let frontier = seeds.map((s) => [s.id, s.w]);
    const seen = new Set(frontier.map(([id]) => id));
    for (let depth = 0; depth < 2 && frontier.length; depth += 1) {
      const next = [];
      for (const [eid, ew] of frontier) {
        for (const [nid, edgeW] of view.adj.get(eid) || []) {
          const val = ew * edgeW * (depth === 0 ? 1 : 0.6);
          if (!(w.get(nid) >= val)) w.set(nid, val);
          if (!seen.has(nid)) {
            seen.add(nid);
            next.push([nid, val]);
          }
        }
      }
      frontier = next;
    }
    return w;
  }

  // 返回 [{id, gist, score, why}]
  function search(contactId, text, opts = {}) {
    const t0 = performance.now();
    const limit = Math.max(1, Math.trunc(Number(opts.limit) || 3));
    const q = String(text ?? '').trim();
    const view = viewOf(contactId);
    const { docs } = view;
    if (!docs.length) {
      search.lastMs = +(performance.now() - t0).toFixed(2);
      return [];
    }
    const byId = new Map(docs.map((d) => [d.id, d]));

    // ① 实体路：别名命中 + 1 跳扩展
    const entW = expand(view, aliasHits(view, q));
    const memW = new Map();
    for (const [eid, w] of entW) {
      for (const mid of view.memOfEnt.get(eid) || []) {
        if (byId.has(mid)) memW.set(mid, Math.max(memW.get(mid) || 0, w));
      }
    }
    const routeGraph = [...memW.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

    // ② 关键词路：BM25（tf/df 已预建）
    const qToks = [...new Set(tokenize(q))];
    const bm = [];
    for (const d of docs) {
      let score = 0;
      for (const t of qToks) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = view.df.get(t) || 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.len) / view.avgLen));
      }
      if (score > 0) bm.push([d.id, score]);
    }
    bm.sort((a, b) => b[1] - a[1]);
    const routeBm25 = bm.map(([id]) => id);

    // ③ 向量路
    const qv = bigramTf(q);
    const vec = [];
    for (const d of docs) {
      let v = view.vectors.get(d.id);
      if (!v?.length) {
        v = bigramTf(d.txt);
        view.vectors.set(d.id, v);
      }
      const s = cosineOf(qv, v);
      if (s > 0) vec.push([d.id, s]);
    }
    vec.sort((a, b) => b[1] - a[1]);
    const routeVec = vec.map(([id]) => id);

    // RRF(60) 融合
    const score = new Map();
    const why = new Map();
    const fuse = (list, tag) =>
      list.forEach((id, i) => {
        score.set(id, (score.get(id) || 0) + 1 / (RRF_K + i + 1));
        const w = why.get(id) || [];
        if (w.length < 3) w.push(`${tag}#${i + 1}`);
        why.set(id, w);
      });
    fuse(routeGraph, 'graph');
    fuse(routeBm25, 'bm25');
    fuse(routeVec, 'vec');

    // 偏置（心情每次现读：心情变了，召回排序要跟着变）
    const p = st.person.get(contactId) || {};
    const likes = arr(p.likes);
    const name = p.name ? String(p.name) : '';
    const bias = (d) => {
      const ageDays = Math.max(0, (view.at - Number(d.last_access ?? d.ts ?? view.at)) / DAY);
      const fresh = Math.max(0, 1 - ageDays / 30);
      const importance = Math.min(1, Math.max(0, Number(d.importance ?? 3) / 5));
      const mood = moodFit(p.mood, d.valence);
      let person = memW.has(d.id) ? 1 : 0;
      if (!person && name && d.peopleArr.includes(name)) person = 0.5;
      if (!person && likes.some((k) => k && d.txt.includes(k))) person = 0.5;
      return W.fresh * fresh + W.importance * importance + W.mood * mood + W.person * person;
    };

    const out = [];
    for (const d of docs) {
      const rrf = score.get(d.id);
      if (!rrf) continue;
      out.push({
        id: d.id,
        gist: String(d.gist || d.detail || '').slice(0, 40),
        score: +(rrf + bias(d)).toFixed(6),
        why: (why.get(d.id) || []).join('+'),
      });
    }
    out.sort((a, b) => b.score - a.score);
    const top = out.slice(0, limit);
    for (const h of top) st.touch.run(view.at, h.id);

    search.lastMs = +(performance.now() - t0).toFixed(2);
    return top;
  }

  search.lastMs = 0;
  return { search, viewOf, buildView };
}
