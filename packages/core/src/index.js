// src/index.js — 一轮流水线：观察 → 压缩 → 衰减 → 召回 → 预算 → prompt → 模型 → 落库
import { openDb, migrate, now } from './store/db.js';
import { createAffect } from './modules/affect.js';
import { createStyle } from './modules/style.js';
import { createMemory } from './modules/memory.js';
import { createShortTerm } from './modules/shortterm.js';
import { createCache } from './modules/cache.js';
import { loadPersona, renderPersona } from './modules/persona.js';
import { fitContext, DEFAULT_BUDGET } from './core/context.js';
import { buildPrompt } from './core/prompt.js';
import { createLlm } from './core/llm.js';
import { createSticker } from './modules/sticker.js';
import { appendEmoji } from './modules/emoji.js';
import { fileURLToPath } from 'node:url';

function takeBlock(raw, name) {
  const re = new RegExp(`\\[${name}\\]([\\s\\S]*?)\\[\\/${name}\\]`, 'i');
  const m = String(raw).match(re);
  if (!m) return { text: String(raw), data: null };
  let data = null;
  try {
    data = JSON.parse(m[1].trim());
  } catch {
    data = null;
  }
  return { text: String(raw).replace(re, '').trim(), data };
}

const stripBlocks = (s) => String(s).replace(/\[[a-z]+\][\s\S]*?\[\/[a-z]+\]/gi, '').trim();

// 问到“具体/哪天/当时”这类词，就把细节展开给模型
const DETAIL_HINT = /具体|哪天|什么时候|在哪|当时|后来|详细|细节|谁/;

