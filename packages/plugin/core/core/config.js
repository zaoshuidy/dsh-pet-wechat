// src/core/config.js — 读取运行配置（key 只从环境或本机凭据文件拿，不落日志）
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CRED_NAME = 'DEEPSEEK_API_KEY';

export function readKeyFromCredentials(name = CRED_NAME) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const file = join(home, '.credentials.yaml');
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf8');
    const re = new RegExp(`^\\s*${name}\\s*:\\s*["']?([^"'\\s]+)`, 'm');
    const m = text.match(re);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function loadConfig(env = process.env) {
  const apiKey = env.DEEPSEEK_API_KEY || readKeyFromCredentials();
  const mode = env.PET_LLM || (apiKey ? 'api' : 'mock');
  return {
    mode,
    baseURL: env.PET_BASE_URL || 'https://api.deepseek.com/v1',
    model: env.PET_MODEL || 'deepseek-chat',
    apiKey: apiKey || '',
    temperature: Number(env.PET_TEMP || 0.8),
    maxTokens: Number(env.PET_MAX_TOKENS || 200),
  };
}
