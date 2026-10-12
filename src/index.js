import { EventEmitter } from 'node:events';
import { loadDotEnv, readConfig } from './config.js';
import { openDb } from './db.js';
import { LineClient } from './line/client.js';
import { Ingestor } from './ingest.js';
import { defaultProcessors } from './processors/index.js';
import Anthropic from '@anthropic-ai/sdk';
import { createServer } from './server.js';
import { Summarizer } from './summary/summarizer.js';
import { startScheduler } from './summary/scheduler.js';

loadDotEnv();
const config = readConfig();
if (!config.channelSecret) {
  console.error('缺少 LINE_CHANNEL_SECRET，請先複製 .env.example 為 .env 並填入。');
  process.exit(1);
}
if (!config.channelAccessToken) {
  console.warn('未設定 LINE_CHANNEL_ACCESS_TOKEN：仍會保存訊息，但無法取得群組名稱、成員名稱與多媒體內容。');
}

const store = openDb(config.dbPath);
const line = new LineClient(config.channelAccessToken);
const bus = new EventEmitter();
const ingestor = new Ingestor({ store, line, config, processors: defaultProcessors(), bus });
const summarizer = new Summarizer({
  store, line, config, bus, anthropic: config.summaryEnabled ? new Anthropic() : null,
});
const server = createServer({ config, store, ingestor, summarizer, bus });
if (summarizer.enabled) startScheduler({ summarizer, config });

server.listen(config.port, () => {
  console.log(`LineHub 已啟動：http://localhost:${config.port}`);
  console.log(`Webhook URL：<你的公開網址>/webhook`);
  console.log(summarizer.enabled
    ? `AI 每日摘要：每天 ${config.summaryTime}（${config.summaryTz}）摘要前一天的群組對話（${config.summaryModel}）`
    : 'AI 每日摘要：停用（未設定 ANTHROPIC_API_KEY）');
});
