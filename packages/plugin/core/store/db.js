import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_URL = new URL('./schema.sql', import.meta.url);

export const now = () => Date.now();

// 打开库：先递归建目录，再开 DatabaseSync，切换 WAL。
export function openDb(file) {
  const dir = dirname(file);
  if (dir) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

// 执行同目录 schema.sql（幂等），并把 schema_version 写进 meta。
export function migrate(db) {
  const sql = readFileSync(SCHEMA_URL, 'utf8');
  db.exec(sql);
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema_version', '1');
  return db;
}
