// server.js — 本地测试页：node server.js 后开 http://127.0.0.1:7799
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPet } from './src/index.js';
import { createLlm } from './src/core/llm.js';
import { loadConfig } from './src/core/config.js';

const PORT = Number(process.env.PET_PORT || 7799);
const STICKER_DIR = fileURLToPath(new URL('./assets/memes/dafeiyu-001', import.meta.url));
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const cfg = loadConfig();
const pet = createPet({
  dbFile: process.env.PET_DB || 'D:/dsh/pet/data/pet.db',
  llm: createLlm(cfg),
});

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>小满</title>
<style>
  :root{--bg:#f6f4ef;--fg:#2b2a27;--sub:#8a857c;--me:#d8ead3;--her:#fff;--line:#e6e1d8}
  @media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e9e6df;--sub:#8d8880;--me:#2d4a2c;--her:#242424;--line:#2e2e2e}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
       display:flex;flex-direction:column;height:100dvh}
  header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;font-weight:600}
  .dot{width:8px;height:8px;border-radius:50%;background:#7bbf6a}
  main{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:10px}
  .row{display:flex}.row.me{justify-content:flex-end}
  .b{max-width:78%;padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-break:break-word}
  .her .b{background:var(--her);border:1px solid var(--line);border-bottom-left-radius:5px}
  .me .b{background:var(--me);border-bottom-right-radius:5px}
  footer{padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--line);display:flex;gap:8px}
  textarea{flex:1;resize:none;height:44px;padding:11px 12px;border-radius:12px;border:1px solid var(--line);
           background:var(--her);color:var(--fg);font:inherit;outline:none}
  button{width:64px;border:0;border-radius:12px;background:#3a3a36;color:#fff;font:inherit}
  button:disabled{opacity:.45}
  .typing{color:var(--sub);font-size:13px;padding-left:2px}
  .sticker{max-width:150px;border-radius:12px;border:1px solid var(--line);align-self:flex-start}
  .sys{color:var(--sub);font-size:13px;text-align:center}
</style></head>
<body>
<header><span class="dot"></span>小满</header>
<main id="m"><div class="sys">说点什么吧</div></main>
<footer>
  <textarea id="t" placeholder="跟她说句话…" autofocus></textarea>
  <button id="s">发送</button>
</footer>
<script>
const m=document.getElementById('m'),t=document.getElementById('t'),s=document.getElementById('s');
function add(cls,text){const r=document.createElement('div');r.className='row '+cls;const b=document.createElement('div');b.className='b';b.textContent=text;r.appendChild(b);m.appendChild(r);m.scrollTop=m.scrollHeight;return b}
async function send(){
  const text=t.value.trim(); if(!text) return;
  t.value=''; s.disabled=true;
  add('me',text);
  const wait=add('typing','…');
  try{
    const r=await fetch('/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
    const d=await r.json();
    wait.parentElement.remove();
    add('her', d.reply || '（没说话）');
    if (d.sticker) {
      const im = document.createElement('img');
      im.className = 'sticker';
      im.src = '/sticker?rel=' + encodeURIComponent(d.sticker.rel);
      m.appendChild(im);
      m.scrollTop = m.scrollHeight;
    }
  }catch(e){ wait.textContent='网络不太顺，再说一次？'; }
  s.disabled=false; t.focus();
}
s.onclick=send;
t.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()} });
</script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && req.url.startsWith('/sticker')) {
    const rel = new URL(req.url, 'http://x').searchParams.get('rel') || '';
    const safe = /^memes\/[a-z0-9_-]+\/[a-z0-9._-]+$/i.test(rel);
    const file = safe ? join(STICKER_DIR, rel) : '';
    if (!file || !existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    return res.end(readFileSync(file));
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, model: cfg.model }));
  }
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 32 * 1024) req.destroy();
    });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body || '{}');
        const out = await pet.handle('owner', text);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ reply: out.reply, sticker: out.sticker, state: out.state }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`pet server: http://127.0.0.1:${PORT}  model=${cfg.mode === 'api' ? cfg.model : 'mock'}`);
});
