// test/unit-session.mjs — 跨对话持久化 + 长对话压缩 + 压缩到点自动开新会话
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPet } from '../src/index.js';
import { createLlm } from '../src/core/llm.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'pet-s-'));
const mock = () => createLlm({ mode: 'mock' });

test('跨对话：关掉进程再打开，记忆还在', async () => {
  const dbFile = join(tmp(), 'cross.db');
  const p1 = createPet({ dbFile, llm: mock() });
  p1.memory.write('owner', { episode: '养了只猫叫豆豆', topics: ['猫'], entities: [{ type: 'thing', name: '豆豆' }] });
  p1.db.close();

  const p2 = createPet({ dbFile, llm: mock() });
  const r = p2.memory.recall('owner', '豆豆');
  assert.ok(r.items.length >= 1, '重开后应该还能召回');
  assert.match(r.items[0].gist, /豆豆/);
  p2.db.close();
});

test('长对话：超限压缩，摘要不留痕', async () => {
  const pet = createPet({ dbFile: join(tmp(), 'long.db'), llm: mock(), maxTurns: 3 });
  for (let i = 0; i < 8; i += 1) {
    const out = await pet.handle('owner', `第${i}句：今天加班，老周催表`);
    assert.ok(!/摘要|之前聊过|根据记忆/.test(out.reply));
  }
  assert.ok(pet.shortterm.summary('owner').length > 0, '应有会话摘要');
  assert.ok(pet.shortterm.all('owner').length <= 6, '原文应收敛');
});

test('压缩到点：自动开新会话，并继承交接记忆', async () => {
  const pet = createPet({ dbFile: join(tmp(), 'rotate.db'), llm: mock(), maxTurns: 2, rotateAfter: 1 });

  await pet.handle('owner', '我叫阿伟，养了只猫叫豆豆，在城南上班');
  for (let i = 0; i < 6; i += 1) {
    await pet.handle('owner', `继续聊第${i}句，今天又是加班`);
  }

  const last = await pet.handle('owner', '我回来了');
  assert.ok(last.sessionEpoch >= 2, `应该开过新会话，epoch=${last.sessionEpoch}`);
  assert.ok(pet.shortterm.all('owner').length <= 4, '新会话只保留很少原文');

  const handoff = pet.db.prepare("SELECT COUNT(*) c FROM memories WHERE topics LIKE '%会话交接%'").get().c;
  assert.ok(handoff >= 1, '应写一条交接记忆');

  const recall = pet.memory.recall('owner', '豆豆');
  assert.ok(recall.items.length >= 1, '换会话后仍记得旧事');
});
