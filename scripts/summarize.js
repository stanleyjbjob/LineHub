// 手動產生群組摘要（不需啟動伺服器）
// 用法：npm run summarize -- [--date 2026-10-12] [--source Cxxx] [--force] [--push]
import Anthropic from '@anthropic-ai/sdk';
import { loadDotEnv, readConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { LineClient } from '../src/line/client.js';
import { Summarizer } from '../src/summary/summarizer.js';
import { localDate } from '../src/summary/time.js';

loadDotEnv();
const config = readConfig();
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);

const store = openDb(config.dbPath);
const summarizer = new Summarizer({
  store, config, line: new LineClient(config.channelAccessToken), anthropic: new Anthropic(),
});
const date = opt('date') || localDate(Date.now(), config.summaryTz);
const source = opt('source');
const options = { force: flag('force'), push: flag('push') };

const results = source
  ? [await summarizer.summarize(source, date, options)]
  : await summarizer.runDaily(date, options);
if (!results.length) console.log(`${date} 沒有訊息數 >= ${config.summaryMinMessages} 的群組`);
for (const r of results) {
  console.log('─'.repeat(40));
  console.log(r.error ? `✗ ${r.sourceId}：${r.error}` : `${r.skipped ? '（已存在，加 --force 重新產生）\n' : ''}${r.text}`);
}
