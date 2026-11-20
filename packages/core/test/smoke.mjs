// test/smoke.mjs — V0.1 验收：能聊、能记、能漂移、超限会压缩、召回毫秒级
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPet } from '../src/index.js';
import { createLlm } from '../src/core/llm.js';

function freshPet(name) {
  const dir = mkdtempSync(join(tmpdir(), `pet-${name}-`));
  return createPet({ dbFile: join(dir, `${name}.db`), llm: createLlm({ mode: 'mock' }) });
}

test('V0.1 冒烟：能聊、能记、能漂移', async () => {
  const pet = freshPet('basic');

  const r1 = await pet.handle('owner', '今天好累，加班到十点');
  assert.ok(r1.reply.length > 0, 'reply 非空');
  assert.ok(!r1.reply.includes('[state]'), 'reply 不含 state 块');
  assert.ok(!r1.reply.includes('[memory]'), 'reply 不含 memory 块');

  const r2 = await pet.handle('owner', '明天还要早起');
  const r3 = await pet.handle('owner', '老周又催我交表');
  assert.ok(r2.reply && r3.reply);

  const mem = pet.db.prepare('SELECT COUNT(*) AS c FROM memories').get().c;
  assert.ok(mem >= 3, `memories=${mem}`);

  const ent = pet.db.prepare('SELECT COUNT(*) AS c FROM entities').get().c;
  assert.ok(ent >= 1, `entities=${ent}`);

  const dims = pet.db.prepare("SELECT COUNT(*) AS c FROM style WHERE contact_id='owner'").get().c;
  assert.equal(dims, 6, `style dims=${dims}`);

  const before = pet.style.current('owner').dims.sentenceLen;
  for (let i = 0; i < 5; i += 1) {
    pet.style.observe('owner', '哈哈哈哈真的太棒了！！！你也快来嘛～');
  }
  const after = pet.style.current('owner').dims.sentenceLen;
  const row = pet.db
    .prepare("SELECT base, min, max FROM style WHERE contact_id='owner' AND dim='sentenceLen'")
    .get();
  assert.ok(after >= row.min - 1e-9 && after <= row.max + 1e-9, '漂移不越界');
  assert.notEqual(after, before, '漂移有变化');

  if (typeof pet.db.close === 'function') pet.db.close();
});

test('记忆：超限压缩 + 上下文不越预算', async () => {
  const pet = freshPet('budget');
  const long = '今天加班到十点，老周又催我交表，我有点烦，但也没办法。'.repeat(5);

  for (let i = 0; i < 20; i += 1) {
    await pet.handle('owner', `${long}#${i}`);
  }

  const out = await pet.handle('owner', '还在吗');
  assert.ok(out.context, '返回上下文用量');
  assert.ok(out.context.tokens <= out.context.budget, `tokens=${out.context.tokens} budget=${out.context.budget}`);
  assert.ok(pet.shortterm.summary('owner').length > 0, '产生了会话摘要');
  assert.ok(pet.shortterm.all('owner').length <= 20, `短对话未收敛：${pet.shortterm.all('owner').length}`);
  assert.ok(out.reply.length > 0);

  if (typeof pet.db.close === 'function') pet.db.close();
});

test('召回：命中且毫秒级', async () => {
  const pet = freshPet('latency');
  for (let i = 0; i < 30; i += 1) {
    await pet.handle('owner', `第 ${i} 次聊到加班、老周、报表和猫，心情一般。`);
  }

  pet.memory.recall('owner', '老周 报表'); // 预热缓存
  const t0 = performance.now();
  let hits = 0;
  for (let i = 0; i < 20; i += 1) {
    const r = pet.memory.recall('owner', '老周又催报表了');
    hits += r.items.length;
  }
  const avg = (performance.now() - t0) / 20;
  assert.ok(hits > 0, '有召回结果');
  assert.ok(avg < 20, `平均召回 ${avg.toFixed(2)}ms`);

  if (typeof pet.db.close === 'function') pet.db.close();
});
