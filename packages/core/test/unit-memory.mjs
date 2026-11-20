// test/unit-memory.mjs — 记忆系统各环节单元测试（写/读/展开/衰减/图/缓存/上下文）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPet } from '../src/index.js';
import { createLlm } from '../src/core/llm.js';
import { createGraph } from '../src/modules/graph.js';
import { createCache } from '../src/modules/cache.js';
import { createShortTerm, estimateTokens } from '../src/modules/shortterm.js';
import { fitContext, DEFAULT_BUDGET } from '../src/core/context.js';
import { openDb, migrate } from '../src/store/db.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pet-u-'));
const petWith = (name, opts = {}) =>
  createPet({ dbFile: join(tmp(), `${name}.db`), llm: createLlm({ mode: 'mock' }), ...opts });
const DAY = 86400000;

test('图：同名去重、别名命中、两跳折扣', () => {
  const db = openDb(join(tmp(), 'g.db'));
  migrate(db);
  const g = createGraph(db);

  const a = g.upsertEntity('c1', { type: 'person', name: '老周', aliases: ['周哥'] });
  const b = g.upsertEntity('c1', { type: 'person', name: '老周' });
  assert.equal(a, b, '同名实体应复用');
  assert.equal(g.findByAlias('c1', '周哥今天又催了').length, 1, '别名应命中');

  const x = g.upsertEntity('c1', { type: 'topic', name: '报表' });
  const y = g.upsertEntity('c1', { type: 'topic', name: '加班' });
  g.link('c1', a, x, 'asks');
  g.link('c1', x, y, 'related');
  const n1 = g.neighbors('c1', a, 1);
  assert.ok(n1.some((n) => n.id === x), '一跳应到报表');
  const n2 = g.neighbors('c1', a, 2);
  const y2 = n2.find((n) => n.id === y);
  assert.ok(y2 && y2.weight <= 0.6 + 1e-9, `两跳权重应折扣，实际 ${y2?.weight}`);
});

test('事实：同 key 改值会留下上一条', () => {
  const pet = petWith('fact');
  pet.memory.write('owner', { episode: '猫叫豆豆', facts: [{ key: '猫名', value: '豆豆' }] });
  pet.memory.write('owner', { episode: '猫改名了', facts: [{ key: '猫名', value: '团团' }] });
  const row = pet.db.prepare("SELECT attrs FROM entities WHERE name='猫名' AND type='fact'").get();
  const attrs = JSON.parse(row.attrs);
  assert.equal(attrs.value, '团团');
  assert.equal(attrs.prev, '豆豆', '应保留上一个值');
});

test('写入：字段裁剪、事实挂实体、记忆可展开', () => {
  const pet = petWith('write');
  const long = '很长的描述'.repeat(30);
  const r = pet.memory.write('owner', {
    episode: long,
    detail: '那天在游乐园买了红色气球',
    topics: ['游乐园'],
    people: ['老周'],
    valence: 0.8,
    importance: 4,
  });
  assert.ok(r.id);
  const row = pet.db.prepare('SELECT gist, detail, detail_level FROM memories WHERE id=?').get(r.id);
  assert.ok(row.gist.length <= 40, 'gist 应截断');
  assert.equal(row.detail_level, 3);
  const ex = pet.memory.expand('owner', r.id);
  assert.match(ex.detail, /红色气球/);
});

test('衰减：7 天压摘要、30 天升章节、180 天只剩标签', () => {
  const pet = petWith('decay');
  const r = pet.memory.write('owner', { episode: '聊了游乐园', detail: '买了红色气球，还坐了旋转木马' });
  const t0 = Date.now();

  assert.equal(pet.memory.decay('owner', t0 + 8 * DAY), 1, '7 天后应处理一条');
  let row = pet.db.prepare('SELECT detail_level, detail FROM memories WHERE id=?').get(r.id);
  assert.equal(row.detail_level, 2);
  assert.ok(row.detail === null || row.detail.length < 40);

  pet.memory.decay('owner', t0 + 31 * DAY);
  row = pet.db.prepare('SELECT level, detail_level FROM memories WHERE id=?').get(r.id);
  assert.equal(row.level, 2);
  assert.equal(row.detail_level, 1);

  pet.memory.decay('owner', t0 + 181 * DAY);
  row = pet.db.prepare('SELECT level FROM memories WHERE id=?').get(r.id);
  assert.equal(row.level, 3);
});

