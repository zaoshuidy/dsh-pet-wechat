// src/core/context.js — 上下文预算：按区段分配，超了按顺序砍
import { estimateTokens } from '../modules/shortterm.js';

export const DEFAULT_BUDGET = {
  persona: 400,
  mood: 80,
  memory: 400,
  summary: 300,
  history: 1200,
  current: 200,
  reserve: 1400,
};

const clipChars = (s, tokenBudget) => String(s ?? '').slice(0, Math.max(0, Math.floor(tokenBudget * 1.6)));

function memoryBlock(memories, facts) {
  const a = (memories || []).map((m) => m.gist).join('\n');
  const b = (facts || []).map((f) => `${f.key}：${f.value}`).join('\n');
  return [a, b].filter(Boolean).join('\n');
}

/**
 * 返回裁剪后的 prompt 区块，保证总量 ≤ 各段预算之和。
 * 顺序：先砍历史 → 再减记忆 → 再截摘要 → 最后截人设。
 */
export function fitContext({
  persona = '',
  mood = '',
  memories = [],
  facts = [],
  summary = '',
  history = [],
  text = '',
  detail = '',
  budget = DEFAULT_BUDGET,
} = {}) {
  const b = { ...DEFAULT_BUDGET, ...(budget || {}) };
  const cap = b.persona + b.mood + b.memory + b.summary + b.history + b.current;

  // 单条输入上限：极端长文本先截断，别把预算撑爆
  const safeText = String(text ?? '').slice(0, 1500);
  const safeDetail = String(detail ?? '').slice(0, 150);

  let hist = [...history];
  let mems = [...memories];
  let fs = (facts || []).map((f) => ({
    key: String(f?.key ?? '').replace(/[\r\n]+/g, ' ').slice(0, 20),
    value: String(f?.value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 60),
  }));
  let sum = summary;
  let ps = persona;

  const histTokens = () => hist.reduce((n, m) => n + estimateTokens(m.content), 0);
  const memTokens = () => estimateTokens(memoryBlock(mems, fs));

  // ① 历史：从最老的开始丢，直到不超 history 预算
  while (hist.length > 0 && histTokens() > b.history) hist = hist.slice(1);

  // ② 记忆 + 事实：超预算先减记忆，再减事实
  while (mems.length > 0 && memTokens() > b.memory) mems = mems.slice(0, -1);
  while (fs.length > 0 && memTokens() > b.memory) fs = fs.slice(0, -1);

  // ③ 摘要、④ 人设：按字数截
  sum = clipChars(sum, b.summary);
  ps = clipChars(ps, b.persona);

  // ⑤ 总量兜底：还超就继续砍历史
  const total = () =>
    estimateTokens(ps) + estimateTokens(mood) + memTokens() + estimateTokens(sum) + estimateTokens(safeDetail) + histTokens() + estimateTokens(safeText);
  while (hist.length > 0 && total() > cap) hist = hist.slice(1);

  return {
    persona: ps,
    mood,
    memories: mems,
    facts: fs,
    summary: sum,
    history: hist,
    text: safeText,
    detail: safeDetail,
    tokens: total(),
    budget: cap,
  };
}
