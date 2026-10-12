import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openDb } from '../src/db.js';
import { Ingestor } from '../src/ingest.js';
import { readConfig } from '../src/config.js';
import { keywordAlert } from '../src/processors/keyword-alert.js';
import { forwardWebhook } from '../src/processors/forward-webhook.js';

const G = 'Cgroup1';
const U = 'Uuser1';
const silent = { log() {}, warn() {}, error(...a) { throw new Error(a.join(' ')); } };

function fakeLine({ enabled = true } = {}) {
  const calls = [];
  return {
    calls,
    enabled,
    async getGroupSummary(id) { calls.push(['summary', id]); return { groupId: id, groupName: '業務群', pictureUrl: 'http://p' }; },
    async getGroupMemberCount() { return { count: 12 }; },
    async getGroupMemberProfile(g, u) { calls.push(['member', g, u]); return { displayName: '王小明', userId: u }; },
    async getMessageContent() { return new Response('IMG'); },
  };
}

function setup(overrides = {}) {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linehub-'));
  const store = openDb(':memory:');
  const line = fakeLine(overrides.line);
  const bus = new EventEmitter();
  const forwarded = [];
  const config = { ...readConfig({}), mediaDir, alertKeywords: ['報價'], forwardWebhookUrl: 'http://hook', ...overrides.config };
  const fetchImpl = async (url, init) => { forwarded.push(JSON.parse(init.body)); return new Response('ok'); };
  const ingestor = new Ingestor({
    store, line, config, bus, logger: silent,
    processors: [keywordAlert(), forwardWebhook({ fetchImpl })],
  });
  return { store, line, bus, ingestor, forwarded, mediaDir };
}

let seq = 0;
const msgEvent = (message, extra = {}) => ({
  type: 'message', webhookEventId: `ev${++seq}`, timestamp: 1700000000000 + seq,
  source: { type: 'group', groupId: G, userId: U }, replyToken: 'r', message, ...extra,
});

test('群組文字訊息：保存、補齊群組/成員資訊、關鍵字警示、轉送', async () => {
  const { store, ingestor, forwarded } = setup();
  await ingestor.handleWebhook({ events: [msgEvent({ id: 'm1', type: 'text', text: '請提供報價單' })] });

  const [msg] = store.listMessages({ sourceId: G });
  assert.equal(msg.text, '請提供報價單');
  assert.equal(msg.display_name, '王小明');
  assert.equal(msg.source_name, '業務群');
  assert.equal(store.getSource(G).member_count, 12);
  assert.equal(store.listAlerts()[0].keyword, '報價');
  assert.equal(store.listMembers(G)[0].user_id, U);

  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0].alerts, ['報價']);
  assert.equal(forwarded[0].sender.name, '王小明');
  assert.equal(forwarded[0].source.name, '業務群');
});

test('重送事件（相同 webhookEventId）不會重複處理', async () => {
  const { store, ingestor, forwarded } = setup();
  const ev = msgEvent({ id: 'm2', type: 'text', text: 'hi' });
  await ingestor.handleWebhook({ events: [ev] });
  await ingestor.handleWebhook({ events: [{ ...ev, deliveryContext: { isRedelivery: true } }] });
  assert.equal(store.stats().messages, 1);
  assert.equal(forwarded.length, 1);
});

test('個人資料有快取，不會每則訊息都呼叫 LINE API', async () => {
  const { line, ingestor } = setup();
  await ingestor.handleWebhook({ events: [msgEvent({ id: 'a', type: 'text', text: '1' }), msgEvent({ id: 'b', type: 'text', text: '2' })] });
  assert.equal(line.calls.filter((c) => c[0] === 'member').length, 1);
  assert.equal(line.calls.filter((c) => c[0] === 'summary').length, 1);
});

test('圖片訊息會下載內容到 MEDIA_DIR', async () => {
  const { store, ingestor, mediaDir } = setup();
  await ingestor.handleWebhook({ events: [msgEvent({ id: 'img1', type: 'image', contentProvider: { type: 'line' } })] });
  const msg = store.getMessage('img1');
  assert.equal(msg.text, '[圖片]');
  assert.equal(msg.media_path, path.join(G, 'img1.jpg'));
  assert.equal(fs.readFileSync(path.join(mediaDir, msg.media_path), 'utf8'), 'IMG');
});

test('收回、加入、離開事件會更新狀態', async () => {
  const { store, ingestor } = setup();
  await ingestor.handleWebhook({ events: [
    { type: 'join', webhookEventId: 'j1', timestamp: 1, source: { type: 'group', groupId: G } },
    msgEvent({ id: 'm9', type: 'text', text: 'oops' }),
    { type: 'unsend', webhookEventId: 'u1', timestamp: 2, source: { type: 'group', groupId: G, userId: U }, unsend: { messageId: 'm9' } },
    { type: 'memberLeft', webhookEventId: 'ml1', timestamp: 3, source: { type: 'group', groupId: G }, left: { members: [{ type: 'user', userId: U }] } },
    { type: 'leave', webhookEventId: 'l1', timestamp: 4, source: { type: 'group', groupId: G } },
  ] });
  assert.equal(store.getMessage('m9').unsent, true);
  assert.equal(store.listMembers(G)[0].left_at, 3);
  assert.equal(store.getSource(G).active, 0);
  assert.equal(store.stats().events, 5);
});

test('沒有 access token 時仍保存訊息', async () => {
  const { store, ingestor, line } = setup({ line: { enabled: false } });
  await ingestor.handleWebhook({ events: [msgEvent({ id: 'x', type: 'text', text: 'hello' })] });
  assert.equal(store.getMessage('x').text, 'hello');
  assert.equal(line.calls.length, 0);
});
