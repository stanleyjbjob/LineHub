import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { openDb } from '../src/db.js';
import { Ingestor } from '../src/ingest.js';
import { readConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { computeSignature } from '../src/line/signature.js';

async function start(env = {}) {
  const config = readConfig({ LINE_CHANNEL_SECRET: 's3cret', ...env });
  const store = openDb(':memory:');
  const bus = new EventEmitter();
  const ingestor = new Ingestor({ store, line: { enabled: false }, config, bus, logger: { warn() {}, error() {} } });
  const server = createServer({ config, store, ingestor, bus, logger: { warn() {}, error() {} } });
  server.listen(0);
  await once(server, 'listening');
  return { server, bus, base: `http://127.0.0.1:${server.address().port}` };
}

const body = JSON.stringify({
  destination: 'U0',
  events: [{ type: 'message', webhookEventId: 'e1', timestamp: 1, source: { type: 'group', groupId: 'C1', userId: 'U1' }, message: { id: '1', type: 'text', text: '哈囉' } }],
});

test('webhook 驗證簽章並寫入，API 可查詢', async (t) => {
  const { server, bus, base } = await start();
  t.after(() => server.close());

  const bad = await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-line-signature': 'nope' } });
  assert.equal(bad.status, 401);

  const stored = once(bus, 'message');
  const ok = await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-line-signature': computeSignature('s3cret', body) } });
  assert.equal(ok.status, 200);
  await stored;

  const msgs = await (await fetch(`${base}/api/messages?sourceId=C1`)).json();
  assert.equal(msgs[0].text, '哈囉');
  assert.equal((await (await fetch(`${base}/api/sources`)).json())[0].id, 'C1');
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('設定 ADMIN_TOKEN 時 /api 需要授權，webhook 不受影響', async (t) => {
  const { server, base } = await start({ ADMIN_TOKEN: 'tok' });
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/api/stats`)).status, 401);
  assert.equal((await fetch(`${base}/api/stats`, { headers: { Authorization: 'Bearer tok' } })).status, 200);
  assert.equal((await fetch(`${base}/api/stats?token=tok`)).status, 200);
  assert.equal((await fetch(`${base}/media/../package.json?token=tok`)).status, 404);
});
