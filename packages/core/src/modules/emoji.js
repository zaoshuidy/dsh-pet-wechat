// src/modules/emoji.js — 按情绪补一个 emoji（微信一定显示，表情包的前置层）
const TABLE = {
  开心: ['😄', '✨', '🥰', '😆'],
  松快: ['🙂', '☺️', '😌'],
  平静: ['🙂', '😐'],
  有点闷: ['😮‍💨', '😔'],
  低落: ['😞', '🫠', '😔'],
  生气: ['😤', '💢'],
  惊讶: ['😳', '❕'],
};

const HAS_EMOJI_END = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]$/u;

export function pickEmoji(label, rng = Math.random) {
  const list = TABLE[label] || [];
  return list.length ? list[Math.floor(rng() * list.length)] : '';
}

export function appendEmoji(text, { label, chance = 0.35, rng = Math.random } = {}) {
  if (!text || !label || rng() > chance) return text;
  if (HAS_EMOJI_END.test(text)) return text;
  return text + pickEmoji(label, rng);
}
