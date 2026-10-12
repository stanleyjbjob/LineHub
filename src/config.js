import fs from 'node:fs';
import path from 'node:path';

// 極簡 .env 載入器（不覆蓋已存在的環境變數），避免引入額外套件
export function loadDotEnv(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, key, raw] = m;
    const value = raw.replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v));
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export function readConfig(env = process.env) {
  return {
    channelSecret: env.LINE_CHANNEL_SECRET || '',
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN || '',
    port: Number(env.PORT || 3000),
    dbPath: env.DB_PATH || './data/linehub.db',
    mediaDir: env.MEDIA_DIR || './data/media',
    downloadMedia: bool(env.DOWNLOAD_MEDIA, true),
    adminToken: env.ADMIN_TOKEN || '',
    alertKeywords: list(env.ALERT_KEYWORDS),
    forwardWebhookUrl: env.FORWARD_WEBHOOK_URL || '',
    enableBotCommands: bool(env.ENABLE_BOT_COMMANDS, false),
    // AI 每日摘要（ANTHROPIC_API_KEY 由 Anthropic SDK 直接讀取）
    summaryEnabled: bool(env.SUMMARY_ENABLED, Boolean(env.ANTHROPIC_API_KEY)),
    summaryTime: normalizeTime(env.SUMMARY_TIME || '08:00'),
    summaryTz: env.SUMMARY_TZ || 'Asia/Taipei',
    summaryMinMessages: Number(env.SUMMARY_MIN_MESSAGES || 5),
    summaryModel: env.SUMMARY_MODEL || 'claude-opus-5-5',
    summaryEffort: env.SUMMARY_EFFORT || 'medium',
    summaryPushToGroup: bool(env.SUMMARY_PUSH_TO_GROUP, false),
  };
}

function normalizeTime(v) {
  const m = String(v).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`SUMMARY_TIME 格式應為 HH:mm，收到 ${v}`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}
