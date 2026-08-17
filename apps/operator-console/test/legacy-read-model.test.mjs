import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  legacyAssistantAnalytics,
  legacyAssistantConfig,
  legacyAssistantEvents,
  legacyMode,
  legacyModerationEvents,
  legacyModerationStats,
  legacyPrompts,
} from '../src/legacy-read-model.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aichattg-legacy-console-'));
  const runtimeDatabasePath = join(root, 'runtime.sqlite');
  const safetyPromptPath = join(root, 'moderation-tg-v3.md');
  writeFileSync(safetyPromptPath, 'Telegram safety prompt v3', { mode: 0o600 });
  const db = new Database(runtimeDatabasePath);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE runtime_inbound_events (event_id TEXT PRIMARY KEY);
    CREATE TABLE runtime_moderation_records (
      id TEXT PRIMARY KEY, event_id TEXT UNIQUE, chat_id TEXT, message_id TEXT, user_id TEXT,
      verdict TEXT, confidence REAL, reason TEXT, mode TEXT, action_json TEXT, created_at INTEGER
    );
    CREATE TABLE runtime_assistant_dialogues (
      id TEXT PRIMARY KEY, chat_id TEXT, user_id TEXT, last_activity_at INTEGER
    );
    CREATE TABLE runtime_assistant_turns (
      id TEXT PRIMARY KEY, dialogue_id TEXT, event_id TEXT, question TEXT, answer TEXT,
      model_id TEXT, receipt_json TEXT, created_at INTEGER
    );
    INSERT INTO runtime_inbound_events VALUES ('mod-evt'), ('ask-evt');
    INSERT INTO runtime_moderation_records VALUES (
      'mod-1', 'mod-evt', '-100123', '77', '42', 'suspect', 0.91,
      'safety:abuse:weak:insult', 'live', '{"action":"warn"}', 1760000000
    );
    INSERT INTO runtime_assistant_dialogues VALUES ('dialog-1', '-100123', '42', 1760000010);
    INSERT INTO runtime_assistant_turns VALUES (
      'turn-1', 'dialog-1', 'ask-evt', 'Что делать?', 'Ответ', 'gpt-5.6-terra',
      '{"ok":true,"messageId":"88"}', 1760000010
    );
  `);
  db.close();
  return {
    runtimeDatabasePath,
    safetyPromptPath,
    runtimeFlags: { ingressEnabled: true, moderationMode: 'live', providerEnabled: true, notificationsEnabled: false },
    runtimeModels: {
      vendor: 'openai', moderator: 'gpt-5.6-terra', moderatorReasoning: 'medium',
      router: 'gpt-5.6-luna', answer: 'gpt-5.6-terra', routerReasoning: 'minimal',
      answerReasoning: 'low', answerMaxTokens: 2000,
    },
    assistantPolicy: { cooldownSec: 20, dailyPerUser: 20, knowledgeEnabled: false },
  };
}

test('legacy moderation projection exposes Telegram runtime truth without News state', () => {
  const config = fixture();
  const mode = legacyMode(config);
  assert.equal(mode.mode, 'live');
  assert.equal(mode.model, 'gpt-5.6-terra');
  assert.deepEqual(Object.keys(mode.modelCatalog), ['anthropic', 'openai']);
  const stats = legacyModerationStats(config);
  assert.equal(stats.totalEvents, 1);
  assert.equal(stats.byVerdict.suspect, 1);
  assert.deepEqual(stats.pending, []);
  const [event] = legacyModerationEvents(config);
  assert.equal(event.platform, 'telegram');
  assert.equal(event.platform_author_id, '42');
  assert.equal(event.comment_text, '');
  assert.equal(event.safety_route, 'abuse');
  assert.equal(event.abuse_level, 'weak');
  assert.match(event.created_at, /^2025-/u);
  const prompts = legacyPrompts(config);
  assert.equal(prompts.active, 'tg-v3');
  assert.equal(prompts.activeText, 'Telegram safety prompt v3');
});

test('legacy assistant projection renders current dialogue and reports knowledge disabled', () => {
  const config = fixture();
  const assistant = legacyAssistantConfig(config);
  assert.equal(assistant.enabled, true);
  assert.equal(assistant.model, 'gpt-5.6-terra');
  assert.match(assistant.knowledgeContent, /Отключена/u);
  const [event] = legacyAssistantEvents(config);
  assert.equal(event.user_id, '42');
  assert.equal(event.question, 'Что делать?');
  assert.equal(event.answer, 'Ответ');
  assert.equal(event.cost_usd, null);
  const analytics = legacyAssistantAnalytics(config);
  assert.equal(analytics.total.count, 1);
});

test('unmeasured spend is reported as unmeasured, never as zero', () => {
  // База без учёта (таблицы записей ответов ещё нет) — консоль обязана сказать
  // «не измерено», а не напечатать ноль вызова, которого она не видела.
  const config = fixture();
  const [event] = legacyAssistantEvents(config);
  assert.equal(event.input_tokens, null);
  assert.equal(event.output_tokens, null);
  const [moderation] = legacyModerationEvents(config);
  assert.equal(moderation.input_tokens, null);
  assert.equal(moderation.output_tokens, null);
});

test('measured spend reaches the console from the durable answer record', () => {
  const config = fixture();
  const db = new Database(config.runtimeDatabasePath);
  db.exec(`
    CREATE TABLE runtime_assistant_answer_records (
      event_id TEXT PRIMARY KEY, chat_id TEXT, user_id TEXT, question TEXT, answer TEXT,
      model_id TEXT, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, created_at INTEGER
    );
    INSERT INTO runtime_assistant_answer_records VALUES (
      'ask-evt', '-100123', '42', 'Что делать?', 'Ответ', 'gpt-5.6-terra', 1204, 318, 1522, 1760000010
    );
    INSERT INTO runtime_inbound_events VALUES ('ask-evt-2');
    INSERT INTO runtime_assistant_turns VALUES (
      'turn-2', 'dialog-1', 'ask-evt-2', 'Граница?', 'Эта тема за пределами курса.', NULL,
      '{"ok":true,"messageId":"89"}', 1760000020
    );
  `);
  db.close();
  const events = legacyAssistantEvents(config);
  const measured = events.find((event) => event.question === 'Что делать?');
  assert.equal(measured.input_tokens, 1204);
  assert.equal(measured.output_tokens, 318);
  // Детерминированный ответ модель не вызывал: платить нечем, и это тоже не ноль.
  const deterministic = events.find((event) => event.question === 'Граница?');
  assert.equal(deterministic.input_tokens, null);
  assert.equal(deterministic.output_tokens, null);
});
