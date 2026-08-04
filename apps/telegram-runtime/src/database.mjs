import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_inbound_events (
  event_id TEXT PRIMARY KEY,
  bot_role TEXT NOT NULL CHECK(bot_role IN ('moderator', 'assistant')),
  update_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'skipped', 'error')),
  result_json TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS runtime_moderation_records (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES runtime_inbound_events(event_id),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT,
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL,
  action_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_assistant_dialogues (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_activity_at INTEGER NOT NULL,
  UNIQUE(chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS runtime_assistant_turns (
  id TEXT PRIMARY KEY,
  dialogue_id TEXT NOT NULL REFERENCES runtime_assistant_dialogues(id),
  event_id TEXT NOT NULL UNIQUE REFERENCES runtime_inbound_events(event_id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  model_id TEXT,
  receipt_json TEXT,
  created_at INTEGER NOT NULL
);
`;

export function openRuntimeDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function createRuntimeStore(db, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  const claim = db.prepare(`INSERT INTO runtime_inbound_events
    (event_id, bot_role, update_id, status, created_at) VALUES (?, ?, ?, 'processing', ?)
    ON CONFLICT(event_id) DO NOTHING`);
  const event = db.prepare('SELECT * FROM runtime_inbound_events WHERE event_id = ?');
  const finish = db.prepare(`UPDATE runtime_inbound_events
    SET status = ?, result_json = ?, error_text = ?, completed_at = ? WHERE event_id = ?`);
  const dialogue = db.prepare('SELECT * FROM runtime_assistant_dialogues WHERE chat_id = ? AND user_id = ?');
  const turns = db.prepare(`SELECT question, answer FROM runtime_assistant_turns
    WHERE dialogue_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`);
  const insertDialogue = db.prepare(`INSERT INTO runtime_assistant_dialogues
    (id, chat_id, user_id, last_activity_at) VALUES (?, ?, ?, ?)`);
  const touchDialogue = db.prepare('UPDATE runtime_assistant_dialogues SET last_activity_at = ? WHERE id = ?');
  const insertTurn = db.prepare(`INSERT INTO runtime_assistant_turns
    (id, dialogue_id, event_id, question, answer, model_id, receipt_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertModeration = db.prepare(`INSERT INTO runtime_moderation_records
    (id, event_id, chat_id, message_id, user_id, verdict, confidence, reason, mode, action_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  return {
    claimEvent({ eventId, role, updateId }) {
      const claimed = claim.run(eventId, role, updateId, now()).changes === 1;
      return { claimed, existing: claimed ? null : event.get(eventId) };
    },
    completeEvent(eventId, status, result = null, error = null) {
      finish.run(status, result == null ? null : JSON.stringify(result), error, now(), eventId);
    },
    recordModeration(record) {
      insertModeration.run(
        randomUUID(), record.eventId, record.chatId, record.messageId, record.userId,
        record.verdict, record.confidence, record.reason, record.mode,
        JSON.stringify(record.actions || []), now(),
      );
    },
    recentDialogue(chatId, userId, limit = 3) {
      const current = dialogue.get(chatId, userId);
      if (!current) return [];
      return turns.all(current.id, limit).reverse().map((row) => ({ question: row.question, answer: row.answer }));
    },
    recordAssistantTurn(turn) {
      const at = now();
      let current = dialogue.get(turn.chatId, turn.userId);
      if (!current) {
        current = { id: randomUUID() };
        insertDialogue.run(current.id, turn.chatId, turn.userId, at);
      } else {
        touchDialogue.run(at, current.id);
      }
      insertTurn.run(
        randomUUID(), current.id, turn.eventId, turn.question, turn.answer,
        turn.modelId || null, JSON.stringify(turn.receipt || null), at,
      );
    },
    getEvent(eventId) { return event.get(eventId); },
  };
}