// 回复里不许出现“摘要/之前聊过/根据记忆”这类机器痕迹；空回复或 JSON 残片给兜底
function sanitizeReply(reply) {
  const banned = /摘要|之前聊过|根据记忆|根据记录/;
  const kept = String(reply)
    .split(/(?<=[。！？\n])/)
    .filter((line) => !banned.test(line))
    .join('')
    .trim();
  if (!kept) return '……我没听清，再说一遍？';
  if (/^[{[]/.test(kept) || kept.includes('"reply"')) return '……我没听清，再说一遍？';
  return kept;
}

// 模型输出：优先 JSON（reply/state/memory），失败退回旧的两个块
function parseModelOutput(raw) {
  let text = String(raw ?? '').trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();

  const tryParse = (s) => {
    try {
      const o = JSON.parse(s);
      const ok = o && typeof o === 'object' && ('reply' in o || 'state' in o || 'memory' in o);
      return ok ? { reply: '', ...o } : null;
    } catch {
      return null;
    }
  };

  let obj = tryParse(text);
  if (!obj) {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(text.slice(a, b + 1));
  }
  if (obj) return { reply: String(obj.reply).trim(), state: obj.state || null, memory: obj.memory || null };

  const mem = takeBlock(text, 'memory');
  const st = takeBlock(mem.text, 'state');
  return { reply: st.text.trim(), state: st.data, memory: mem.data };
}

const DEFAULT_STICKER_DIR = fileURLToPath(new URL('../assets/memes/dafeiyu-001', import.meta.url));

export function createPet({ dbFile = ':memory:', personaFile, llm, budget = DEFAULT_BUDGET, maxTurns, rotateAfter, stickerDir = DEFAULT_STICKER_DIR } = {}) {
  const db = openDb(dbFile);
  migrate(db);

  const cache = createCache();
  const affect = createAffect(db);
  const style = createStyle(db);
  const memory = createMemory(db, { cache });
  const shortterm = createShortTerm({
    maxTurns: Number(maxTurns ?? process.env.PET_MAX_TURNS ?? 10),
  });
  const ROTATE_AFTER = Math.max(1, Number(rotateAfter ?? process.env.PET_ROTATE_AFTER ?? 3));

  // 会话纪元：每开一次新会话 +1，写进 meta，重启也在
  const getEpoch = (id) => Number(db.prepare('SELECT v FROM meta WHERE k = ?').get(`epoch:${id}`)?.v || 1);
  const bumpEpoch = (id) =>
    db
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(`epoch:${id}`, String(getEpoch(id) + 1));
  const personaText = renderPersona(loadPersona(personaFile));
  const model = llm || createLlm({ mode: 'mock' });
  const sticker = createSticker({ dir: stickerDir });

  const seeded = new Set();

  async function handle(contactId, text) {
    const id = String(contactId || 'owner');
    const input = String(text ?? '').trim();
    if (!input) return { reply: '', state: affect.get(id), memoryIds: [], context: null };

    // 0) 超预算先压缩（同步出摘要，异步用模型润色）
    if (shortterm.overflow(id)) {
      shortterm.compact(id, {
        summarize: async (prev, removed) => {
          const dialog = removed.map((m) => `${m.role === 'user' ? '对方' : '你'}：${m.content}`).join('\n');
          const raw = await model.chat([
            {
              role: 'system',
              content:
                '把这段对话整理成不超过 80 字的背景事实，用陈述句；不要出现“用户/对方/聊到/摘要”这些词，只输出事实本身。',
            },
            { role: 'user', content: `旧背景：${prev || '无'}\n对话：\n${dialog}` },
          ]);
          const out = stripBlocks(raw).replace(/\s+/g, ' ').slice(0, 120);
          // 模型跑偏（把提示词复述回来）就别用，保留抽取式摘要
          if (!out || out.includes('旧背景') || out.includes('我在听')) return null;
          return out;
        },
      });

      // 压缩到一定次数：自动开新会话，把这一段的交接摘要写进长期记忆再翻页
      if (shortterm.compactions(id) >= ROTATE_AFTER) {
        const handoff = shortterm.summary(id);
        if (handoff) {
          memory.write(id, {
            episode: `会话交接：${handoff}`,
            detail: handoff.slice(0, 120),
            topics: ['会话交接'],
            kind: 'handoff',
            importance: 4,
          });
        }
        shortterm.rotate(id, handoff);
        bumpEpoch(id);
        cache.invalidate(id);
      }
    }

    // 1) 学说话方式  2) 结清衰减  3) 召回
    if (!seeded.has(id)) {
      style.seed(id);
      seeded.add(id);
    }
    style.observe(id, input);
    affect.tick(id, now());

    const recalled = memory.recall(id, [input, ...shortterm.messages(id).filter((m) => m.role === 'user').slice(-2).map((m) => m.content)].join(' '), { limit: 3 }) || {};
    const items = recalled.items || [];
    const facts = recalled.facts || [];

    // “那次/上次”没检索到，就用最近一条兜底，别把话题断掉
    if (!items.length && /那次|上次|之前|刚才|那时候/.test(input)) {
      items.push(...memory.recent(id, 1));
    }

    // 3.5) 问到细节就展开 L0（平时不展开，省预算）
    let detail = '';
    const top = items[0];
    if (top && DETAIL_HINT.test(input)) {
      const ex = memory.expand(id, top.id);
      if (ex.detail) detail = String(ex.detail).slice(0, 150);
    }

    // 4) 预算裁剪 + 拼 prompt
    const manner = affect.manner(id);
    const styleNow = style.register(id);
    const affectText =
      affect.describe(id) +
      (styleNow.terms?.length ? `；最近爱说「${styleNow.terms.slice(0, 3).join('」「')}」` : '');

    const fitted = fitContext({
      persona: personaText,
      mood: affectText,
      memories: items,
      facts,
      summary: shortterm.summary(id),
      history: shortterm.messages(id),
      text: input,
      detail,
      budget,
    });

    const messages = buildPrompt({
      persona: fitted.persona,
      register: { ...manner.register, ...styleNow },
      texture: manner.texture,
      affectText: fitted.mood,
      memories: fitted.memories,
      facts: fitted.facts,
      summary: fitted.summary,
      history: fitted.history,
      detail: fitted.detail,
      text: input,
    });

    // 5) 模型  6) 解析（模型挂了也要能回一句）
    let raw;
    try {
      raw = await model.chat(messages, { json: true });
    } catch {
      const fallback = '……我这边卡了一下，你刚说什么？';
      shortterm.add(id, 'user', input);
      shortterm.add(id, 'assistant', JSON.stringify({ reply: fallback }));
      return {
        reply: fallback,
        state: affect.get(id),
        memoryIds: [],
        context: { tokens: fitted.tokens, budget: fitted.budget, summary: fitted.summary },
        degraded: true,
      };
    }
    const out = parseModelOutput(raw);
    const reply = sanitizeReply(out.reply);

    // 6.5) 模型偶尔漏掉 state/memory：补一次轻量提取，保证记忆和情绪不断档
    let state = out.state;
    let mem = out.memory;
    if (!state || !mem) {
      try {
        const extra = await model.chat(
          [
            {
              role: 'system',
              content:
                '你是状态提取器。根据一轮对话输出 JSON：' +
                '{"state":{"mood":0,"energy":0,"affection":0},' +
                '"memory":{"episode":"≤40字","people":[],"topics":[],"valence":0,"arousal":0,"importance":3,"entities":[],"relations":[],"facts":[]}}。只输出 JSON。',
            },
            { role: 'user', content: `对方：${input}\n你：${reply}` },
          ],
          { json: true },
        );
        const parsed = parseModelOutput(extra);
        state = state || parsed.state;
        mem = mem || parsed.memory;
      } catch {
        /* 提取失败不影响回复 */
      }
    }

    let memoryIds = [];
    let changed = false;

    // 情绪：模型自报的 state 照单全收（affect 内部钳制）；valence 只补情绪标签和小幅心情
    const rawV = mem && mem.valence != null ? Number(mem.valence) || 0 : null;
    const v = rawV == null ? null : Math.max(-1, Math.min(1, Math.abs(rawV) > 1 ? rawV / 5 : rawV));
    if (state) {
      let dm = Number(state.mood) || 0;
      // 中性/难受的回合不采信“给自己加心情”，避免一路涨到 100
      if (v != null && dm > 0 && v <= 0) dm = Math.round(v * 4);
      // 单轮上限：往下降得动，往上一次最多 +3
      dm = Math.max(-6, Math.min(3, dm));
      let de = (Number(state.energy) || 0) * 0.5;
      de = Math.max(-5, Math.min(1, de));
      const da = Number(state.affection) || 0;
      affect.apply(id, { mood: dm, energy: de, affection: da }, 'llm');
      changed = true;
    } else if (v != null) {
      affect.apply(id, { mood: Math.round(v * 4), energy: 0, affection: v >= 0.4 ? 1 : 0 }, 'llm');
      changed = true;
    }
    if (v != null) {
      const label = v >= 0.5 ? '开心' : v >= 0.15 ? '松快' : v <= -0.5 ? '低落' : v <= -0.15 ? '有点闷' : '平静';
      const a = Number(mem?.arousal);
      const intensity = Math.max(5, Math.min(100, Math.round((Number.isFinite(a) ? a : 0.4) * 100)));
      affect.setEmotion(id, label, intensity);
      changed = true;
    }

    // 7) 落库
    const hasMem = mem && (mem.episode || mem.detail || mem.facts?.length || mem.entities?.length || mem.people?.length);
    if (hasMem) {
      const written = memory.write(id, mem);
      if (written?.id) memoryIds = [written.id];
      changed = true;
    }
    if (changed) cache.invalidate(id);

    // 8) 表情：emoji 按情绪补，表情包偶尔发（微信里以图片形式发）
    const emo = affect.get(id).emotion;
    const finalReply = appendEmoji(reply, { label: emo.label, chance: Math.min(0.5, manner.texture.emoji) });
    const picked = sticker.maybe({ label: emo.label, intensity: emo.intensity, chance: 0.2 });

    // 9) 写回短对话（assistant 存成同款 JSON，json_object 模式下模型才不犯迷糊）
    shortterm.add(id, 'user', input);
    shortterm.add(id, 'assistant', JSON.stringify({ reply: finalReply }));

    return {
      reply: finalReply,
      sticker: picked,
      state: affect.get(id),
      memoryIds,
      sessionEpoch: getEpoch(id),
      context: { tokens: fitted.tokens, budget: fitted.budget, summary: fitted.summary },
    };
  }

  // 衰减调度：启动跑一次，之后每 30 分钟一次；不阻止进程退出
  function decayAll(at = now()) {
    let changed = 0;
    for (const { contact_id: cid } of db.prepare('SELECT contact_id FROM persons').all()) {
      try {
        const n = memory.decay(cid, at);
        if (n > 0) {
          changed += n;
          cache.invalidate(cid);
        }
      } catch {
        /* 单条坏数据不影响整体 */
      }
    }
    return changed;
  }
  try {
    decayAll();
  } catch {
    /* 启动时衰减失败不阻塞 */
  }
  const decayTimer = setInterval(() => {
    try {
      decayAll();
    } catch {
      /* ignore */
    }
  }, 30 * 60 * 1000);
  decayTimer.unref?.();

  return { handle, db, affect, style, memory, shortterm, cache, persona: personaText, decayAll };
}
