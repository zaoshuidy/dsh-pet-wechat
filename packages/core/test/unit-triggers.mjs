// test/unit-triggers.mjs — 情绪触发规则
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPet } from '../src/index.js';
import { createLlm } from '../src/core/llm.js';
import { matchTriggers } from '../src/modules/triggers.js';

test('规则匹配：夸、骂、累、晚安', () => {
  assert.deepEqual(matchTriggers('你真好，喜欢你').labels, ['开心']);
  assert.deepEqual(matchTriggers('滚，讨厌').labels, ['生气']);
  assert.deepEqual(matchTriggers('今天好累，又加班').labels, ['低落']);
  assert.deepEqual(matchTriggers('晚安，去睡了').labels, ['平静']);
  assert.equal(matchTriggers('今天天气不错').delta, null);
});

test('同一条最多命中两条，delta 按 0.5 缩放', () => {
  const r = matchTriggers('喜欢你，但是今天好累');
  assert.ok(r.hits.length <= 2);
  const mood = r.delta?.mood ?? 0;
  assert.ok(mood >= -1 && mood <= 1, `mood=${mood}`);
});

test('规则真的改数值：夸一句，好感升、心情升', async () => {
  const pet = createPet({
    dbFile: join(mkdtempSync(join(tmpdir(), 'pet-t-')), 't.db'),
    llm: { mode: 'x', chat: async () => JSON.stringify({ reply: '嗯', state: {}, memory: {} }) },
  });
  const before = pet.affect.get('owner');
  const out = await pet.handle('owner', '你真好，我喜欢你');
  assert.ok(out.state.mood >= before.mood, `mood ${before.mood} -> ${out.state.mood}`);
  assert.ok(out.state.affection > before.affection, `affection ${before.affection} -> ${out.state.affection}`);
  assert.ok(['开心', '松快'].includes(out.state.emotion.label));
});

test('规则不会越界：连骂 30 句，心情不为负、好感不掉穿', async () => {
  const pet = createPet({
    dbFile: join(mkdtempSync(join(tmpdir(), 'pet-t2-')), 't2.db'),
    llm: { mode: 'x', chat: async () => JSON.stringify({ reply: '嗯', state: {}, memory: {} }) },
  });
  for (let i = 0; i < 30; i += 1) await pet.handle('owner', '滚，讨厌，闭嘴');
  const s = pet.affect.get('owner');
  assert.ok(s.mood >= 0 && s.mood <= 100);
  assert.ok(s.affection >= 0);
});
