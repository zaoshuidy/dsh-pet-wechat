// cli.js — 本地 REPL：node cli.js
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createPet } from './src/index.js';
import { createLlm } from './src/core/llm.js';
import { loadConfig } from './src/core/config.js';

const cfg = loadConfig();
const pet = createPet({
  dbFile: process.env.PET_DB || 'D:/dsh/pet/data/pet.db',
  llm: createLlm(cfg),
});

console.log(`（模型：${cfg.mode === 'api' ? cfg.model : 'mock'}，Ctrl+C 退出）`);

const rl = createInterface({ input, output });
console.log('（输入内容开始聊，Ctrl+C 退出）');
while (true) {
  const line = await rl.question('你> ');
  if (!line.trim()) continue;
  const out = await pet.handle('owner', line);
  console.log(`她> ${out.reply}\n`);
}
