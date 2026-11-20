// test/unit-sticker.mjs — 表情包挑选与 emoji 追加
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSticker } from '../src/modules/sticker.js';
import { appendEmoji, pickEmoji } from '../src/modules/emoji.js';

const DIR = fileURLToPath(new URL('../assets/memes/dafeiyu-001', import.meta.url));
// 图库不随仓库分发（授权原因）：没有图库时跳过，而不是让整套测试红
const HAS_PACK = existsSync(join(DIR, 'index.db'));

test('图库可读，六个情绪桶里至少 happy', { skip: !HAS_PACK }, () => {
  const s = createSticker({ dir: DIR });
  assert.equal(s.available, true);
  assert.ok(s.tags.includes('happy'), `tags=${s.tags}`);
});

test('按情绪挑图，返回的文件真实存在', { skip: !HAS_PACK }, () => {
  const s = createSticker({ dir: DIR, rng: () => 0 });
  const hit = s.pick({ label: '开心' });
  assert.ok(hit);
  assert.equal(hit.tag, 'happy');
  assert.ok(existsSync(join(DIR, hit.rel)), `缺文件 ${hit.rel}`);
  assert.ok(hit.caption.length > 0);
});

test('情绪太弱不发图', { skip: !HAS_PACK }, () => {
  const s = createSticker({ dir: DIR, rng: () => 0 });
  assert.equal(s.maybe({ label: '开心', intensity: 5, chance: 1 }), null);
  assert.ok(s.maybe({ label: '开心', intensity: 80, chance: 1 }));
});

test('未知情绪落到已有桶，不返回空', { skip: !HAS_PACK }, () => {
  const s = createSticker({ dir: DIR, rng: () => 0 });
  const hit = s.pick({ label: '某种没见过的情绪' });
  assert.ok(hit && hit.rel);
});

test('emoji：按情绪补一个，已有 emoji 不重复加', () => {
  assert.ok(pickEmoji('开心', () => 0).length > 0);
  const out = appendEmoji('好耶', { label: '开心', chance: 1, rng: () => 0 });
  assert.notEqual(out, '好耶');
  assert.equal(appendEmoji('好耶😄', { label: '开心', chance: 1, rng: () => 0 }), '好耶😄');
  assert.equal(appendEmoji('好耶', { label: '', chance: 1, rng: () => 0 }), '好耶');
});
