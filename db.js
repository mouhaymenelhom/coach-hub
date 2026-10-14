const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT NOT NULL UNIQUE,
    email      TEXT,
    name       TEXT,
    picture    TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE IF NOT EXISTS coaches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS videos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT,
    kind        TEXT NOT NULL CHECK (kind IN ('embed','file')),
    src         TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE IF NOT EXISTS lives (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    embed_url  TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended')),
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender     TEXT NOT NULL CHECK (sender IN ('user','coach')),
    body       TEXT NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
`);

// Seed the coach account on first start (stored hashed, never in plain text)
const coachUsername = process.env.COACH_USERNAME || 'admin';
const coachPassword = process.env.COACH_PASSWORD || 'admin';
if (!db.prepare('SELECT 1 FROM coaches WHERE username = ?').get(coachUsername)) {
  db.prepare('INSERT INTO coaches (username, password_hash) VALUES (?, ?)')
    .run(coachUsername, bcrypt.hashSync(coachPassword, 10));
  console.log(`Coach account created: username "${coachUsername}"`);
}

module.exports = db;
