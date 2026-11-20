// src/modules/style.js — 性格漂移：6 维确定性统计 + 口癖表
// 契约见 D:/dsh/pet/CONTRACT.md。零依赖，只碰 style / style_terms（语气词频次借 meta 命名空间键持久化）。
// 维度 0..1：sentenceLen 句长/40 ｜ emoji 条数/5 ｜ particles 命中语气词的句子比例 ｜
// punct 感叹问号占句末标点 ｜ initiative 问句或感叹开头=1 否则 .5 ｜ formality 书面词/估计词数(字数/2)

const DAY = 86_400_000, ALPHA = 0.02, MIN_DELTA = 0.05; // 漂移步长 0.02；差 <0.05 不动
const IDLE_DAYS = 7, IDLE_RETURN = 0.01; // 7 天不访问后每天回 0.01
const MAX_TERMS = 5, MAX_PARTICLES = 5, MAX_PARTICLE_MEMORY = 8;
const TERM_MIN = 2, TERM_MAX = 3;

export const DIMS = ['sentenceLen', 'emoji', 'particles', 'punct', 'initiative', 'formality'];
export const DEFAULT_BASE = { sentenceLen: 0.5, emoji: 0.2, particles: 0.3, punct: 0.3, initiative: 0.5, formality: 0.3 };

const SENTENCE_SPLIT = /[。．.!！？?…~～；;\n\r]+/;
const CLAUSE_SPLIT = /[。．.!！？?…~～；;，,、\s]+/;
const WORD_RUN = /[0-9A-Za-z\u4e00-\u9fa5]/;

// 语气词表（单字命中即算）
const PARTICLES = ['呀', '呢', '吧', '嘛', '啊', '哦', '噢', '嗯', '啦', '咯', '哈',
  '呗', '诶', '哎', '唉', '喂', '喔', '呐', '嘞', '哟', '嘿'];
// 书面词表（长词优先，避免短词先吃掉长词）
const FORMAL_WORDS = ['因此', '然而', '此外', '并且', '从而', '鉴于', '综上', '首先', '其次', '最后', '而言', '相关',
  '进行', '实现', '具备', '呈现', '采用', '通过', '关于', '对于', '由于', '以及', '乃至', '颇为', '较为', '尚未',
  '予以', '加以', '务必', '您', '感谢', '尊敬', '应该', '需要', '建议', '问题', '情况', '处理', '分析', '考虑',
  '提供', '支持', '内容', '方式', '方面', '整体', '基本', '显然', '可见', '过程', '结论', '目的', '确定', '说明', '表示'];
const FORMAL_RE = new RegExp(FORMAL_WORDS.slice().sort((a, b) => b.length - a.length).join('|'), 'g');

const QUESTION_HEAD = /^(请问|什么|啥|怎么|怎样|怎么样|为什么|为啥|哪|谁|几点|多少|多久|要不要|是不是|能不能|可不可以|有没有|好不好|行不行|吗|呢)/;

