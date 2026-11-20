// src/core/llm.js — mock / OpenAI 兼容；主对话走 JSON 输出
function mockReply(messages, json) {
  const sys = String(messages.find((m) => m.role === 'system')?.content || '');
  const text = String(messages.at(-1)?.content ?? '');

  // 压缩任务：回事实串，不提“聊天/摘要”
  if (sys.startsWith('把这段对话整理成')) {
    const keys = ['加班', '报表', '老周', '猫', '早起'].filter((k) => text.includes(k));
    return keys.length ? `${keys.join('；')}。` : '日常闲聊。';
  }

  const t = text.replace(/[\r\n"]/g, ' ').trim().slice(0, 20);
  const payload = {
    reply: t ? `嗯，我在听。你说「${t}」，我记着呢。` : '嗯，我在。',
    state: { mood: 3, energy: -1, affection: 1 },
    memory: {
      episode: t || '随口聊了两句',
      people: [],
      topics: [],
      valence: 0.2,
      arousal: 0.4,
      importance: 2,
      entities: [{ type: 'topic', name: '加班' }],
      relations: [],
      facts: [{ key: '最近状态', value: '有点累' }],
    },
  };
  if (json) return JSON.stringify(payload);
  return `${payload.reply}\n[state]${JSON.stringify(payload.state)}[/state]\n[memory]${JSON.stringify(payload.memory)}[/memory]`;
}

export function createLlm(cfg = {}) {
  const mode = cfg.mode || 'mock';
  const json = cfg.json !== false;

  async function chat(messages, opts = {}) {
    if (mode === 'mock') return mockReply(messages, opts.json ?? json);

    const base = String(cfg.baseURL || '').replace(/\/+$/, '');
    if (!base) throw new Error('llm.baseURL 未配置');
    const body = {
      model: cfg.model || 'deepseek-chat',
      messages,
      temperature: cfg.temperature ?? 0.8,
      max_tokens: cfg.maxTokens ?? 400,
    };
    if (opts.json ?? json) body.response_format = { type: 'json_object' };

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 30000),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  return { chat, mode };
}
