// 本機模擬 LINE 平台：送出帶正確簽章的 webhook 事件，不需真的 LINE 帳號即可測試整條流程
// 用法：npm run simulate -- [text 內容] [--group Cxxx] [--user Uxxx] [--type join|image|sticker|unsend]
import crypto from 'node:crypto';
import { loadDotEnv } from '../src/config.js';
import { computeSignature } from '../src/line/signature.js';

loadDotEnv();
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const url = opt('url', `http://localhost:${process.env.PORT || 3000}/webhook`);
const groupId = opt('group', 'Cdemo0000000000000000000000000001');
const userId = opt('user', 'Udemo0000000000000000000000000001');
const type = opt('type', 'text');
const text = args.join(' ') || '大家好，這是一則測試訊息（緊急）';
const secret = process.env.LINE_CHANNEL_SECRET;
if (!secret) throw new Error('請先在 .env 設定 LINE_CHANNEL_SECRET');

const base = () => ({
  webhookEventId: crypto.randomUUID(),
  timestamp: Date.now(),
  mode: 'active',
  deliveryContext: { isRedelivery: false },
  source: { type: 'group', groupId, userId },
});
const msgId = () => String(Date.now()) + Math.floor(Math.random() * 1000);

const events = {
  text: { ...base(), type: 'message', replyToken: 'dummy', message: { id: msgId(), type: 'text', text, quoteToken: 'q' } },
  sticker: { ...base(), type: 'message', replyToken: 'dummy', message: { id: msgId(), type: 'sticker', packageId: '446', stickerId: '1988', keywords: ['happy', 'OK'] } },
  image: { ...base(), type: 'message', replyToken: 'dummy', message: { id: msgId(), type: 'image', contentProvider: { type: 'line' } } },
  join: { ...base(), type: 'join', replyToken: 'dummy', source: { type: 'group', groupId } },
  unsend: { ...base(), type: 'unsend', unsend: { messageId: text } },
};
const event = events[type];
if (!event) throw new Error(`未知的 --type ${type}`);

const body = JSON.stringify({ destination: 'Udestination', events: [event] });
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-line-signature': computeSignature(secret, body) },
  body,
});
console.log(res.status, await res.text(), event.message?.id ? `messageId=${event.message.id}` : '');
