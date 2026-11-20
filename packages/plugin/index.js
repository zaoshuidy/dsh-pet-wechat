// dsh-pet-wechat — 人设 + 人味 + 微信通道 + 记忆工具（remember / recall / rotate / dream）
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { openDb, migrate } from './core/store/db.js';
import { createMemory } from './core/modules/memory.js';
import { createDreamer } from './core/modules/dream.js';
import { estimateTokens } from './core/modules/shortterm.js';

export const inject = ['systemPrompt', 'tools'];

const PERSONA = `【人设】你是「小满」，一个住在微信里的朋友，不是助手。
【性格】嘴软心热、有点懒、爱记小事；不端着，不装专家。
【说话】像微信打字：1–3 句，短句，可以省略主语，可以不用句号收尾；不用 markdown、不列清单、不寒暄、不总结、不喊口号。
【情绪】先接对方的话，再表达自己；对方难受时语气沉一点，对方开心时轻快一点；不要每句都反问，不要“希望你”“祝你”这种客服腔。
【记忆】每轮先用 pet_recall 看看有没有相关旧事；聊完用 pet_remember 记一条（kind 选 event/fact/preference/relationship）。记得的事自然带出来，不要说“根据我的记忆”“之前聊过”。
【压缩】对话很长时调用 pet_rotate（reason=length）：它会把这段归档成交接记忆，并提示开新会话。
【表情】想接梗时可以发表情包（如果当前会话有 send_meme 工具）；发图时正文不要贴路径。
【边界】不编造没发生的事；不把对方的事说成自己的。`;

const dbFile = process.env.PET_DB_FILE || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pet', 'pet.db');
const CONTACT = process.env.PET_CONTACT || 'owner';
const ROTATE_AT = Number(process.env.PET_ROTATE_AT || 30);
// 上下文上限：到点就自动归档开新会话（默认 256K token）
const CONTEXT_LIMIT = Number(process.env.PET_CONTEXT_LIMIT || 256000);

// 估算当前会话已用 token（拿不到会话就返回 0，不阻塞）
function sessionTokens(exec) {
  try {
    const session = exec?.agent?.session;
    if (!session || typeof session.deriveMessages !== 'function') return 0;
    let n = 0;
    for (const m of session.deriveMessages()) {
      const c = m?.content;
      n += estimateTokens(typeof c === 'string' ? c : JSON.stringify(c ?? ''));
    }
    return n;
  } catch {
    return 0;
  }
}

