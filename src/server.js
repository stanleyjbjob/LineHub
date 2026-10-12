import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { verifySignature } from './line/signature.js';
import { toPublicMessage } from './processors/forward-webhook.js';
import { localDate } from './summary/time.js';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public');
const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
};

export function createServer({ config, store, ingestor, summarizer, bus = new EventEmitter(), logger = console }) {
  const sseClients = new Set();
  for (const name of ['message', 'unsend', 'alert', 'summary']) {
    bus.on(name, (data) => {
      const payload = `event: ${name}\ndata: ${JSON.stringify(name === 'message' ? toPublicMessage(data) : data)}\n\n`;
      for (const res of sseClients) res.write(payload);
    });
  }

  const routes = {
    'GET /healthz': () => json(200, { ok: true }),
    'POST /webhook': async (req) => {
      const raw = await readBody(req);
      if (!verifySignature(config.channelSecret, raw, req.headers['x-line-signature'])) {
        logger.warn('[webhook] invalid signature');
        return json(401, { error: 'invalid signature' });
      }
      const body = JSON.parse(raw.toString('utf8'));
      // 先回 200 再處理，避免 LINE 端逾時重送；事件以 webhookEventId 去重
      setImmediate(() => ingestor.handleWebhook(body).catch((e) => logger.error('[webhook]', e)));
      return json(200, { ok: true });
    },
    'GET /api/stats': () => json(200, store.stats()),
    'GET /api/sources': () => json(200, store.listSources()),
    'GET /api/messages': (req, url) => json(200, store.listMessages({
      sourceId: url.searchParams.get('sourceId') || undefined,
      q: url.searchParams.get('q') || undefined,
      type: url.searchParams.get('type') || undefined,
      before: url.searchParams.get('before') || undefined,
      limit: url.searchParams.get('limit') || undefined,
    }).map(toPublicMessage)),
    'GET /api/members': (req, url) => json(200, store.listMembers(url.searchParams.get('sourceId'))),
    'GET /api/alerts': () => json(200, store.listAlerts()),
    'GET /api/events': () => json(200, store.listEvents()),
    'GET /api/summaries': (req, url) => json(200, {
      enabled: Boolean(summarizer?.enabled),
      summaries: store.listSummaries({
        sourceId: url.searchParams.get('sourceId') || undefined,
        limit: url.searchParams.get('limit') || undefined,
      }),
    }),
    // 手動產生摘要：{ sourceId?, date?, force?, push? }；未指定 sourceId 則處理當天所有群組
    'POST /api/summaries/run': async (req) => {
      if (!summarizer?.enabled) return json(400, { error: '未設定 ANTHROPIC_API_KEY，摘要功能停用' });
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      const date = body.date || localDate(Date.now(), config.summaryTz);
      const opts = { force: Boolean(body.force), push: Boolean(body.push) };
      const result = body.sourceId
        ? [await summarizer.summarize(body.sourceId, date, opts)]
        : await summarizer.runDaily(date, opts);
      return json(200, { date, results: result });
    },
    'GET /api/stream': (req, url, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return null;
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const isProtected = url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/');
      if (isProtected && !authorized(req, url, config.adminToken)) return send(res, json(401, { error: 'unauthorized' }));

      const handler = routes[`${req.method} ${url.pathname}`];
      if (handler) {
        const out = await handler(req, url, res);
        return out && send(res, out);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
        return serveFile(res, path.resolve(config.mediaDir), url.pathname.slice('/media/'.length));
      }
      if (req.method === 'GET') {
        return serveFile(res, PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      }
      send(res, json(404, { error: 'not found' }));
    } catch (err) {
      logger.error('[http]', err);
      send(res, json(err.status || 500, { error: err.status ? err.message : 'internal error' }));
    }
  });
  server.on('close', () => { for (const r of sseClients) r.end(); });
  return server;
}

function authorized(req, url, token) {
  if (!token) return true;
  // EventSource 與 <img> 無法帶 header，故允許 ?token=
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveFile(res, root, rel) {
  const file = path.resolve(root, decodeURIComponent(rel));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, json(404, { error: 'not found' }));
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const json = (status, body) => ({ status, body });
function send(res, { status, body }) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
