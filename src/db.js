const path = require('path');
const fs = require('fs');

// Локальная разработка: SQLite. Render: PostgreSQL (если задан DATABASE_URL).
const USE_PG = !!process.env.DATABASE_URL;

let sqlite = null;
let pool = null;

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  joined_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Entertainment',
  filename TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(video_id, user_id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(subscriber_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
`;

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  joined_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Entertainment',
  filename TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  id SERIAL PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(video_id, user_id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  subscriber_id INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  UNIQUE(subscriber_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
`;

async function init() {
  if (USE_PG) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query(SCHEMA_PG);
    return;
  }
  const Database = require('better-sqlite3');
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'thumbs'), { recursive: true });
  sqlite = new Database(path.join(dir, 'oldtube.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(SCHEMA_SQLITE);
}

function uploadDir() {
  // Glitch: постоянное хранилище только в .data. Локально — тоже .data.
  return process.env.UPLOAD_DIR || path.join(__dirname, '..', '.data');
}

function translate(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function all(sql, params = []) {
  if (sqlite) return sqlite.prepare(sql).all(...params);
  return pool.query(translate(sql), params).then((r) => r.rows);
}

function get(sql, params = []) {
  if (sqlite) return sqlite.prepare(sql).get(...params);
  return pool.query(translate(sql), params).then((r) => r.rows[0]);
}

async function run(sql, params = []) {
  if (sqlite) {
    const r = sqlite.prepare(sql).run(...params);
    return { id: Number(r.lastInsertRowid), changes: r.changes };
  }
  const trimmed = sql.trimStart();
  const withReturn = /^INSERT/i.test(trimmed) ? `${sql} RETURNING id` : sql;
  const r = await pool.query(translate(withReturn), params);
  return { id: r.rows[0] ? r.rows[0].id : null, changes: r.rowCount };
}

module.exports = { init, all, get, run, uploadDir, USE_PG };