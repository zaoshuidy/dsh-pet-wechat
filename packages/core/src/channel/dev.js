// src/channel/dev.js — 本地测试通道（不接微信）
import { createServer } from 'node:http';

export function startDevChannel(pet, { port = 7788, host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });

    if (req.method === 'POST' && req.url === '/chat') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', async () => {
        try {
          const { text, contactId = 'owner' } = JSON.parse(body || '{}');
          const out = await pet.handle(contactId, text);
          send(200, { reply: out.reply, state: out.state });
        } catch (err) {
          send(500, { error: String(err?.message || err) });
        }
      });
      return;
    }

    send(404, { error: 'not found' });
  });

  server.listen(port, host);
  return server;
}
