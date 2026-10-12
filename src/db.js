import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  webhook_event_id TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  source_type      TEXT,
  source_id        TEXT,
  user_id          TEXT,
  timestamp        INTEGER,
  is_redelivery    INTEGER DEFAULT 0,
  raw              TEXT NOT NULL,
  received_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,            -- group / room / user
  name         TEXT,
  picture_url  TEXT,
  member_count INTEGER,
  active       INTEGER NOT NULL DEFAULT 1,
  joined_at    INTEGER,
  left_at      INTEGER,
  last_message_at INTEGER,
  updated_at   INTEGER
);
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  display_name TEXT,
  picture_url  TEXT,
  updated_at   INTEGER
);
CREATE TABLE IF NOT EXISTS memberships (
  source_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  first_seen INTEGER,
  last_seen  INTEGER,
  left_at    INTEGER,
  PRIMARY KEY (source_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,           -- LINE message id
  event_id    TEXT,
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  user_id     TEXT,
  type        TEXT NOT NULL,              -- text / image / video / audio / file / sticker / location
  text        TEXT,
  payload     TEXT NOT NULL,              -- 原始 message 物件 JSON
  media_path  TEXT,
  quoted_message_id TEXT,
  unsent      INTEGER NOT NULL DEFAULT 0,
  timestamp   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_source_ts ON messages (source_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (timestamp DESC);
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  keyword    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
    this.stmt = {
      insertEvent: db.prepare(`INSERT OR IGNORE INTO events
        (webhook_event_id, type, source_type, source_id, user_id, timestamp, is_redelivery, raw, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      upsertSource: db.prepare(`INSERT INTO sources (id, type, active, joined_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(id) DO NOTHING`),
      insertMessage: db.prepare(`INSERT OR IGNORE INTO messages
        (id, event_id, source_type, source_id, user_id, type, text, payload, quoted_message_id, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    };
  }

  /** 寫入原始事件；回傳 false 代表重複（LINE 重送）事件 */
  insertEvent(event) {
    const id = event.webhookEventId || `${event.type}-${event.timestamp}-${Math.random()}`;
    const s = event.source || {};
    const r = this.stmt.insertEvent.run(
      id, event.type, s.type ?? null, sourceIdOf(s), s.userId ?? null,
      event.timestamp ?? null, event.deliveryContext?.isRedelivery ? 1 : 0,
      JSON.stringify(event), Date.now(),
    );
    return r.changes > 0;
  }

  ensureSource(type, id, ts = Date.now()) {
    this.stmt.upsertSource.run(id, type, ts, Date.now());
  }

  updateSource(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sql = `UPDATE sources SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => fields[k]), Date.now(), id);
  }

  getSource(id) {
    return this.db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  }

  upsertUser({ id, displayName, pictureUrl }) {
    this.db.prepare(`INSERT INTO users (id, display_name, picture_url, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
        picture_url = excluded.picture_url, updated_at = excluded.updated_at`)
      .run(id, displayName ?? null, pictureUrl ?? null, Date.now());
  }

  getUser(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  touchMembership(sourceId, userId, ts) {
    this.db.prepare(`INSERT INTO memberships (source_id, user_id, first_seen, last_seen) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id, user_id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen), left_at = NULL`)
      .run(sourceId, userId, ts, ts);
  }

  markMemberLeft(sourceId, userId, ts) {
    this.db.prepare(`INSERT INTO memberships (source_id, user_id, first_seen, last_seen, left_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, user_id) DO UPDATE SET left_at = excluded.left_at`)
      .run(sourceId, userId, ts, ts, ts);
  }

  insertMessage(m) {
    const r = this.stmt.insertMessage.run(
      m.id, m.eventId ?? null, m.sourceType, m.sourceId, m.userId ?? null, m.type,
      m.text ?? null, JSON.stringify(m.payload), m.quotedMessageId ?? null, m.timestamp,
    );
    if (r.changes > 0) {
      this.db.prepare('UPDATE sources SET last_message_at = MAX(COALESCE(last_message_at, 0), ?) WHERE id = ?')
        .run(m.timestamp, m.sourceId);
    }
    return r.changes > 0;
  }

  setMediaPath(messageId, mediaPath) {
    this.db.prepare('UPDATE messages SET media_path = ? WHERE id = ?').run(mediaPath, messageId);
  }

  markUnsent(messageId) {
    this.db.prepare('UPDATE messages SET unsent = 1 WHERE id = ?').run(messageId);
  }

  insertAlert(messageId, sourceId, keyword) {
    this.db.prepare('INSERT INTO alerts (message_id, source_id, keyword, created_at) VALUES (?, ?, ?, ?)')
      .run(messageId, sourceId, keyword, Date.now());
  }

  // ---------- 查詢（給 API / 後台使用） ----------

  listSources() {
    return this.db.prepare(`SELECT s.*,
        (SELECT COUNT(*) FROM messages m WHERE m.source_id = s.id) AS message_count
      FROM sources s ORDER BY COALESCE(s.last_message_at, s.joined_at) DESC`).all();
  }

  listMessages({ sourceId, q, type, before, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (sourceId) { where.push('m.source_id = ?'); args.push(sourceId); }
    if (type) { where.push('m.type = ?'); args.push(type); }
    if (q) { where.push('m.text LIKE ?'); args.push(`%${q}%`); }
    if (before) { where.push('m.timestamp < ?'); args.push(Number(before)); }
    args.push(Math.min(Number(limit) || 50, 500));
    return this.db.prepare(`SELECT m.*, u.display_name, u.picture_url, s.name AS source_name
      FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN sources s ON s.id = m.source_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY m.timestamp DESC LIMIT ?`).all(...args).map(hydrateMessage);
  }

  getMessage(id) {
    const row = this.db.prepare(`SELECT m.*, u.display_name, u.picture_url, s.name AS source_name
      FROM messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN sources s ON s.id = m.source_id
      WHERE m.id = ?`).get(id);
    return row ? hydrateMessage(row) : undefined;
  }

  listMembers(sourceId) {
    return this.db.prepare(`SELECT ms.*, u.display_name, u.picture_url,
        (SELECT COUNT(*) FROM messages m WHERE m.source_id = ms.source_id AND m.user_id = ms.user_id) AS message_count
      FROM memberships ms LEFT JOIN users u ON u.id = ms.user_id
      WHERE ms.source_id = ? ORDER BY ms.last_seen DESC`).all(sourceId);
  }

  listAlerts(limit = 100) {
    return this.db.prepare(`SELECT a.*, m.text, m.user_id, u.display_name, s.name AS source_name
      FROM alerts a JOIN messages m ON m.id = a.message_id
      LEFT JOIN users u ON u.id = m.user_id LEFT JOIN sources s ON s.id = a.source_id
      ORDER BY a.id DESC LIMIT ?`).all(limit);
  }

  listEvents(limit = 100) {
    return this.db.prepare('SELECT * FROM events ORDER BY received_at DESC LIMIT ?').all(limit)
      .map((e) => ({ ...e, raw: JSON.parse(e.raw) }));
  }

  stats() {
    const one = (sql) => Object.values(this.db.prepare(sql).get())[0];
    return {
      sources: one('SELECT COUNT(*) FROM sources'),
      activeGroups: one("SELECT COUNT(*) FROM sources WHERE type IN ('group','room') AND active = 1"),
      users: one('SELECT COUNT(*) FROM users'),
      messages: one('SELECT COUNT(*) FROM messages'),
      events: one('SELECT COUNT(*) FROM events'),
      alerts: one('SELECT COUNT(*) FROM alerts'),
    };
  }
}

export function sourceIdOf(source = {}) {
  return source.groupId || source.roomId || source.userId || null;
}

function hydrateMessage(row) {
  return { ...row, payload: JSON.parse(row.payload), unsent: Boolean(row.unsent) };
}
