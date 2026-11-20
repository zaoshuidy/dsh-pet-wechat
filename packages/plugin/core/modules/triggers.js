// src/modules/triggers.js — 情绪触发规则（确定性关键词层）
// 作用：给“这一轮发生了什么”一个兜底判断，避免全靠模型自报。
// 每条规则给一点变化量，实际入账时按 0.5 缩放，防止和模型 state 双重计入。

export const RULES = [
  { id: 'praise', test: /夸|喜欢你|爱你|想你|抱抱|贴贴|真好/, delta: { mood: 2, affection: 1 }, label: '开心' },
  { id: 'insult', test: /滚|讨厌|闭嘴|烦死你|废物|骂/, delta: { mood: -3, affection: -1 }, label: '生气' },
  { id: 'apology', test: /对不起|我错了|抱歉|别生气/, delta: { mood: 1, affection: 1 }, label: '松快' },
  { id: 'coquette', test: /嘛|好不好|陪我|撒娇|求你了/, delta: { mood: 1, affection: 1 }, label: '松快' },
  { id: 'tired', test: /累|加班|难受|想哭|撑不住|烦死/, delta: { mood: -2, energy: -2 }, label: '低落' },
  { id: 'goodnews', test: /开心|太好了|成功了|过了|升职|中奖/, delta: { mood: 2 }, label: '开心' },
  { id: 'night', test: /晚安|睡了|困了|去睡/, delta: { energy: -1 }, label: '平静' },
  { id: 'reunion', test: /好久不见|想你了|终于见到/, delta: { mood: 2, affection: 1 }, label: '开心' },
];

const SCALE = 0.5;
const round = (n) => (n >= 0 ? Math.round(n) : -Math.round(-n));

/**
 * 匹配规则，返回 {delta, labels, hits}
 * 最多命中 max 条，delta 已按 0.5 缩放并取整。
 */
export function matchTriggers(text, max = 2) {
  const s = String(text ?? '');
  const hits = RULES.filter((r) => r.test.test(s)).slice(0, max);
  if (!hits.length) return { delta: null, labels: [], hits: [] };

  const delta = { mood: 0, energy: 0, affection: 0 };
  for (const h of hits) {
    for (const k of Object.keys(delta)) {
      delta[k] += round((h.delta[k] || 0) * SCALE);
    }
  }
  for (const k of Object.keys(delta)) if (!delta[k]) delete delta[k];

  return {
    delta: Object.keys(delta).length ? delta : null,
    labels: [...new Set(hits.map((h) => h.label).filter(Boolean))],
    hits: hits.map((h) => h.id),
  };
}