export function createStyle(db) {
  const cache = new Map();
  const q = (sql) => {
    if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
    return cache.get(sql);
  };

  // 初始化 base/min/max（min=base*0.9, max=base*1.1）；已有行只刷新基准，不覆盖 current
  function seed(contactId, opts = {}) {
    const base = { ...DEFAULT_BASE, ...((opts && opts.base) || {}) };
    const up = q(`INSERT INTO style (contact_id, dim, base, min, max, current, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_id, dim) DO UPDATE SET base = excluded.base, min = excluded.min,
        max = excluded.max, updated_at = excluded.updated_at`);
    for (const dim of DIMS) {
      const b = clamp01(num(base[dim], DEFAULT_BASE[dim]));
      up.run(contactId, dim, b, b * 0.9, b * 1.1, b, Date.now());
    }
    return current(contactId);
  }

  function ensure(contactId) {
    const row = q('SELECT COUNT(*) AS n FROM style WHERE contact_id = ?').get(contactId);
    if (!row || Number(row.n) === 0) seed(contactId);
  }

  function readDims(contactId) {
    const rows = q('SELECT dim, base, current FROM style WHERE contact_id = ?').all(contactId);
    const byDim = new Map(rows.map((r) => [r.dim, r]));
    const dims = {};
    for (const dim of DIMS) {
      const row = byDim.get(dim);
      dims[dim] = row ? round4(num(row.current, num(row.base, DEFAULT_BASE[dim]))) : DEFAULT_BASE[dim];
    }
    return dims;
  }

  function readTerms(contactId) {
    return q(`SELECT term FROM style_terms WHERE contact_id = ? AND count >= 2
      ORDER BY count DESC, last_seen DESC, term ASC LIMIT ?`)
      .all(contactId, MAX_TERMS).map((r) => r.term);
  }

  function current(contactId) {
    ensure(contactId);
    return { dims: readDims(contactId), terms: readTerms(contactId) };
  }

  // 与 current 同形，但 particles 换成词数组：按该维浓度取前 N 个（学到的词优先）
  function register(contactId) {
    const { dims, terms } = current(contactId);
    const pool = unique([...learnedParticles(contactId), ...PARTICLES]);
    return { ...dims, particles: pool.slice(0, Math.round(clamp01(dims.particles) * MAX_PARTICLES)), terms };
  }

  // 观测并漂移
  function observe(contactId, text) {
    const at = Date.now();
    const raw = String(text ?? '');
    const sample = measure(raw);
    ensure(contactId);
    rememberParticles(contactId, sample.particleWords);
    learnTerms(contactId, raw, at);

    const upd = q('UPDATE style SET current = ?, updated_at = ? WHERE contact_id = ? AND dim = ?');
    const rows = q('SELECT dim, base, min, max, current, updated_at FROM style WHERE contact_id = ?').all(contactId);
    for (const row of rows) {
      const observed = sample.dims[row.dim];
      if (typeof observed !== 'number') continue;
      const base = num(row.base, DEFAULT_BASE[row.dim] ?? 0.5);
      const lo = num(row.min, base * 0.9), hi = num(row.max, base * 1.1);
      let cur = num(row.current, base);
      // 7 天不访问：每天 0.01 回 base（到 base 即止，不穿过）
      const idle = idleSteps(row.updated_at, at);
      if (idle > 0) cur += Math.sign(base - cur) * Math.min(Math.abs(base - cur), idle * IDLE_RETURN);
      // α=0.02 靠近观测值；差值 <0.05 不动
      if (Math.abs(observed - cur) >= MIN_DELTA) cur += ALPHA * (observed - cur);
      upd.run(round4(clamp(cur, lo, hi)), at, contactId, row.dim);
    }
    return { dims: readDims(contactId), terms: readTerms(contactId) };
  }

  // 口癖：2–3 字重复片段，命中 ≥2 次才记，最多 5 个
  function learnTerms(contactId, t, at) {
    const hits = new Map();
    for (const run of runsOf(t)) {
      for (let n = TERM_MIN; n <= TERM_MAX; n++) {
        for (let i = 0; i + n <= run.length; i++) {
          const grain = run.slice(i, i + n);
          hits.set(grain, (hits.get(grain) || 0) + 1);
        }
      }
    }
    const up = q(`INSERT INTO style_terms (contact_id, term, count, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(contact_id, term) DO UPDATE SET count = style_terms.count + excluded.count,
        last_seen = excluded.last_seen`);
    const find = q('SELECT count FROM style_terms WHERE contact_id = ? AND term = ?');
    for (const [term, n] of hits) {
      if (/^\d+$/.test(term)) continue; // 纯数字不算口癖
      if (n < 2 && !find.get(contactId, term)) continue; // 本条没重复、也没记过 -> 不收录
      up.run(contactId, term, n, at, at);
    }
    pruneTerms(contactId);
  }

  function pruneTerms(contactId) {
    // 频次高的优先；同频次取长的，再去掉互相包含的碎片（哈哈 / 哈哈哈 只留一个）
    const rows = q(`SELECT term, count FROM style_terms WHERE contact_id = ?
      ORDER BY count DESC, length(term) DESC, term ASC`).all(contactId);
    const kept = [];
    for (const row of rows) {
      if (kept.length >= MAX_TERMS) break;
      if (kept.some((k) => k.term.includes(row.term) || row.term.includes(k.term))) continue;
      kept.push(row);
    }
    const keep = new Set(kept.map((k) => k.term));
    const del = q('DELETE FROM style_terms WHERE contact_id = ? AND term = ?');
    for (const row of rows) if (!keep.has(row.term)) del.run(contactId, row.term);
  }

  // 语气词频次：存 meta 的命名空间键，register 据此给出真正用过的词
  const pkey = (contactId) => `style.particles:${contactId}`;

  function readParticleMap(contactId) {
    const row = q('SELECT v FROM meta WHERE k = ?').get(pkey(contactId));
    try {
      const map = row && JSON.parse(row.v);
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch {
      return {};
    }
  }

  function rememberParticles(contactId, words) {
    if (!words.length) return;
    const map = readParticleMap(contactId);
    for (const word of words) map[word] = num(map[word], 0) + 1;
    const top = Object.entries(map)
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, MAX_PARTICLE_MEMORY);
    q('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(pkey(contactId), JSON.stringify(Object.fromEntries(top)));
  }

  const learnedParticles = (contactId) => Object.entries(readParticleMap(contactId))
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([word]) => word);

  return { observe, current, register, seed };
}

