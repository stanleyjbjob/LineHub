import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { Summarizer, buildTranscript, renderSummary, SUMMARY_SCHEMA } from '../src/summary/summarizer.js';
import { dayRange, localDate, previousDate } from '../src/summary/time.js';
import { dueDate } from '../src/summary/scheduler.js';

const TZ = 'Asia/Taipei';
const G = 'Cgroup1';
const at = (hhmm, date = '2026-10-12') => Date.parse(`${date}T${hhmm}:00+08:00`);

const SAMPLE = {
  overview: '討論 Q4 報價與出貨時程。',
  topics: [{ title: 'Q4 報價', summary: '客戶要求在週五前提供報價。', participants: ['王小明', '陳美玲'] }],
  decisions: ['報價以去年單價 9 折為基準'],
  action_items: [{ task: '寄出報價單', owner: '王小明', due: '10/17' }, { task: '確認庫存', owner: '', due: '' }],
  open_questions: ['運費由誰負擔？'],
  mood: 'neutral',
};

function fakeAnthropic({ stop_reason = 'end_turn', content = SAMPLE } = {}) {
  const calls = [];
  return {
    calls,
    beta: { messages: { async create(req) {
      calls.push(req);
      return {
        model: req.model, stop_reason, stop_details: stop_reason === 'refusal' ? { category: 'cyber' } : null,
        content: stop_reason === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(content) }],
        usage: { input_tokens: 1200, output_tokens: 300 },
      };
    } } },
  };
}

function setup({ anthropic = fakeAnthropic(), env = {} } = {}) {
  const store = openDb(':memory:');
  const config = readConfig({ SUMMARY_MIN_MESSAGES: '2', ...env });
  const pushed = [];
  const line = { enabled: true, async pushMessage(to, msgs) { pushed.push({ to, msgs }); } };
  const summarizer = new Summarizer({ store, anthropic, line, config, logger: { log() {}, warn() {}, error() {} } });
  store.ensureSource('group', G, 0);
  store.updateSource(G, { name: '業務群' });
  store.upsertUser({ id: 'U1', displayName: '王小明' });
  store.upsertUser({ id: 'U2', displayName: '陳美玲' });
  const add = (id, user, hhmm, text, extra = {}) => store.insertMessage({
    id, sourceType: 'group', sourceId: G, userId: user, type: 'text', text, payload: {}, timestamp: at(hhmm, extra.date), ...extra,
  });
  return { store, summarizer, anthropic, pushed, add };
}

test('時區日期切分', () => {
  const { start, end } = dayRange('2026-10-12', TZ);
  assert.equal(new Date(start).toISOString(), '2026-10-11T16:00:00.000Z');
  assert.equal(end - start, 86400000);
  assert.equal(localDate(at('00:30'), TZ), '2026-10-12');
  assert.equal(previousDate('2026-03-01'), '2026-02-28');
  assert.throws(() => dayRange('10/12', TZ));
});

test('排程：過了設定時間且今天未執行 → 摘要前一天', () => {
  assert.equal(dueDate(at('07:59'), '08:00', TZ, null), null);
  assert.equal(dueDate(at('08:00'), '08:00', TZ, null), '2026-10-11');
  assert.equal(dueDate(at('15:00'), '08:00', TZ, '2026-10-12'), null);
});

test('逐字稿包含時間、暱稱與被回覆的訊息', () => {
  const { store, add } = setup();
  add('m1', 'U1', '09:05', '報價什麼時候要給？');
  add('m2', 'U2', '09:10', '週五前', { quotedMessageId: 'm1' });
  add('m3', 'U9', '09:11', '收到');
  const { start, end } = dayRange('2026-10-12', TZ);
  assert.equal(buildTranscript(store.messagesBetween(G, start, end), TZ), [
    '[09:05] 王小明: 報價什麼時候要給？',
    '[09:10] 陳美玲: （回覆 王小明「報價什麼時候要給？」）週五前',
    '[09:11] 使用者U9: 收到',
  ].join('\n'));
});

test('產生摘要：請求格式、保存結果、推播、不重複呼叫', async () => {
  const { store, summarizer, anthropic, pushed, add } = setup();
  add('m1', 'U1', '09:05', '報價什麼時候要給？');
  add('m2', 'U2', '09:10', '週五前');
  add('old', 'U2', '23:59', '前一天的訊息', { date: '2026-10-11' });
  store.insertMessage({ id: 'gone', sourceType: 'group', sourceId: G, userId: 'U1', type: 'text', text: '已收回', payload: {}, timestamp: at('10:00') });
  store.markUnsent('gone');

  const s = await summarizer.summarize(G, '2026-10-12', { push: true });
  const req = anthropic.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(req.output_config, { effort: 'medium', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } });
  assert.match(req.messages[0].content, /群組：業務群/);
  assert.match(req.messages[0].content, /訊息數：2\n/);
  assert.doesNotMatch(req.messages[0].content, /前一天的訊息|已收回/);

  assert.equal(s.message_count, 2);
  assert.deepEqual(s.content, SAMPLE);
  assert.match(s.text, /□ 寄出報價單（王小明） 期限：10\/17/);
  assert.equal(pushed[0].to, G);
  assert.ok(store.getSummary(G, '2026-10-12').pushed_at);

  const again = await summarizer.summarize(G, '2026-10-12');
  assert.equal(again.skipped, true);
  assert.equal(anthropic.calls.length, 1);
  await summarizer.summarize(G, '2026-10-12', { force: true });
  assert.equal(anthropic.calls.length, 2);
  assert.equal(store.listSummaries().length, 1);
});

test('runDaily 只處理訊息數達門檻的群組，單一群組失敗不影響其他', async () => {
  const { store, summarizer, add } = setup({ anthropic: fakeAnthropic({ stop_reason: 'refusal' }) });
  add('m1', 'U1', '09:05', 'a');
  add('m2', 'U1', '09:06', 'b');
  store.ensureSource('group', 'Cquiet', 0);
  store.insertMessage({ id: 'q1', sourceType: 'group', sourceId: 'Cquiet', userId: 'U1', type: 'text', text: 'hi', payload: {}, timestamp: at('09:00') });
  const results = await summarizer.runDaily('2026-10-12');
  assert.equal(results.length, 1);
  assert.match(results[0].error, /拒絕/);
});

test('renderSummary 省略空白區塊', () => {
  const text = renderSummary({ ...SAMPLE, decisions: [], open_questions: [] }, { name: 'X', date: '2026-10-12', count: 3 });
  assert.doesNotMatch(text, /決議|待回覆/);
  assert.match(text, /氣氛：中性/);
});
