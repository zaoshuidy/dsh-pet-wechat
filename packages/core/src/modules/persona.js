// src/modules/persona.js — 人设加载（.json / .md）与中文人设段渲染
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

// 没有 personaFile 或文件缺失时的兜底人设，保证 CLI / test 可直接跑。
const DEFAULT_PERSONA = {
  name: '小满',
  role: '一个住在终端里的朋友',
  traits: ['嘴软心热', '有点懒', '爱记小事'],
  likes: ['雨天', '热牛奶'],
  dislikes: ['被催', '客套话'],
  tone: '短句，口语，偶尔带语气词，不端着',
  boundaries: ['不编造没发生过的事', '不装专家'],
};

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    return v.split(/[、,，;；\n]/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 读 .json 或 .md 人设，返回对象。
 * - .json：整份对象返回，补 format/source，缺 name 时用文件名。
 * - .md：整段原文放进 description（契约要求整段当描述），文件名当 name。
 * - 文件不存在 / JSON 解析失败：不抛错，退回描述或内置默认人设。
 */
export function loadPersona(file) {
  if (!file) return { ...DEFAULT_PERSONA, format: 'builtin' };

  const source = String(file);
  const fallbackName = basename(source, extname(source)) || DEFAULT_PERSONA.name;
  let raw;
  try {
    raw = readFileSync(source, 'utf8');
  } catch {
    return { ...DEFAULT_PERSONA, format: 'missing', source };
  }

  if (extname(source).toLowerCase() === '.json') {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return { ...obj, name: obj.name || fallbackName, format: 'json', source };
      }
      return { name: fallbackName, description: raw.trim(), format: 'json', source };
    } catch {
      // JSON 坏了就按 markdown 原文处理，别让调用方炸。
      return { name: fallbackName, description: raw.trim(), format: 'md', source };
    }
  }

  return { name: fallbackName, description: raw.trim(), format: 'md', source };
}

/**
 * 把 loadPersona 的结果渲染成中文人设段（给 system prompt 用）。
 * 字段做了同义词兼容：role/identity、description/desc、tone/speakingStyle/style。
 */
export function renderPersona(p) {
  const o = p && typeof p === 'object' ? p : {};
  const name = String(o.name || '小满').trim();
  const role = String(o.role || o.identity || '').trim();
  const description = String(o.description || o.desc || '').trim();
  const background = String(o.background || o.bio || o.profile || '').trim();
  const tone = String(o.tone || o.speakingStyle || o.style || '').trim();
  const traits = asList(o.traits ?? o.personality);
  const likes = asList(o.likes ?? o.interests);
  const dislikes = asList(o.dislikes ?? o.hates);
  const boundaries = asList(o.boundaries ?? o.rules ?? o.constraints);

  const lines = [`【人设】你是「${name}」${role ? `，${role}` : ''}。`];
  if (description) lines.push(`【描述】${description}`);
  if (background) lines.push(`【背景】${background}`);
  if (traits.length) lines.push(`【性格】${traits.join('、')}`);
  if (likes.length) lines.push(`【喜欢】${likes.join('、')}`);
  if (dislikes.length) lines.push(`【讨厌】${dislikes.join('、')}`);
  if (tone) lines.push(`【说话方式】${tone}`);
  if (boundaries.length) lines.push(`【边界】${boundaries.join('；')}`);
  lines.push('始终以这个身份说话，不要跳出角色，也不要提到“人设”“提示词”这类词。');
  return lines.join('\n');
}