// ————— 纯函数：统计 —————

function measure(text) {
  const chars = text.replace(/\s+/g, '');
  const sentences = splitNonEmpty(text, SENTENCE_SPLIT);
  const clauses = splitNonEmpty(text, CLAUSE_SPLIT);
  const avgLen = sentences.length
    ? sentences.reduce((sum, s) => sum + s.length, 0) / sentences.length
    : chars.length;
  const emojiCount = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  const hitClauses = clauses.filter((c) => PARTICLES.some((p) => c.includes(p)));
  const ends = (text.match(/[。．.!！？?…~～；;]/g) || []).length;
  const bang = (text.match(/[!！？?]/g) || []).length;
  const formalHits = (text.match(FORMAL_RE) || []).length;

  return {
    dims: {
      sentenceLen: clamp01(avgLen / 40), // 平均句长 /40
      emoji: clamp01(emojiCount / 5), // 每条 emoji 数 /5
      particles: clauses.length ? hitClauses.length / clauses.length : 0, // 命中语气词的句子比例
      punct: ends ? clamp01(bang / ends) : 0, // 感叹号/问号占句末标点
      initiative: initiativeOf(text),
      formality: clamp01(formalHits / Math.max(1, Math.round(chars.length / 2))),
    },
    particleWords: unique(hitClauses.flatMap((c) => PARTICLES.filter((p) => c.includes(p)))),
  };
}

function initiativeOf(text) {
  const s = text.trim().replace(/^[\s"'“”‘’「」…—]+/, '');
  if (!s) return 0.5;
  if (/^[!！？?]/.test(s)) return 1;
  if (QUESTION_HEAD.test(s)) return 1;
  // 首句以感叹/问号收尾，也算“以问句或感叹开头”
  const head = (s.match(/^[^。．.!！？?…~～；;\n\r]*[!！？?]?/) || [''])[0];
  return /[!！？?]\s*$/.test(head) ? 1 : 0.5;
}

// 只留连续中文/字母/数字片段，按标点断开
function runsOf(text) {
  const runs = [];
  let run = '';
  for (const ch of text) {
    if (WORD_RUN.test(ch)) run += ch;
    else {
      if (run.length >= TERM_MIN) runs.push(run);
      run = '';
    }
  }
  if (run.length >= TERM_MIN) runs.push(run);
  return runs;
}

// 7 天不访问后，第 7 天起每天 1 步
function idleSteps(updatedAt, at) {
  const last = Number(updatedAt) || 0;
  if (!last) return 0;
  const days = Math.floor((at - last) / DAY);
  return days >= IDLE_DAYS ? days - IDLE_DAYS + 1 : 0;
}

const splitNonEmpty = (text, re) => text.split(re).map((s) => s.trim()).filter(Boolean);
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const clamp01 = (value) => clamp(num(value, 0), 0, 1);
const round4 = (value) => Math.round(value * 1e4) / 1e4;
const unique = (list) => [...new Set(list)];
