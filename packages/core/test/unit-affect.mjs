// test/unit-affect.mjs — 情绪链路：模型 state 必须生效、标签要落地、坏 JSON 要兜底
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPet } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pet-a-'));
const stub = (payload) => ({ mode: 'x', chat: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) });

test('模型给 state 就按 state 改：心情升、精力降、好感可下降', async () => {
  const pet = createPet({
    dbFile: join(tmp(), 'a.db'),
    llm: stub({ reply: '嗯', state: { mood: 5, energy: -8, affection: -2 }, memory: { episode: '测试', valence: 0.5 } }),
  });
  const out = await pet.handle('owner', '随便说点');
  assert.equal(out.state.mood, 53);
  assert.ok(out.state.energy < 50, `精力应下降，实际 ${out.state.energy}`);
  assert.ok(out.state.affection < 20, `好感应下降，实际 ${out.state.affection}`);
});

test('valence 决定情绪标签', async () => {
  for (const [v, want] of [
    [0.9, '开心'],
    [-0.9, '低落'],
    [0, '平静'],
  ]) {
    const pet = createPet({
      dbFile: join(tmp(), `v${v}.db`),
      llm: stub({ reply: '嗯', state: { mood: 0, energy: 0, affection: 0 }, memory: { episode: '测试', valence: v, arousal: 0.7 } }),
    });
    const out = await pet.handle('owner', '嗯');
    assert.equal(out.state.emotion.label, want);
    assert.ok(out.state.emotion.intensity > 0);
  }
});

test('截断的 JSON 不能原样发给用户', async () => {
  const pet = createPet({ dbFile: join(tmp(), 'bad.db'), llm: stub('{"reply":"嗯，我在听，你说的是') });
  const out = await pet.handle('owner', '你好');
  assert.ok(out.reply.length > 0);
  assert.ok(!out.reply.includes('"reply"'), `回复里漏了 JSON 残片：${out.reply}`);
  assert.ok(!out.reply.startsWith('{'));
});

test('只有 state/memory、没有 reply 时也要回一句', async () => {
  const pet = createPet({
    dbFile: join(tmp(), 'noreply.db'),
    llm: stub({ state: { mood: 1, energy: 0, affection: 0 }, memory: { episode: '测试' } }),
  });
  const out = await pet.handle('owner', '在吗');
  assert.ok(out.reply.length > 0, '不能返回空回复');
});