test('衰减调度：启动后能批量跑，并让缓存失效', async () => {
  const pet = petWith('sched');
  await pet.handle('owner', '聊点事');
  const n = pet.decayAll(Date.now() + 40 * DAY);
  assert.ok(n >= 1, '批量衰减应处理到记忆');
  assert.equal(pet.cache.stats().contacts, 0, '衰减后缓存应失效');
});

test('展开：问“具体/哪天”时把细节带进 prompt', async () => {
  const captured = [];
  const llm = {
    chat: async (messages) => {
      captured.push(messages);
      return JSON.stringify({ reply: '嗯', state: {}, memory: { episode: '问了细节' } });
    },
  };
  const pet = createPet({ dbFile: join(tmp(), 'expand.db'), llm, maxTurns: 10 });
  pet.memory.write('owner', {
    episode: '去了游乐园',
    detail: '你给我买了一个红色气球',
    topics: ['游乐园'],
    importance: 4,
  });

  await pet.handle('owner', '那次具体是哪天来着');
  const system = captured[0].map((m) => m.content).join('\n');
  assert.match(system, /红色气球/, '细节应进入 prompt');
});

test('上下文：超预算先砍历史、长文截断', () => {
  const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '很长的历史'.repeat(20) }));
  const out = fitContext({
    persona: '人设'.repeat(300),
    mood: '心情还行',
    memories: Array.from({ length: 10 }, () => ({ gist: '一条记忆'.repeat(10) })),
    facts: [],
    summary: '背景'.repeat(400),
    history,
    text: '超长输入'.repeat(2000),
    budget: DEFAULT_BUDGET,
  });
  assert.ok(out.tokens <= out.budget, `tokens=${out.tokens} budget=${out.budget}`);
  assert.ok(out.history.length < history.length, '历史应被裁剪');
  assert.ok(out.text.length <= 1500, '输入应截断');
});

test('短对话：溢出压缩、摘要不带“聊到/摘要”', () => {
  const st = createShortTerm({ maxTurns: 2, keepVerbatim: 2 });
  for (let i = 0; i < 6; i += 1) {
    st.add('c', 'user', `第${i}句`);
    st.add('c', 'assistant', JSON.stringify({ reply: `回${i}` }));
  }
  assert.ok(st.overflow('c'));
  st.compact('c');
  assert.ok(st.summary('c').length > 0);
  assert.doesNotMatch(st.summary('c'), /摘要|聊到/);
  assert.ok(st.all('c').length <= 4);
});

test('缓存：命中、失效、按联系人隔离', () => {
  const cache = createCache({ maxContacts: 2 });
  cache.set('a', { v: 1 });
  cache.set('b', { v: 2 });
  assert.equal(cache.get('a').v, 1);
  cache.invalidate('a');
  assert.equal(cache.get('a'), null);
  cache.set('c', { v: 3 });
  cache.set('d', { v: 4 });
  assert.ok(cache.stats().contacts <= 2, '上限应生效');
});

test('召回：实体路命中、结果带解释', () => {
  const pet = petWith('retr');
  pet.memory.write('owner', { episode: '老周催报表', topics: ['报表'], entities: [{ type: 'person', name: '老周' }] });
  pet.memory.write('owner', { episode: '周末去爬山', topics: ['爬山'] });
  const r = pet.memory.recall('owner', '老周又来了');
  assert.ok(r.items.length >= 1);
  assert.match(r.items[0].why, /graph|bm25|vec/);
});

test('词数估算：中文与英文比例合理', () => {
  assert.ok(estimateTokens('你好世界') >= 2);
  assert.ok(estimateTokens('hello world') >= 2);
  assert.equal(estimateTokens(''), 0);
});
