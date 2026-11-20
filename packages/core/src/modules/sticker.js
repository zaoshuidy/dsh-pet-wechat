// src/modules/sticker.js — 表情包：读 dsh-meme 图库格式（index.db + memes/）
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// 我们的情绪标签 → dsh-meme 的 6 个情绪桶
const TAG_OF = {
  开心: 'happy',
  松快: 'happy',
  平静: 'daily',
  有点闷: 'sad',
  低落: 'sad',
  生气: 'angry',
  惊讶: 'surprised',
};

export function createSticker({ dir, rng = Math.random } = {}) {
  const dbFile = dir ? join(dir, 'index.db') : '';
  if (!dbFile || !existsSync(dbFile)) {
    return { available: false, tags: [], pick: () => null, maybe: () => null };
  }

  const db = new DatabaseSync(dbFile, { readOnly: true });
  const tags = new Set(db.prepare('SELECT DISTINCT tag FROM memes').all().map((r) => r.tag));
  const qTag = db.prepare('SELECT path, tag, caption, keywords FROM memes WHERE tag = ?');

  function pick({ label, query, avoid = [] } = {}) {
    let tag = TAG_OF[label] || 'daily';
    if (!tags.has(tag)) tag = tags.has('daily') ? 'daily' : [...tags][0];
    let rows = qTag.all(tag);
    if (query) {
      const hit = rows.filter((r) => `${r.caption} ${r.keywords}`.includes(query));
      if (hit.length) rows = hit;
    }
    rows = rows.filter((r) => !avoid.includes(r.path));
    if (!rows.length) return null;
    const r = rows[Math.floor(rng() * rows.length)];
    return { rel: r.path, tag: r.tag, caption: r.caption };
  }

  // 有情绪、够强、随机命中才发；测试可注入 rng
  function maybe({ label, intensity = 0, chance = 0.25 } = {}) {
    if (!label || intensity < 15) return null;
    if (rng() > chance) return null;
    return pick({ label });
  }

  return { available: true, tags: [...tags], pick, maybe };
}
