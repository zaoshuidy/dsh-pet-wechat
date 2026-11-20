// test/unit-dream.mjs — 空闲整理（做梦）与两种压缩分类
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPet } from '../src/index.js';
import { createLlm } from '../src/core/llm.js';
import { createDreamer } from '../src/modules/dream.js';

test('做梦：同话题 ≥3 条合并成一条 kind:dream 记忆', async () => {
  const pet = createPet({ dbFile: join(mkdtempSync(join(tmpdir(), 'pet-d-')), 'd.db'), llm: createLlm({ mode: 'mock' }) });
  for (let i = 0; i < 4; i += 1) {
    pet.memory.write('owner', { episode: `第${i}次聊加班`, topics: ['加班'], importance: 3 });
  }
  const dreamer = createDreamer({ db: pet.db, memory: pet.memory });
  const out = dreamer.dream('owner');
  assert.ok(out.merged.some((m) => m.topic === '加班'), JSON.stringify(out.merged));

  const n = pet.db.prepare("SELECT COUNT(*) c FROM memories WHERE topics LIKE '%kind:dream%'").get().c;
  assert.ok(n >= 1, '应写入梦境记忆');
});

test('两类压缩：强制（长度）与空闲（做梦）互不混淆', async () => {
  const pet = createPet({
    dbFile: join(mkdtempSync(join(tmpdir(), 'pet-d2-')), 'd2.db'),
    llm: createLlm({ mode: 'mock' }),
    maxTurns: 2,
    rotateAfter: 1,
  });
  await pet.handle('owner', '我叫阿伟，养了只猫叫豆豆');
  for (let i = 0; i < 6; i += 1) await pet.handle('owner', `继续第${i}句`);

  const handoff = pet.db.prepare("SELECT COUNT(*) c FROM memories WHERE topics LIKE '%kind:handoff%'").get().c;
  assert.ok(handoff >= 1, '强制压缩应写 kind:handoff');

  const dreamBefore = pet.db.prepare("SELECT COUNT(*) c FROM memories WHERE topics LIKE '%kind:dream%'").get().c;
  assert.equal(dreamBefore, 0, '还没到空闲整理，不该有 dream');

  const dreamer = createDreamer({ db: pet.db, memory: pet.memory });
  dreamer.dream('owner', Date.now() + 3600 * 1000);
  const dreamAfter = pet.db.prepare("SELECT COUNT(*) c FROM memories WHERE topics LIKE '%kind:dream%'").get().c;
  assert.ok(dreamAfter >= 1, '空闲整理应产生 dream');
});