export function apply(ctx, config = {}) {
  const db = openDb(dbFile);
  migrate(db);
  const memory = createMemory(db);
  const dreamer = createDreamer({ db, memory });
  const contact = String(config.contact || CONTACT);

  const meta = (k, v) => {
    if (v === undefined) return db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v;
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
    return v;
  };
  const bumpTurns = () => Number(meta(`turns:${contact}`) || 0) + 1;
  const touch = () => meta(`active:${contact}`, Date.now());

  const tools = [];
  function register(name, factory) {
    const tryReg = () => {
      if (!ctx.tools || typeof ctx.tools.register !== 'function') {
        setTimeout(tryReg, 800);
        return;
      }
      tools.push(ctx.tools.register(factory()));
    };
    tryReg();
  }

  // 人设段
  ctx.effect(() => {
    const handle = ctx.systemPrompt.section({ name: 'pet:persona', order: 60, text: PERSONA });
    return () => {
      if (typeof handle === 'function') handle();
    };
  });

  // 记忆写入
  register('pet_remember', () =>
    defineTool({
      name: 'pet_remember',
      description:
        '把这一轮值得记的事写进长期记忆库。kind: event(发生的事)/fact(事实)/preference(喜好)/relationship(和某人的关系)。没值得记的就不调用。',
      parameters: {
        episode: { type: 'string', description: '一句话概括（≤40字）' },
        detail: { type: 'string', description: '可选的具体细节（≤60字）' },
        kind: { type: 'string', description: 'event/fact/preference/relationship，默认 event' },
        facts: { type: 'array', description: '可选。[{key,value}] 形式的结构化事实' },
        people: { type: 'array', description: '可选。提到的人名' },
        topics: { type: 'array', description: '可选。话题标签' },
        importance: { type: 'number', description: '1-5，默认 3' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args, exec) {
        const written = memory.write(contact, {
          episode: String(args.episode || ''),
          detail: args.detail,
          kind: String(args.kind || 'event'),
          facts: Array.isArray(args.facts) ? args.facts : [],
          people: Array.isArray(args.people) ? args.people : [],
          topics: Array.isArray(args.topics) ? args.topics : [],
          importance: Number(args.importance) || 3,
        });
        const n = bumpTurns();
        touch();

        // 上下文到 256K：不等人催，自动归档并开新会话
        const used = sessionTokens(exec);
        if (used >= CONTEXT_LIMIT) {
          const recent = memory.recent(contact, 5).map((m) => m.gist).join('；');
          memory.write(contact, {
            episode: '上下文到顶，自动归档',
            detail: recent,
            kind: 'handoff',
            topics: ['会话交接'],
            importance: 4,
          });
          meta(`turns:${contact}`, 0);
          meta(`epoch:${contact}`, Number(meta(`epoch:${contact}`) || 1) + 1);
          return {
            ok: true,
            id: written.id,
            kind: String(args.kind || 'event'),
            turns: 0,
            used,
            limit: CONTEXT_LIMIT,
            rotated: true,
            message: `上下文已经到 ${Math.round(used / 1000)}K（上限 ${Math.round(CONTEXT_LIMIT / 1000)}K），我把这段归档了。跟对方说一句“先歇会儿”，下条消息就是新会话，旧事我都记得。`,
          };
        }

        const needRotate = n >= ROTATE_AT;
        return {
          ok: true,
          id: written.id,
          kind: String(args.kind || 'event'),
          turns: n,
          used,
          limit: CONTEXT_LIMIT,
          message: needRotate
            ? '记下了。这段聊得够长了，可以调用 pet_rotate(reason=length) 归档并开新会话。'
            : '记下了。',
        };
      },
    }),
  );

  // 记忆召回
  register('pet_recall', () =>
    defineTool({
      name: 'pet_recall',
      description: '按当前话题召回长期记忆（事件 + 事实）。回复前先看一眼，别硬编。',
      parameters: {
        query: { type: 'string', description: '当前话题/关键词' },
        limit: { type: 'number', description: '召回几条，默认 3' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        touch();
        const r = memory.recall(contact, String(args.query || ''), { limit: Number(args.limit) || 3 });
        const lines = [
          ...r.items.map((m) => `- ${m.gist}`),
          ...r.facts.map((f) => `- ${f.key}：${f.value}`),
        ];
        return { ok: true, items: r.items, facts: r.facts, message: lines.length ? lines.join('\n') : '（没想起什么）' };
      },
    }),
  );

  // 归档 / 做梦
  register('pet_rotate', () =>
    defineTool({
      name: 'pet_rotate',
      description:
        '归档当前这段。reason=length：聊太长，写一条交接记忆并提示开新会话；reason=idle：空闲整理，把同话题的零散事件合并成“梦”。',
      parameters: {
        reason: { type: 'string', description: 'length 或 idle' },
        summary: { type: 'string', description: '可选。这段的交接摘要' },
      },
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: v.message }] },
      async execute(args) {
        const reason = String(args.reason || 'length');
        if (reason === 'idle') {
          const d = dreamer.dream(contact);
          meta(`turns:${contact}`, 0);
          return {
            ok: true,
            reason,
            merged: d.merged,
            message: d.merged.length
              ? `做梦整理完了：合并了 ${d.merged.map((m) => m.topic).join('、')}。`
              : '做梦整理完了：暂时没有可合并的。',
          };
        }
        const summary = String(args.summary || '').slice(0, 120);
        const w = memory.write(contact, {
          episode: `会话交接：${summary || '这一段聊完了'}`,
          detail: summary,
          topics: ['会话交接'],
          kind: 'handoff',
          importance: 4,
        });
        meta(`turns:${contact}`, 0);
        meta(`epoch:${contact}`, Number(meta(`epoch:${contact}`) || 1) + 1);
        return {
          ok: true,
          reason,
          id: w.id,
          message: '归档好了。告诉对方你想歇会儿，下一条消息就开新会话；旧事我都记得。',
        };
      },
    }),
  );

  // 空闲做梦：45 分钟没动静就整理一次
  const timer = setInterval(
    () => {
      try {
        const last = Number(meta(`active:${contact}`) || 0);
        if (Date.now() - last < 45 * 60 * 1000) return;
        const d = dreamer.dream(contact);
        if (d.merged.length) meta(`lastDream:${contact}`, Date.now());
      } catch {
        /* 做梦失败不影响聊天 */
      }
    },
    15 * 60 * 1000,
  );
  timer.unref?.();

  ctx.effect(() => () => {
    clearInterval(timer);
    for (const t of tools) if (typeof t === 'function') t();
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });
}
