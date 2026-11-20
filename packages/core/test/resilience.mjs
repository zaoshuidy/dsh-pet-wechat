// test/resilience.mjs — 真人乱聊：断线、硬杀进程、重连后记忆与情绪是否对得上
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 7823;
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = 'D:/dsh/pet';

function startServer(dbFile) {
  return spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: { ...process.env, PET_LLM: 'mock', PET_DB: dbFile, PET_PORT: String(PORT) },
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function waitReady(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('服务没起来');
}

async function chat(text, signal) {
  const r = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  return r.json();
}

async function stop(child, hard) {
  if (!child || child.exitCode !== null) return;
  child.kill(hard ? 'SIGKILL' : 'SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

function inspect(dbFile) {
  const db = new DatabaseSync(dbFile);
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const count = (sql) => db.prepare(sql).get().c;
  const result = {
    integrity: Object.values(integrity)[0],
    memories: count('SELECT COUNT(*) c FROM memories'),
    persons: count('SELECT COUNT(*) c FROM persons'),
    orphans: count(
      'SELECT COUNT(*) c FROM mem_entities me LEFT JOIN memories m ON m.id = me.memory_id WHERE m.id IS NULL',
    ),
    dupIds: count('SELECT COUNT(*) c FROM (SELECT id FROM memories GROUP BY id HAVING COUNT(*) > 1)'),
    badMood: count('SELECT COUNT(*) c FROM persons WHERE mood < 0 OR mood > 100 OR mood IS NULL'),
    badAffection: count('SELECT COUNT(*) c FROM persons WHERE affection < 0 OR affection > 100'),
  };
  db.close();
  return result;
}

test('断线/硬杀/重连：数据不烂、记忆情绪对得上', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-res-'));
  const dbFile = join(dir, 'res.db');
  let child = startServer(dbFile);

  try {
    await waitReady();

    // 1) 正常聊三轮
    await chat('今天加班到十点，烦死了');
    await chat('吃了碗热汤面，好点了');
    const before = (await chat('你还记得豆豆吗')).state;
    assert.ok(before.mood >= 0 && before.mood <= 100);

    // 2) 客户端中途断线（请求已发出，人走了）
    const ac = new AbortController();
    const inflight = chat('这句发一半我就断线', ac.signal).catch(() => null);
    setTimeout(() => ac.abort(), 25);
    await inflight;

    // 3) 并发打 20 条，然后硬杀进程（模拟关服务/断电）
    const burst = Array.from({ length: 20 }, (_, i) => chat(`并发第${i + 1}句`).catch(() => null));
    await sleep(25);
    await stop(child, true);
    await Promise.all(burst);

    // 4) 杀完先查库
    const afterKill = inspect(dbFile);
    console.log('  杀进程后:', JSON.stringify(afterKill));
    assert.equal(afterKill.integrity, 'ok', `完整性=${afterKill.integrity}`);
    assert.equal(afterKill.orphans, 0, '有孤儿关联');
    assert.equal(afterKill.dupIds, 0, '有重复记忆 id');
    assert.equal(afterKill.badMood, 0, '心情越界');
    assert.equal(afterKill.badAffection, 0, '好感越界');

    // 5) 重启，继续聊
    await sleep(300);
    child = startServer(dbFile);
    await waitReady();

    const r1 = await chat('刚才是不是断了');
    assert.ok(r1.reply.length > 0, '重启后要能聊');
    const r2 = await chat('我回来了，接着说');
    const after = r2.state;

    // 6) 记忆与情绪要对得上
    const afterRestart = inspect(dbFile);
    console.log('  重启后  :', JSON.stringify(afterRestart));
    console.log('  情绪    :', `mood ${before.mood} -> ${after.mood}`, `affection ${before.affection} -> ${after.affection}`);
    assert.equal(afterRestart.integrity, 'ok');
    assert.ok(afterRestart.memories >= afterKill.memories, '记忆不能凭空少');
    // 并发 20 条都在给心情加分，重启后只会更高；关键是“没被重置成基线”
    assert.ok(after.mood >= before.mood - 5, `心情不应回落：${before.mood} -> ${after.mood}`);
    assert.ok(after.mood >= 0 && after.mood <= 100);
    assert.ok(after.affection >= before.affection - 5, `好感掉了：${before.affection} -> ${after.affection}`);
    assert.ok(['0', '1', '2', '3'].includes(String(after.stage)));

    // 7) 再软重启一次，确认还能接着聊
    await stop(child, false);
    await sleep(300);
    child = startServer(dbFile);
    await waitReady();
    const r3 = await chat('又重启了一次');
    assert.ok(r3.reply.length > 0);
    const final = inspect(dbFile);
    assert.equal(final.integrity, 'ok');
    assert.ok(final.memories >= afterRestart.memories);
  } finally {
    await stop(child, true);
  }
});
