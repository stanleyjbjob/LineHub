import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sourceIdOf } from './db.js';

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file']);
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const EXT = { image: '.jpg', video: '.mp4', audio: '.m4a' };

/**
 * 將 LINE webhook 事件轉成資料庫紀錄，並把「標準化訊息」交給後續 processors。
 * 所有 LINE API 呼叫失敗都只記 log，不影響訊息本身的保存。
 */
export class Ingestor {
  constructor({ store, line, config, processors = [], bus, logger = console }) {
    this.store = store;
    this.line = line;
    this.config = config;
    this.processors = processors;
    this.bus = bus;
    this.log = logger;
  }

  async handleWebhook(body) {
    for (const event of body.events || []) {
      try {
        await this.handleEvent(event, body.destination);
      } catch (err) {
        this.log.error('[ingest] event failed', event.webhookEventId, err);
      }
    }
  }

  async handleEvent(event) {
    if (!this.store.insertEvent(event)) return; // 重複事件（LINE 重送）略過
    const source = event.source || {};
    const sourceId = sourceIdOf(source);
    if (sourceId) this.store.ensureSource(source.type, sourceId, event.timestamp);
    this.bus?.emit('event', { type: event.type, sourceId });

    switch (event.type) {
      case 'message':
        return this.#onMessage(event, source, sourceId);
      case 'unsend':
        this.store.markUnsent(event.unsend.messageId);
        this.bus?.emit('unsend', { messageId: event.unsend.messageId, sourceId });
        return;
      case 'join':
        this.store.updateSource(sourceId, { active: 1, joined_at: event.timestamp, left_at: null });
        return this.#refreshSource(source, sourceId, true);
      case 'leave':
        this.store.updateSource(sourceId, { active: 0, left_at: event.timestamp });
        return;
      case 'follow':
        this.store.updateSource(sourceId, { active: 1 });
        return this.#refreshUser(source, sourceId, source.userId, true);
      case 'unfollow':
        this.store.updateSource(sourceId, { active: 0, left_at: event.timestamp });
        return;
      case 'memberJoined':
        for (const m of event.joined?.members || []) {
          this.store.touchMembership(sourceId, m.userId, event.timestamp);
          await this.#refreshUser(source, sourceId, m.userId);
        }
        return this.#refreshSource(source, sourceId, true);
      case 'memberLeft':
        for (const m of event.left?.members || []) this.store.markMemberLeft(sourceId, m.userId, event.timestamp);
        return this.#refreshSource(source, sourceId, true);
      default:
        return; // postback / beacon / videoPlayComplete 等：已存在 events 原始紀錄中
    }
  }

  async #onMessage(event, source, sourceId) {
    const msg = event.message;
    const record = {
      id: msg.id,
      eventId: event.webhookEventId,
      sourceType: source.type,
      sourceId,
      userId: source.userId,
      type: msg.type,
      text: textOf(msg),
      payload: msg,
      quotedMessageId: msg.quotedMessageId,
      timestamp: event.timestamp,
    };
    if (!this.store.insertMessage(record)) return;
    if (source.userId) this.store.touchMembership(sourceId, source.userId, event.timestamp);

    await Promise.all([
      this.#refreshSource(source, sourceId),
      source.userId && this.#refreshUser(source, sourceId, source.userId),
    ]);

    // 多媒體內容僅 contentProvider.type === 'line' 時可由 API 取得
    if (MEDIA_TYPES.has(msg.type) && this.config.downloadMedia
        && (msg.contentProvider?.type ?? 'line') === 'line') {
      await this.#downloadMedia(msg, sourceId);
    }

    const message = this.store.getMessage(msg.id);
    this.bus?.emit('message', message);

    const ctx = {
      event, message, store: this.store, line: this.line, config: this.config, log: this.log, bus: this.bus,
    };
    for (const p of this.processors) {
      try {
        await p.handle(ctx);
      } catch (err) {
        this.log.error(`[processor:${p.name}]`, err);
      }
    }
  }

  async #refreshSource(source, sourceId, force = false) {
    if (source.type !== 'group' || !this.line.enabled) return;
    const existing = this.store.getSource(sourceId);
    if (!force && existing?.name && Date.now() - (existing.updated_at || 0) < PROFILE_TTL_MS) return;
    try {
      const summary = await this.line.getGroupSummary(sourceId);
      const count = await this.line.getGroupMemberCount(sourceId).catch(() => ({}));
      this.store.updateSource(sourceId, {
        name: summary.groupName ?? null,
        picture_url: summary.pictureUrl ?? null,
        member_count: count.count ?? null,
      });
    } catch (err) {
      this.log.warn('[ingest] group summary failed', sourceId, err.message);
    }
  }

  async #refreshUser(source, sourceId, userId, force = false) {
    if (!userId || !this.line.enabled) return;
    const existing = this.store.getUser(userId);
    if (!force && existing && Date.now() - existing.updated_at < PROFILE_TTL_MS) return;
    try {
      // 群組成員不一定是 Bot 好友，必須用 group/room member profile API
      const p = source.type === 'group'
        ? await this.line.getGroupMemberProfile(sourceId, userId)
        : source.type === 'room'
          ? await this.line.getRoomMemberProfile(sourceId, userId)
          : await this.line.getProfile(userId);
      this.store.upsertUser({ id: userId, displayName: p.displayName, pictureUrl: p.pictureUrl });
      if (source.type === 'user') this.store.updateSource(sourceId, { name: p.displayName, picture_url: p.pictureUrl ?? null });
    } catch (err) {
      this.log.warn('[ingest] profile failed', userId, err.message);
      if (!existing) this.store.upsertUser({ id: userId }); // 避免每則訊息都重試
    }
  }

  async #downloadMedia(msg, sourceId) {
    if (!this.line.enabled) return;
    try {
      const res = await this.line.getMessageContent(msg.id);
      const dir = path.resolve(this.config.mediaDir, sourceId);
      fs.mkdirSync(dir, { recursive: true });
      const ext = msg.type === 'file' ? path.extname(msg.fileName || '') : EXT[msg.type] || '';
      const file = path.join(dir, `${msg.id}${ext}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
      this.store.setMediaPath(msg.id, path.relative(path.resolve(this.config.mediaDir), file));
    } catch (err) {
      this.log.warn('[ingest] media download failed', msg.id, err.message);
    }
  }
}

export function textOf(msg) {
  switch (msg.type) {
    case 'text': return msg.text;
    case 'sticker': return `[貼圖] ${msg.keywords?.slice(0, 3).join(', ') || msg.stickerId}`;
    case 'image': return '[圖片]';
    case 'video': return '[影片]';
    case 'audio': return '[語音]';
    case 'file': return `[檔案] ${msg.fileName || ''}`.trim();
    case 'location': return `[位置] ${[msg.title, msg.address].filter(Boolean).join(' ')}`;
    default: return `[${msg.type}]`;
  }
}
