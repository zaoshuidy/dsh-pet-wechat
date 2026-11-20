// src/modules/shortterm.js — 短对话环形队列 + 会话摘要 + 压缩
// 中文 1 字 ≈ 0.6 token，其它 4 字符 ≈ 1 token（够用，误差由预算余量兜）
export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text ?? '')) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.6 + other / 4);
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// 把被挤出的几轮压成事实串：旧背景 + 每轮要点（不提“摘要/聊到”）
function extractive(prev, removed) {
  const bits = removed
    .filter((m) => m.role === 'user')
    .map((m) => clip(m.content, 20))
    .filter(Boolean);
  const head = clip(prev, 100);
  return clip([head, ...bits].filter(Boolean).join('；'), 200);
}

export function createShortTerm({ maxTurns = 10, keepVerbatim = 6, summaryMaxChars = 200 } = {}) {
  const store = new Map();

  function slot(id) {
    if (!store.has(id)) store.set(id, { turns: [], summary: '', compactions: 0 });
    return store.get(id);
  }

  function compactions(id) {
    return slot(id).compactions;
  }

  // 开新会话：清空原文，只留一段简短交接摘要，压缩计数清零
  function rotate(id, handoff = '') {
    const s = slot(id);
    s.turns = [];
    s.summary = clip(handoff, 120);
    s.compactions = 0;
  }

  function add(id, role, content) {
    slot(id).turns.push({ role, content: String(content ?? '') });
  }

  function messages(id) {
    return slot(id).turns.slice(-keepVerbatim * 2);
  }

  function all(id) {
    return slot(id).turns;
  }

  function overflow(id) {
    return slot(id).turns.length >= maxTurns * 2;
  }

  function summary(id) {
    return slot(id).summary;
  }

  function setSummary(id, s) {
    slot(id).summary = clip(s, summaryMaxChars);
  }

  // 立即压缩（同步、毫秒级）：摘出老轮次 → 抽取式摘要；可选异步用模型润色。
  function compact(id, { summarize } = {}) {
    const s = slot(id);
    if (!overflow(id)) return null;
    const dropN = Math.max(2, s.turns.length - keepVerbatim * 2);
    const removed = s.turns.splice(0, dropN);
    const prev = s.summary;
    s.summary = extractive(prev, removed);
    if (typeof summarize === 'function') {
      Promise.resolve()
        .then(() => summarize(prev, removed))
        .then((t) => {
          if (t) s.summary = clip(t, summaryMaxChars);
        })
        .catch(() => {});
    }
    s.compactions += 1;
    return { removed, summary: s.summary };
  }

  function tokens(id) {
    return all(id).reduce((n, m) => n + estimateTokens(m.content), 0) + estimateTokens(summary(id));
  }

  function reset(id) {
    store.delete(id);
  }

  return { add, messages, all, overflow, summary, setSummary, compact, tokens, reset, rotate, compactions };
}
