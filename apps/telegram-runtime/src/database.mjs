import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createJudgementStore } from './judgement-store.mjs';
import { createJudgementAnswerClaims } from './judgement-answer-claims.mjs';
import { sanitizeProviderFailureDiagnostic } from './provider-adapter.mjs';

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
-- A receipt names one delivery from one bot stream. A claim is deliberately
-- separate from that receipt: stale workers may never finalize a row once its
-- claim generation has been fenced by controlled recovery.
CREATE TABLE IF NOT EXISTS runtime_inbound_update_receipts (
  receipt_id TEXT PRIMARY KEY,
  bot_role TEXT NOT NULL CHECK(bot_role IN ('moderator', 'assistant')),
  update_id INTEGER NOT NULL CHECK(update_id >= 0),
  revision_identity TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  claim_generation INTEGER NOT NULL CHECK(claim_generation >= 1),
  status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'skipped', 'uncertain')),
  result_json TEXT,
  error_code TEXT,
  -- Машинный код отказа отвечает на «какой это класс», но не на «что именно
  -- сломалось». Молчаливое падение без этой строки стоило боевого
  -- расследования, поэтому техническая суть (класс, код, message, кадр стека)
  -- хранится рядом. Полезная нагрузка сообщения сюда не пишется.
  error_text TEXT,
  recovery_id TEXT,
  received_at INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  completed_at INTEGER,
  recovered_at INTEGER,
  UNIQUE(bot_role, update_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_inbound_update_receipts_recovery
  ON runtime_inbound_update_receipts(status, received_at);
-- This private queue deliberately stores only the exact Moderator fields needed
-- to resume a proved-not-called semantic judgement. It is not a second webhook
-- inbox: raw Telegram JSON, headers and full delivery payloads are prohibited.
CREATE TABLE IF NOT EXISTS runtime_moderator_judgement_jobs (
  event_id TEXT PRIMARY KEY REFERENCES runtime_inbound_events(event_id),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES runtime_inbound_update_receipts(receipt_id),
  state TEXT NOT NULL CHECK(state IN ('safe_retry', 'calling', 'decision_ready', 'manual_review', 'resolved')),
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  snapshot_bytes INTEGER NOT NULL CHECK(snapshot_bytes > 0 AND snapshot_bytes <= 12288),
  snapshot_expires_at INTEGER NOT NULL,
  provider_boundary TEXT NOT NULL CHECK(provider_boundary IN ('not_started', 'calling', 'returned', 'unknown')),
  lease_id TEXT,
  claim_generation INTEGER NOT NULL CHECK(claim_generation >= 0),
  lease_expires_at INTEGER,
  safe_retry_count INTEGER NOT NULL DEFAULT 0 CHECK(safe_retry_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  decision_json TEXT,
  result_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runtime_moderator_judgement_jobs_ready
  ON runtime_moderator_judgement_jobs(state, next_attempt_at, lease_expires_at);
CREATE TABLE IF NOT EXISTS runtime_inbound_update_conflicts (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES runtime_inbound_update_receipts(receipt_id),
  revision_identity TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  UNIQUE(receipt_id, payload_fingerprint)
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
  -- Модель и затраты модерации. Это самый частый платный вызов рантайма:
  -- модерация идёт на КАЖДОМ сообщении, а её расход не хранился нигде, тогда
  -- как анализатор и ответ свои токены уже пишут. Счётчики суммируют ОБЕ
  -- ступени контракта (роутер и, когда он был, классификатор тяжести):
  -- квитанция последнего вызова занизила бы счёт ровно на целый вызов.
  -- NULL означает «не измерено», а не «бесплатно»: вызова не было вовсе
  -- (освобождённый отправитель), провайдер расход не назвал, либо строка
  -- восстановлена процессом, который сам никого не вызывал.
  model_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
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
CREATE TABLE IF NOT EXISTS runtime_assistant_question_claims (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing', 'completed')),
  outcome TEXT,
  claimed_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (chat_id, message_id)
);
-- A bare /ask is a short-lived UI interaction, but its expiry must survive a
-- process restart. This table retains only native identifiers, never message
-- text. A single fenced cleanup claim owns all external deletes.
CREATE TABLE IF NOT EXISTS runtime_assistant_ask_prompt_jobs (
  event_id TEXT PRIMARY KEY REFERENCES runtime_inbound_events(event_id),
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  command_message_id TEXT NOT NULL,
  prompt_message_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'question_received', 'calling', 'finished', 'skipped', 'uncertain')),
  claim_id TEXT,
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK(claim_generation >= 0),
  result_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(chat_id, user_id, prompt_message_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_assistant_ask_prompt_jobs_due
  ON runtime_assistant_ask_prompt_jobs(state, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_runtime_assistant_ask_prompt_jobs_command
  ON runtime_assistant_ask_prompt_jobs(chat_id, user_id, command_message_id);
-- Native edit evidence is monotonic and indexed, including edits witnessed
-- before the original or by the other bot stream. No message bodies are kept.
CREATE TABLE IF NOT EXISTS runtime_assistant_ask_native_observations (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  edited INTEGER NOT NULL CHECK(edited IN (0, 1)),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id, message_id)
);
-- A Telegram reply can arrive while sendMessage is still awaiting its ACK.
-- Keep identifiers only so the later hint job can reconcile that observation.
CREATE TABLE IF NOT EXISTS runtime_assistant_ask_reply_observations (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  prompt_message_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  answer_event_id TEXT,
  PRIMARY KEY(chat_id, user_id, prompt_message_id)
);
-- A reservation starts before model/delivery work and is released only for a
-- definitely-unsent reply. The uncertain state is intentionally retained: the inbound
-- delivery receipt will not blindly replay a Telegram action with an unknown
-- outcome.
CREATE TABLE IF NOT EXISTS runtime_assistant_request_reservations (
  event_id TEXT PRIMARY KEY REFERENCES runtime_inbound_events(event_id),
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'completed', 'uncertain')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runtime_assistant_request_rate
  ON runtime_assistant_request_reservations(chat_id, user_id, status, created_at);
CREATE TABLE IF NOT EXISTS runtime_assistant_moderation_dispositions (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'allowed', 'blocked', 'error')),
  moderation_message_id TEXT,
  verdict TEXT,
  reason TEXT,
  moderation_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_assistant_moderation_status
  ON runtime_assistant_moderation_dispositions(status, updated_at);
CREATE TABLE IF NOT EXISTS runtime_moderation_weak_strikes (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  weak_strikes INTEGER NOT NULL CHECK(weak_strikes >= 0),
  warning_stage TEXT NOT NULL DEFAULT 'none' CHECK(warning_stage IN ('none', 'first', 'final')),
  warning_delivered_at INTEGER,
  last_event_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
-- One native Telegram message may have several edit revisions. A weak-abuse
-- strike is claimed at most once across those revisions, matching the deployed
-- Guard policy and preventing edits from escalating a member repeatedly.
CREATE TABLE IF NOT EXISTS runtime_moderation_message_ledger (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT,
  latest_revision_identity TEXT NOT NULL,
  weak_strike_event_id TEXT,
  deletion_state TEXT,
  deletion_at INTEGER,
  PRIMARY KEY (chat_id, message_id)
);
-- External enforcement is a finite state machine. It deliberately contains no
-- source text, answer text, token, or raw Telegram payload. A step marked
-- calling or uncertain is never re-issued automatically because Telegram
-- action endpoints do not offer a caller-provided idempotency key.
CREATE TABLE IF NOT EXISTS runtime_moderation_enforcement_receipts (
  event_id TEXT PRIMARY KEY REFERENCES runtime_inbound_events(event_id),
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  policy_action TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  guard_proof_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('planned', 'calling', 'completed', 'skipped', 'uncertain')),
  receipt_json TEXT,
  error_code TEXT,
  claim_id TEXT NOT NULL,
  claim_generation INTEGER NOT NULL CHECK(claim_generation >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runtime_moderation_enforcement_recovery
  ON runtime_moderation_enforcement_receipts(status, updated_at);
-- Pin governance is separate from safety enforcement.  Telegram can surface
-- one channel auto-forward as both the post and a pinned-message service event;
-- this native-key claim makes the harmless unpin exactly-once across those
-- deliveries and keeps an unknown Telegram outcome fenced for operator review.
CREATE TABLE IF NOT EXISTS runtime_moderation_auto_unpins (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  first_event_id TEXT NOT NULL UNIQUE REFERENCES runtime_inbound_events(event_id),
  state TEXT NOT NULL CHECK(state IN ('planned', 'calling', 'completed', 'skipped', 'uncertain')),
  result_json TEXT,
  error_code TEXT,
  claimed_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_moderation_auto_unpins_recovery
  ON runtime_moderation_auto_unpins(state, claimed_at);
-- A manual/owner pin is never unpinned.  Retaining its native identity mirrors
-- the deployed Moderator's owner-pin state without storing message text.
CREATE TABLE IF NOT EXISTS runtime_moderation_owner_pins (
  chat_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES runtime_inbound_events(event_id),
  remembered_at INTEGER NOT NULL
);
-- The coverage-deficits journal: every out-of-coverage abstention is a signal
-- of interest and the queue for future domains. It accumulates passively; the
-- lab reads it as an export file. candidate_level is a crude queue label
-- ('L2' business gap, 'L3' worldview gap), never a routing decision.
CREATE TABLE IF NOT EXISTS runtime_assistant_coverage_deficits (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT,
  question TEXT NOT NULL,
  reason TEXT NOT NULL,
  candidate_level TEXT CHECK(candidate_level IN ('L2', 'L3')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_assistant_coverage_deficits_time
  ON runtime_assistant_coverage_deficits(created_at);
-- Журнал наблюдений анализатора. Отдельная таблица, а не квитанция хода:
-- runtime_assistant_turns — ОГРАНИЧЕННАЯ память диалога (последние N ходов,
-- TTL), её строки удаляются по ходу разговора. Замер, живущий в такой памяти,
-- исчезал бы вместе с ней, и «данных нет» читалось бы как «ничего не
-- происходило». Здесь строка живёт, пока её не убрали намеренно.
CREATE TABLE IF NOT EXISTS runtime_assistant_analyzer_observations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok', 'invalid', 'error')),
  topics TEXT,
  level TEXT,
  level_confidence TEXT,
  intent TEXT,
  intent_confidence TEXT,
  hints TEXT,
  route_action TEXT,
  route_source_id TEXT,
  verdict_json TEXT,
  -- Долг детектора: спор слоёв маршрута, разрешённый в пользу слоя с
  -- доказанной точностью (ANALYZER-SPEC §2.3а, правило 3). В route_action
  -- после перебивания стоит домен победителя, поэтому проигравший голос без
  -- этой колонки исчезал бы бесследно — вместе с уликой о пробеле детектора.
  detector_debt TEXT,
  model_id TEXT,
  -- Затраты вызова анализатора. Имена полей повторяют лабораторные
  -- (dialogue_eval/judge.py: prompt/completion/total → input/output/total),
  -- чтобы цифры боя и лаборатории складывались одной линейкой. NULL означает
  -- «провайдер расход не назвал», а не «расхода не было»: ноль сделал бы
  -- неучтённый вызов неотличимым от бесплатного и занизил бы сумму молча.
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  -- Второй платный вызов того же хода — модельный роутер. Он живёт здесь, а не
  -- в записи ответа, потому что эта строка пишется на КАЖДОМ ходу, включая
  -- ходы, закончившиеся отказом и не дошедшие до ответа: оплаченный вызов,
  -- не оставивший следа, и есть та дыра в учёте, ради которой заведены колонки.
  -- Своя модель у роутера отдельно: складывать токены разных моделей в одно
  -- число значит потерять то, чем эта сумма была оплачена.
  route_model_id TEXT,
  route_input_tokens INTEGER,
  route_output_tokens INTEGER,
  route_total_tokens INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_assistant_analyzer_observations_time
  ON runtime_assistant_analyzer_observations(created_at);
-- Долговечная пара «вопрос → ответ»: то, что человек реально получил. Нужна
-- приёмочному контуру — без текста ответа судить можно только маршрут.
--
-- Отдельная таблица, а не колонки к соседям, и это выбор из трёх мест:
--   · runtime_assistant_turns — ОГРАНИЧЕННАЯ память диалога (последние N ходов
--     и TTL): её строки стирает сам разговор, и замер, живущий в ней, исчезал
--     бы вместе с ними — «данных нет» читалось бы как «ничего не было»;
--   · runtime_assistant_analyzer_observations — НЕИЗМЕНЯЕМАЯ запись вердикта:
--     пишется до ответа и ровно один раз (INSERT OR IGNORE). Дописать ответ
--     туда значило бы сделать журнал мутируемым и терять ответ каждый раз,
--     когда строка журнала не удалась; к тому же ответ существует и там, где
--     вердикта нет вовсе (детерминированный путь, сбой анализатора).
-- Связь — по event_id, один ход = по строке в каждой таблице: отказ одного
-- сенсора не уносит с собой второй.
--
-- Внешнего ключа на runtime_inbound_events здесь намеренно нет — ровно как у
-- журнала наблюдений: сенсор не имеет права отменить ответ человеку
-- нарушением ссылочной целостности.
CREATE TABLE IF NOT EXISTS runtime_assistant_answer_records (
  event_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  route_action TEXT,
  route_source_id TEXT,
  knowledge_source_id TEXT,
  served_unit_ids TEXT,
  model_id TEXT,
  -- Затраты вызова ОТВЕТА, тем же контрактом полей, что в журнале наблюдений.
  -- Пустые счётчики законны: детерминированный ответ (граница, воздержание)
  -- модель не вызывает, и платить там нечем.
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  delivery TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_assistant_answer_records_dialogue
  ON runtime_assistant_answer_records(chat_id, user_id, created_at);
`;

const MIGRATION_RECEIPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_migration_receipts (
  bundle_id TEXT PRIMARY KEY,
  payload_sha256 TEXT NOT NULL UNIQUE,
  source_commit TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  controller_lease_id TEXT NOT NULL,
  product_owner_approval_id TEXT NOT NULL,
  record_count INTEGER NOT NULL CHECK(record_count >= 0),
  record_summary_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

export function openRuntimeDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  ensureRuntimeDatabaseSchema(db);
  return db;
}

export function ensureRuntimeDatabaseSchema(db) {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  if (!db.prepare('PRAGMA table_info(runtime_assistant_ask_reply_observations)').all()
    .some((column) => column.name === 'answer_event_id')) {
    db.exec('ALTER TABLE runtime_assistant_ask_reply_observations ADD COLUMN answer_event_id TEXT');
  }
  // SQLite cannot extend a CHECK constraint in place. The immediately prior
  // standalone schema lacked `decision_ready`; rebuild only that private queue
  // while preserving every row and its inbound foreign keys. Its historical
  // returned/no-receipt rows are precisely the old crash window: no Guard
  // receipt exists, so no Guard call could have started and they can safely be
  // resumed from the durable provider result.
  const moderatorJobSql = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'runtime_moderator_judgement_jobs'`).get()?.sql || '';
  if (!moderatorJobSql.includes("'decision_ready'")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE runtime_moderator_judgement_jobs_recovery (
          event_id TEXT PRIMARY KEY REFERENCES runtime_inbound_events(event_id),
          receipt_id TEXT NOT NULL UNIQUE REFERENCES runtime_inbound_update_receipts(receipt_id),
          state TEXT NOT NULL CHECK(state IN ('safe_retry', 'calling', 'decision_ready', 'manual_review', 'resolved')),
          snapshot_json TEXT NOT NULL,
          snapshot_sha256 TEXT NOT NULL,
          snapshot_bytes INTEGER NOT NULL CHECK(snapshot_bytes > 0 AND snapshot_bytes <= 12288),
          snapshot_expires_at INTEGER NOT NULL,
          provider_boundary TEXT NOT NULL CHECK(provider_boundary IN ('not_started', 'calling', 'returned', 'unknown')),
          lease_id TEXT,
          claim_generation INTEGER NOT NULL CHECK(claim_generation >= 0),
          lease_expires_at INTEGER,
          safe_retry_count INTEGER NOT NULL DEFAULT 0 CHECK(safe_retry_count >= 0),
          next_attempt_at INTEGER NOT NULL,
          decision_json TEXT,
          result_json TEXT,
          error_code TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          resolved_at INTEGER
        );
        INSERT INTO runtime_moderator_judgement_jobs_recovery
          SELECT * FROM runtime_moderator_judgement_jobs;
        DROP TABLE runtime_moderator_judgement_jobs;
        ALTER TABLE runtime_moderator_judgement_jobs_recovery RENAME TO runtime_moderator_judgement_jobs;
        CREATE INDEX idx_runtime_moderator_judgement_jobs_ready
          ON runtime_moderator_judgement_jobs(state, next_attempt_at, lease_expires_at);
      `);
      db.prepare(`UPDATE runtime_moderator_judgement_jobs
        SET state = 'decision_ready', resolved_at = NULL
        WHERE state = 'resolved' AND provider_boundary = 'returned' AND decision_json IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM runtime_moderation_enforcement_receipts enforcement
            WHERE enforcement.event_id = runtime_moderator_judgement_jobs.event_id
          )`).run();
    })();
  }
  // The pre-Guard standalone runtime created this table without warning state.
  // Keep the expansion guarded and additive so an existing isolated runtime DB
  // opens safely without a destructive table rebuild.
  const columns = new Set(db.prepare('PRAGMA table_info(runtime_moderation_weak_strikes)').all().map((row) => row.name));
  if (!columns.has('warning_stage')) db.exec("ALTER TABLE runtime_moderation_weak_strikes ADD COLUMN warning_stage TEXT NOT NULL DEFAULT 'none'");
  if (!columns.has('warning_delivered_at')) db.exec('ALTER TABLE runtime_moderation_weak_strikes ADD COLUMN warning_delivered_at INTEGER');
  if (!columns.has('last_event_id')) db.exec('ALTER TABLE runtime_moderation_weak_strikes ADD COLUMN last_event_id TEXT');
  const messageColumns = new Set(db.prepare('PRAGMA table_info(runtime_moderation_message_ledger)').all().map((row) => row.name));
  if (!messageColumns.has('user_id')) db.exec('ALTER TABLE runtime_moderation_message_ledger ADD COLUMN user_id TEXT');
  // Дописанный след падения (см. комментарий у колонки в схеме). Аддитивно:
  // существующая боевая база открывается без перестройки таблицы.
  const receiptColumns = new Set(db.prepare('PRAGMA table_info(runtime_inbound_update_receipts)').all().map((row) => row.name));
  if (!receiptColumns.has('error_text')) db.exec('ALTER TABLE runtime_inbound_update_receipts ADD COLUMN error_text TEXT');
  // Долг детектора дописан к уже существующему журналу наблюдений.
  // Аддитивно: боевая база с накопленными наблюдениями открывается без
  // перестройки таблицы и без потери прежних строк.
  const observationColumns = new Set(db.prepare('PRAGMA table_info(runtime_assistant_analyzer_observations)').all().map((row) => row.name));
  if (!observationColumns.has('detector_debt')) db.exec('ALTER TABLE runtime_assistant_analyzer_observations ADD COLUMN detector_debt TEXT');
  // Учёт затрат дописан к обеим таблицам тем же аддитивным приёмом: боевая
  // база, накопившая ходы без счётчиков, открывается как есть, старые строки
  // остаются с NULL (расход тех ходов не измерен и выдумывать его нечем), а
  // новые пишутся уже с токенами.
  for (const column of ['input_tokens', 'output_tokens', 'total_tokens', 'route_input_tokens',
    'route_output_tokens', 'route_total_tokens']) {
    if (!observationColumns.has(column)) db.exec(`ALTER TABLE runtime_assistant_analyzer_observations ADD COLUMN ${column} INTEGER`);
  }
  if (!observationColumns.has('route_model_id')) db.exec('ALTER TABLE runtime_assistant_analyzer_observations ADD COLUMN route_model_id TEXT');
  const answerColumns = new Set(db.prepare('PRAGMA table_info(runtime_assistant_answer_records)').all().map((row) => row.name));
  for (const column of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (!answerColumns.has(column)) db.exec(`ALTER TABLE runtime_assistant_answer_records ADD COLUMN ${column} INTEGER`);
  }
  // Тем же приёмом — записи модерации. Боевая база накопила их больше всего
  // (вызов на каждом сообщении), поэтому перестройка таблицы здесь особенно
  // недопустима: прежние строки остаются с NULL, новые пишутся с токенами.
  const moderationColumns = new Set(db.prepare('PRAGMA table_info(runtime_moderation_records)').all().map((row) => row.name));
  for (const column of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (!moderationColumns.has(column)) db.exec(`ALTER TABLE runtime_moderation_records ADD COLUMN ${column} INTEGER`);
  }
  if (!moderationColumns.has('model_id')) db.exec('ALTER TABLE runtime_moderation_records ADD COLUMN model_id TEXT');
}

/**
 * Used only by the state importer. Existing files are opened without schema or
 * journal changes so the importer can prove they are the runtime database
 * before it mutates them.
 */
export function openRuntimeDatabaseForImport(databasePath) {
  return new Database(databasePath);
}

export function openReadOnlyRuntimeDatabase(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * The state importer calls this inside its transaction. The runtime itself does
 * not create migration receipts during normal webhook processing.
 */
export function ensureRuntimeMigrationReceiptSchema(db) {
  db.exec(MIGRATION_RECEIPT_SCHEMA);
}

const MODERATOR_SNAPSHOT_VERSION = 'moderator-comment-v1';
const MAX_MODERATOR_SNAPSHOT_TEXT = 8_192;
const MAX_MODERATOR_SNAPSHOT_BYTES = 12_288;

function boundedSnapshotString(value, { max, nullable = false } = {}) {
  if (value == null && nullable) return null;
  const normalized = String(value ?? '');
  if (!normalized || normalized.length > max) throw new Error('moderator snapshot contains an invalid field');
  return normalized;
}

/**
 * The only durable copy of message text used by Moderator recovery. Keep this
 * allowlist intentionally small: it is sufficient to repeat a provably
 * pre-provider attempt, but cannot reconstruct a raw Telegram update.
 */
function serializeModeratorSnapshot(comment) {
  const snapshot = {
    schemaVersion: MODERATOR_SNAPSHOT_VERSION,
    comment: {
      chatId: boundedSnapshotString(comment?.chatId, { max: 128 }),
      messageId: boundedSnapshotString(comment?.messageId, { max: 128 }),
      platformMessageId: boundedSnapshotString(comment?.platformMessageId, { max: 256 }),
      userId: boundedSnapshotString(comment?.userId, { max: 128, nullable: true }),
      senderChatId: boundedSnapshotString(comment?.senderChatId, { max: 128, nullable: true }),
      isBot: comment?.isBot === true,
      hasLink: comment?.hasLink === true,
      text: boundedSnapshotString(comment?.text, { max: MAX_MODERATOR_SNAPSHOT_TEXT }),
    },
  };
  const json = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_MODERATOR_SNAPSHOT_BYTES) throw new Error('moderator snapshot exceeds its private byte limit');
  return {
    json,
    bytes,
    sha256: createHash('sha256').update(json).digest('hex'),
  };
}

/**
 * Счётчик токенов на запись: целое ≥ 0 либо NULL. Приведения «пусто → ноль»
 * здесь нет и быть не может — неизмеренный расход обязан остаться отличимым от
 * нулевого, иначе сумма по журналу занижается молча. Тот же контракт, что у
 * `providerCallUsage` в адаптере провайдера: бухгалтерия — код, и она одна.
 */
function tokenColumn(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function usageColumns(usage) {
  return {
    modelId: typeof usage?.modelId === 'string' && usage.modelId ? usage.modelId.slice(0, 200) : null,
    inputTokens: tokenColumn(usage?.inputTokens),
    outputTokens: tokenColumn(usage?.outputTokens),
    totalTokens: tokenColumn(usage?.totalTokens),
  };
}

/** Чтение затрат обратно: старая строка без счётчиков читается как «не измерено». */
function usageOf(row, prefix = '') {
  return {
    inputTokens: tokenColumn(row?.[`${prefix}input_tokens`]),
    outputTokens: tokenColumn(row?.[`${prefix}output_tokens`]),
    totalTokens: tokenColumn(row?.[`${prefix}total_tokens`]),
  };
}

export function createRuntimeStore(db, {
  now = () => Math.floor(Date.now() / 1000),
  nowMs = () => Date.now(),
} = {}) {
  const judgementStore = createJudgementStore(db, { now });
  const answerClaims = createJudgementAnswerClaims(db, { now });
  const claim = db.prepare(`INSERT INTO runtime_inbound_events
    (event_id, bot_role, update_id, status, created_at) VALUES (?, ?, ?, 'processing', ?)
    ON CONFLICT(event_id) DO NOTHING`);
  const event = db.prepare('SELECT * FROM runtime_inbound_events WHERE event_id = ?');
  const finish = db.prepare(`UPDATE runtime_inbound_events
    SET status = ?, result_json = ?, error_text = ?, completed_at = ? WHERE event_id = ?`);
  // No new table/index or message text: prompt ownership lives in the existing
  // completed empty-command receipt. Bound work BEFORE filtering so a large
  // historical ledger cannot turn best-effort UI cleanup into a full scan.
  const recentAskEvents = db.prepare(`SELECT event_id, bot_role, status, result_json, created_at
    FROM runtime_inbound_events ORDER BY rowid DESC LIMIT 2048`);
  const recentAskReceipts = db.prepare(`SELECT receipt_id, bot_role, update_id, revision_identity, received_at
    FROM runtime_inbound_update_receipts ORDER BY rowid DESC LIMIT 2048`);
  function askCommandUnedited({ eventId, chatId, commandMessageId }) {
    const rows = recentAskReceipts.all();
    const original = rows.find((row) => row.receipt_id === String(eventId) && row.bot_role === 'assistant');
    const at = now();
    if (!original || original.revision_identity !== `${chatId}:${commandMessageId}`
      || original.received_at < at - 47 * 60 * 60 || original.received_at > at) return false;
    // No status filter: even processing/uncertain/skipped edits revoke deletion
    // authority. Both role streams can witness an edit of the same message.
    if (rows.some((row) => row.revision_identity.startsWith(`${chatId}:edit:`)
      && row.revision_identity.endsWith(`:${commandMessageId}`))) return false;
    if (rows.length === 2048) {
      const otherAssistantIds = rows.filter((row) => row.bot_role === 'assistant'
        && row.receipt_id !== original.receipt_id).map((row) => row.update_id);
      // An out-of-order original can arrive after its edit fell out of this
      // bounded window. Reject originals older than the retained role boundary;
      // with no retained same-role boundary, absence of edits is not proof.
      if (!otherAssistantIds.length || original.update_id < Math.min(...otherAssistantIds)) return false;
    }
    return true;
  }
  const writeAskResult = db.prepare(`UPDATE runtime_inbound_events SET result_json = ?
    WHERE event_id = ? AND status = 'completed' AND result_json = ?`);
  function pendingAskPrompt({ chatId, userId, promptMessageId = null, commandMessageId = null }) {
    const at = now();
    for (const row of recentAskEvents.all()) {
      // New jobs, including skipped/finished/uncertain ones, never re-enter
      // the old receipt-only cleanup lane.
      if (askPromptJob.get(row.event_id)) continue;
      if (row.bot_role !== 'assistant' || row.status !== 'completed'
        || row.created_at < at - 47 * 60 * 60 || row.created_at > at) continue;
      let result;
      try { result = JSON.parse(row.result_json); } catch { continue; }
      const prompt = result?.askPrompt;
      if (result?.route !== 'command:ask_empty' || result?.command !== 'ask_empty'
        || result?.kind !== 'answered' || result?.receipt?.ok !== true
        || result.askPromptCleanup != null || !prompt
        || String(prompt.chatId) !== String(chatId) || String(prompt.userId) !== String(userId)
        || !/^\d+$/.test(String(prompt.commandMessageId)) || !/^\d+$/.test(String(prompt.promptMessageId))
        || String(prompt.commandMessageId) === String(prompt.promptMessageId)
        || String(result.receipt.messageId) !== String(prompt.promptMessageId)
        || (promptMessageId != null && String(prompt.promptMessageId) !== String(promptMessageId))
        || (commandMessageId != null && String(prompt.commandMessageId) !== String(commandMessageId))) continue;
      return { row, result, prompt };
    }
    return null;
  }
  const claimAskCleanup = db.transaction((input) => {
    const found = pendingAskPrompt(input);
    if (!found || !askCommandUnedited({ eventId: found.row.event_id, ...found.prompt })
      || [found.prompt.commandMessageId, found.prompt.promptMessageId]
      .map(String).includes(String(input.questionMessageId))) return null;
    const cleanup = { state: 'calling', answerEventId: String(input.answerEventId), claimedAt: now() };
    const changed = writeAskResult.run(JSON.stringify({ ...found.result, askPromptCleanup: cleanup }),
      found.row.event_id, found.row.result_json).changes === 1;
    return changed ? { eventId: found.row.event_id, ...found.prompt, ...cleanup } : null;
  });
  const finishAskCleanup = db.transaction(({ claim: cleanupClaim, prompt, command }) => {
    const row = event.get(cleanupClaim.eventId);
    if (!row || row.status !== 'completed') return false;
    let result;
    try { result = JSON.parse(row.result_json); } catch { return false; }
    const cleanup = result?.askPromptCleanup;
    if (cleanup?.state !== 'calling' || cleanup.answerEventId !== cleanupClaim.answerEventId
      || cleanup.claimedAt !== cleanupClaim.claimedAt) return false;
    return writeAskResult.run(JSON.stringify({ ...result, askPromptCleanup: {
      ...cleanup, state: 'finished', completedAt: now(), prompt, command,
    } }), row.event_id, row.result_json).changes === 1;
  });
  const invalidateAskPrompt = db.transaction((input) => {
    const found = pendingAskPrompt(input);
    if (!found) return false;
    return writeAskResult.run(JSON.stringify({ ...found.result, askPromptCleanup: {
      state: 'skipped', reason: 'command_edited', completedAt: now(),
    } }), found.row.event_id, found.row.result_json).changes === 1;
  });
  const askPromptJob = db.prepare('SELECT * FROM runtime_assistant_ask_prompt_jobs WHERE event_id = ?');
  const askPromptJobByPrompt = db.prepare(`SELECT * FROM runtime_assistant_ask_prompt_jobs
    WHERE chat_id = ? AND user_id = ? AND prompt_message_id = ?`);
  const askPromptJobByCommand = db.prepare(`SELECT * FROM runtime_assistant_ask_prompt_jobs
    WHERE chat_id = ? AND user_id = ? AND command_message_id = ?`);
  const nativeAskObservation = db.prepare(`SELECT * FROM runtime_assistant_ask_native_observations
    WHERE chat_id = ? AND message_id = ?`);
  const writeNativeAskObservation = db.prepare(`INSERT INTO runtime_assistant_ask_native_observations
    (chat_id, message_id, edited, observed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET edited = MAX(edited, excluded.edited)`);
  const askReplyObservation = db.prepare(`SELECT * FROM runtime_assistant_ask_reply_observations
    WHERE chat_id = ? AND user_id = ? AND prompt_message_id = ?`);
  const writeAskReplyObservation = db.prepare(`INSERT INTO runtime_assistant_ask_reply_observations
    (chat_id, user_id, prompt_message_id, observed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, user_id, prompt_message_id) DO NOTHING`);
  const writeAskAnswerObservation = db.prepare(`UPDATE runtime_assistant_ask_reply_observations
    SET answer_event_id = ? WHERE chat_id = ? AND user_id = ? AND prompt_message_id = ?
    AND answer_event_id IS NULL`);
  const issuedAskClaims = new WeakSet();
  const createAskPromptJob = db.prepare(`INSERT INTO runtime_assistant_ask_prompt_jobs
    (event_id, chat_id, user_id, command_message_id, prompt_message_id, expires_at_ms, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(event_id) DO NOTHING`);
  const receiveAskPromptQuestion = db.prepare(`UPDATE runtime_assistant_ask_prompt_jobs
    SET state = 'question_received', updated_at = ?
    WHERE event_id = ? AND state = 'pending'`);
  const nextDueAskPromptJob = db.prepare(`SELECT * FROM runtime_assistant_ask_prompt_jobs
    WHERE state = 'pending' AND expires_at_ms <= ? ORDER BY expires_at_ms ASC, event_id ASC LIMIT 1`);
  const nextCompletedAskPromptJob = db.prepare(`SELECT jobs.* FROM runtime_assistant_ask_prompt_jobs jobs
    JOIN runtime_assistant_ask_reply_observations replies ON replies.chat_id = jobs.chat_id
      AND replies.user_id = jobs.user_id AND replies.prompt_message_id = jobs.prompt_message_id
    WHERE jobs.state = 'question_received' AND replies.answer_event_id IS NOT NULL
    ORDER BY jobs.expires_at_ms ASC, jobs.event_id ASC LIMIT 1`);
  const claimDueAskPromptJob = db.prepare(`UPDATE runtime_assistant_ask_prompt_jobs
    SET state = 'calling', claim_id = ?, claim_generation = claim_generation + 1, updated_at = ?
    WHERE event_id = ? AND state = 'pending' AND expires_at_ms <= ?`);
  const claimAnsweredAskPromptJob = db.prepare(`UPDATE runtime_assistant_ask_prompt_jobs
    SET state = 'calling', claim_id = ?, claim_generation = claim_generation + 1, updated_at = ?
    WHERE event_id = ? AND state = 'question_received'`);
  const completeAskPromptJob = db.prepare(`UPDATE runtime_assistant_ask_prompt_jobs
    SET state = ?, result_json = ?, error_code = ?, updated_at = ?, completed_at = ?
    WHERE event_id = ? AND state = 'calling' AND claim_id = ? AND claim_generation = ?`);
  const skipAskPromptJob = db.prepare(`UPDATE runtime_assistant_ask_prompt_jobs
    SET state = 'skipped', error_code = ?, updated_at = ?, completed_at = ?
    WHERE event_id = ? AND state IN ('pending', 'question_received')`);
  const promptJobCounts = db.prepare(`SELECT state, COUNT(*) AS count FROM runtime_assistant_ask_prompt_jobs GROUP BY state`);
  function promptJobClaim(row, claimId, source) {
    const result = Object.freeze({
      eventId: row.event_id, chatId: row.chat_id, userId: row.user_id,
      commandMessageId: row.command_message_id, promptMessageId: row.prompt_message_id,
      claimId, claimGeneration: Number(row.claim_generation) + 1, source, durable: true,
    });
    issuedAskClaims.add(result);
    return result;
  }
  function askCleanupAuthority(row) {
    const original = inboundReceipt.get(row.event_id);
    if (!original || original.bot_role !== 'assistant'
      || original.revision_identity !== `${row.chat_id}:${row.command_message_id}`) return 'original_unproven';
    const at = nowMs();
    if (original.received_at * 1000 > at || original.received_at * 1000 < at - 47 * 60 * 60 * 1000) {
      return 'cleanup_authority_expired';
    }
    const native = nativeAskObservation.get(row.chat_id, row.command_message_id);
    return !native ? 'original_unproven' : native.edited ? 'command_edited' : null;
  }
  function validAskClaim(input) {
    if (!input || !issuedAskClaims.has(input)) return false;
    const row = askPromptJob.get(input.eventId);
    return row?.state === 'calling' && row.claim_id === input.claimId
      && row.claim_generation === input.claimGeneration && row.chat_id === input.chatId
      && row.user_id === input.userId && row.command_message_id === input.commandMessageId
      && row.prompt_message_id === input.promptMessageId;
  }
  function durableAskCommandUnedited(input) {
    return validAskClaim(input) && askCleanupAuthority(askPromptJob.get(input.eventId)) == null;
  }
  function skipDurableAskPromptJob(row, reason) {
    const changed = skipAskPromptJob.run(reason, now(), now(), row.event_id).changes === 1;
    if (!changed) return false;
    const source = event.get(row.event_id);
    let result;
    try { result = JSON.parse(source?.result_json); } catch { return true; }
    if (result?.askPrompt && result.askPromptCleanup == null) {
      writeAskResult.run(JSON.stringify({ ...result, askPromptCleanup: {
        state: 'skipped', reason, completedAt: now(),
      } }), row.event_id, source.result_json);
    }
    return true;
  }
  function claimAskPromptJob(row, source) {
    if (!row) return null;
    const authorityError = askCleanupAuthority(row);
    if (authorityError) {
      skipDurableAskPromptJob(row, authorityError);
      return null;
    }
    const claimId = randomUUID();
    const changed = source === 'expiry'
      ? claimDueAskPromptJob.run(claimId, now(), row.event_id, nowMs()).changes === 1
      : claimAnsweredAskPromptJob.run(claimId, now(), row.event_id).changes === 1;
    return changed ? promptJobClaim(row, claimId, source) : null;
  }
  const inboundReceipt = db.prepare('SELECT * FROM runtime_inbound_update_receipts WHERE receipt_id = ?');
  const createInboundReceipt = db.prepare(`INSERT INTO runtime_inbound_update_receipts
    (receipt_id, bot_role, update_id, revision_identity, payload_fingerprint,
     claim_id, claim_generation, status, received_at, claimed_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'processing', ?, ?)
    ON CONFLICT(receipt_id) DO NOTHING`);
  const completeInboundReceipt = db.prepare(`UPDATE runtime_inbound_update_receipts
    SET status = ?, result_json = ?, error_code = NULL, completed_at = ?
    WHERE receipt_id = ? AND claim_id = ? AND claim_generation = ? AND status = 'processing'`);
  const markInboundReceiptUncertain = db.prepare(`UPDATE runtime_inbound_update_receipts
    SET status = 'uncertain', error_code = ?, error_text = ?, completed_at = NULL
    WHERE receipt_id = ? AND claim_id = ? AND claim_generation = ? AND status = 'processing'`);
  const quarantineInboundReceipts = db.prepare(`UPDATE runtime_inbound_update_receipts
    SET status = 'uncertain', error_code = 'recovery_required', recovery_id = ?,
        recovered_at = ?, claim_generation = claim_generation + 1
    WHERE status = 'processing'`);
  const listInboundRecovery = db.prepare(`SELECT * FROM runtime_inbound_update_receipts
    WHERE status IN ('processing', 'uncertain') ORDER BY received_at ASC, receipt_id ASC LIMIT ?`);
  const recordInboundConflict = db.prepare(`INSERT INTO runtime_inbound_update_conflicts
    (id, receipt_id, revision_identity, payload_fingerprint, observed_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(receipt_id, payload_fingerprint) DO NOTHING`);
  const moderatorJob = db.prepare('SELECT * FROM runtime_moderator_judgement_jobs WHERE event_id = ?');
  const createModeratorJob = db.prepare(`INSERT INTO runtime_moderator_judgement_jobs
    (event_id, receipt_id, state, snapshot_json, snapshot_sha256, snapshot_bytes, snapshot_expires_at,
     provider_boundary, claim_generation, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, 'safe_retry', ?, ?, ?, ?, 'not_started', 0, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING`);
  const claimModeratorJob = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET lease_id = ?, claim_generation = claim_generation + 1, lease_expires_at = ?, updated_at = ?
    WHERE event_id = ? AND state = 'safe_retry' AND next_attempt_at <= ?
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`);
  const markModeratorCalling = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET state = 'calling', provider_boundary = 'calling', lease_expires_at = ?, updated_at = ?
    WHERE event_id = ? AND state = 'safe_retry' AND lease_id = ? AND claim_generation = ?`);
  const deferModeratorJob = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET state = 'safe_retry', provider_boundary = 'not_started', lease_id = NULL, lease_expires_at = NULL,
      safe_retry_count = safe_retry_count + 1, next_attempt_at = ?, error_code = ?, updated_at = ?
    WHERE event_id = ? AND state IN ('safe_retry', 'calling') AND lease_id = ? AND claim_generation = ?`);
  const manualReviewModeratorJob = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET state = 'manual_review', provider_boundary = ?, lease_id = NULL, lease_expires_at = NULL,
      error_code = ?, result_json = ?, updated_at = ?
    WHERE event_id = ? AND state IN ('safe_retry', 'calling') AND lease_id = ? AND claim_generation = ?`);
  const markModeratorDecisionReady = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET state = 'decision_ready', provider_boundary = 'returned', lease_id = NULL, lease_expires_at = NULL,
      decision_json = ?, result_json = ?, error_code = NULL, updated_at = ?, resolved_at = NULL
    WHERE event_id = ? AND state IN ('safe_retry', 'calling') AND lease_id = ? AND claim_generation = ?`);
  const activeModeratorProviderClaim = db.prepare(`SELECT event_id FROM runtime_moderator_judgement_jobs
    WHERE event_id = ? AND state = 'calling' AND provider_boundary = 'calling'
      AND lease_id = ? AND claim_generation = ?`);
  const resolveModeratorJob = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET state = 'resolved', updated_at = ?, resolved_at = ?
    WHERE event_id = ? AND state = 'decision_ready'`);
  const manualReviewDecisionReadyModeratorJob = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET state = 'manual_review', error_code = ?, updated_at = ?
    WHERE event_id = ? AND state = 'decision_ready'`);
  const resolvePreProviderModeratorJob = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET state = 'resolved', provider_boundary = ?, lease_id = NULL, lease_expires_at = NULL,
      decision_json = ?, result_json = ?, error_code = NULL, updated_at = ?, resolved_at = ?
    WHERE event_id = ? AND state IN ('safe_retry', 'calling') AND lease_id = ? AND claim_generation = ?`);
  const expireCallingModeratorJobs = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET state = 'manual_review', provider_boundary = 'unknown', lease_id = NULL, lease_expires_at = NULL,
      error_code = 'provider_outcome_unknown', updated_at = ?
    WHERE state = 'calling' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`);
  const quarantineAllCallingModeratorJobs = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET state = 'manual_review', provider_boundary = 'unknown', lease_id = NULL, lease_expires_at = NULL,
      error_code = 'provider_outcome_unknown', updated_at = ?
    WHERE state = 'calling'`);
  const expireModeratorSnapshots = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET snapshot_json = '{"schemaVersion":"moderator-comment-v1","expired":true}', snapshot_sha256 = 'expired',
      snapshot_bytes = 1, snapshot_expires_at = ?, updated_at = ?
    WHERE snapshot_expires_at <= ? AND snapshot_sha256 <> 'expired'`);
  const listModeratorJobs = db.prepare(`SELECT event_id, receipt_id, state, provider_boundary, claim_generation,
    safe_retry_count, next_attempt_at, snapshot_expires_at, error_code, created_at, updated_at, resolved_at
    FROM runtime_moderator_judgement_jobs ORDER BY updated_at DESC, event_id DESC LIMIT ?`);
  const moderatorJobCounts = db.prepare(`SELECT state, COUNT(*) AS count
    FROM runtime_moderator_judgement_jobs GROUP BY state ORDER BY state ASC`);
  const nextRecoverableModeratorJob = db.prepare(`SELECT event_id FROM runtime_moderator_judgement_jobs
    WHERE state = 'safe_retry' AND next_attempt_at <= ? AND snapshot_expires_at > ?
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    ORDER BY next_attempt_at ASC, created_at ASC, event_id ASC LIMIT 1`);
  const nextDecisionReadyModeratorJob = db.prepare(`SELECT event_id FROM runtime_moderator_judgement_jobs
    WHERE state = 'decision_ready' ORDER BY updated_at ASC, created_at ASC, event_id ASC LIMIT 1`);
  const quarantineExpiredModeratorRetries = db.prepare(`UPDATE runtime_moderator_judgement_jobs
    SET state = 'manual_review', provider_boundary = 'not_started', lease_id = NULL, lease_expires_at = NULL,
      error_code = 'snapshot_expired', updated_at = ?
    WHERE state = 'safe_retry' AND snapshot_expires_at <= ?`);
  const dialogue = db.prepare('SELECT * FROM runtime_assistant_dialogues WHERE chat_id = ? AND user_id = ?');
  // Timestamps have second precision; insertion order breaks ties, not random UUIDs.
  const turns = db.prepare(`SELECT question, answer FROM runtime_assistant_turns
    WHERE dialogue_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`);
  const insertDialogue = db.prepare(`INSERT INTO runtime_assistant_dialogues
    (id, chat_id, user_id, last_activity_at) VALUES (?, ?, ?, ?)`);
  const touchDialogue = db.prepare('UPDATE runtime_assistant_dialogues SET last_activity_at = ? WHERE id = ?');
  const insertTurn = db.prepare(`INSERT INTO runtime_assistant_turns
    (id, dialogue_id, event_id, question, answer, model_id, receipt_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertModeration = db.prepare(`INSERT INTO runtime_moderation_records
    (id, event_id, chat_id, message_id, user_id, verdict, confidence, reason, mode, action_json,
     model_id, input_tokens, output_tokens, total_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING`);
  const assistantRequest = db.prepare('SELECT * FROM runtime_assistant_request_reservations WHERE event_id = ?');
  const countAssistantRequests = db.prepare(`SELECT COUNT(*) AS count FROM runtime_assistant_request_reservations
    WHERE chat_id = ? AND user_id = ? AND status IN ('reserved', 'completed', 'uncertain') AND created_at > ?`);
  const insertAssistantRequest = db.prepare(`INSERT INTO runtime_assistant_request_reservations
    (event_id, chat_id, user_id, status, created_at) VALUES (?, ?, ?, 'reserved', ?)`);
  const completeAssistantRequest = db.prepare(`UPDATE runtime_assistant_request_reservations
    SET status = 'completed', completed_at = ? WHERE event_id = ? AND status = 'reserved'`);
  const uncertainAssistantRequest = db.prepare(`UPDATE runtime_assistant_request_reservations
    SET status = 'uncertain', completed_at = ? WHERE event_id = ? AND status = 'reserved'`);
  const releaseAssistantRequest = db.prepare(`DELETE FROM runtime_assistant_request_reservations
    WHERE event_id = ? AND status = 'reserved'`);
  const insertCoverageDeficit = db.prepare(`INSERT INTO runtime_assistant_coverage_deficits
    (id, chat_id, user_id, question, reason, candidate_level, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const listCoverageDeficitRows = db.prepare(`SELECT id, chat_id, user_id, question, reason, candidate_level, created_at
    FROM runtime_assistant_coverage_deficits ORDER BY created_at DESC, id DESC LIMIT ?`);
  // OR IGNORE — повтор события (перевыдача апдейта Telegram) не должен
  // задваивать наблюдение: замер по журналу считает ходы, а не доставки.
  const insertAnalyzerObservation = db.prepare(`INSERT OR IGNORE INTO runtime_assistant_analyzer_observations
    (id, event_id, chat_id, user_id, question, status, topics, level, level_confidence,
     intent, intent_confidence, hints, route_action, route_source_id, verdict_json, detector_debt,
     model_id, input_tokens, output_tokens, total_tokens,
     route_model_id, route_input_tokens, route_output_tokens, route_total_tokens,
     error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const listAnalyzerObservationRows = db.prepare(`SELECT id, event_id, chat_id, user_id, question, status,
      topics, level, level_confidence, intent, intent_confidence, hints, route_action, route_source_id,
      verdict_json, detector_debt, model_id, input_tokens, output_tokens, total_tokens,
      route_model_id, route_input_tokens, route_output_tokens, route_total_tokens, error, created_at
    FROM runtime_assistant_analyzer_observations ORDER BY created_at DESC, id DESC LIMIT ?`);
  const listUserAnalyzerLevelRows = db.prepare(`SELECT level, level_confidence, created_at
    FROM runtime_assistant_analyzer_observations
    WHERE chat_id = ? AND user_id = ? AND status = 'ok' AND created_at >= ?
    ORDER BY created_at DESC LIMIT ?`);
  // OR IGNORE — по той же причине, что в журнале наблюдений: перевыдача
  // апдейта Telegram не имеет права задвоить ход в стенограмме. Замер считает
  // ходы, а не доставки.
  const insertAnswerRecord = db.prepare(`INSERT OR IGNORE INTO runtime_assistant_answer_records
    (event_id, chat_id, user_id, question, answer, route_action, route_source_id,
     knowledge_source_id, served_unit_ids, model_id, input_tokens, output_tokens, total_tokens,
     delivery, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const listAnswerRecordRows = db.prepare(`SELECT event_id, chat_id, user_id, question, answer,
      route_action, route_source_id, knowledge_source_id, served_unit_ids, model_id,
      input_tokens, output_tokens, total_tokens, delivery, created_at
    FROM runtime_assistant_answer_records ORDER BY created_at DESC, event_id DESC LIMIT ?`);
  const deleteExpiredDialogueTurns = db.prepare(`DELETE FROM runtime_assistant_turns
    WHERE dialogue_id IN (SELECT id FROM runtime_assistant_dialogues WHERE last_activity_at <= ?)`);
  const deleteExpiredDialogues = db.prepare('DELETE FROM runtime_assistant_dialogues WHERE last_activity_at <= ?');
  const trimDialogueTurns = db.prepare(`DELETE FROM runtime_assistant_turns
    WHERE dialogue_id = ? AND id NOT IN (
      SELECT id FROM runtime_assistant_turns WHERE dialogue_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    )`);
  const disposition = db.prepare(`SELECT * FROM runtime_assistant_moderation_dispositions
    WHERE chat_id = ? AND message_id = ?`);
  const writeDisposition = db.prepare(`INSERT INTO runtime_assistant_moderation_dispositions
    (chat_id, message_id, status, moderation_message_id, verdict, reason, moderation_event_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET
      status = CASE
        WHEN runtime_assistant_moderation_dispositions.status IN ('allowed', 'blocked')
          AND runtime_assistant_moderation_dispositions.moderation_message_id IS excluded.moderation_message_id
          AND excluded.status = 'pending'
        THEN runtime_assistant_moderation_dispositions.status
        ELSE excluded.status
      END,
      verdict = CASE
        WHEN runtime_assistant_moderation_dispositions.status IN ('allowed', 'blocked')
          AND runtime_assistant_moderation_dispositions.moderation_message_id IS excluded.moderation_message_id
          AND excluded.status = 'pending'
        THEN runtime_assistant_moderation_dispositions.verdict
        ELSE excluded.verdict
      END,
      reason = CASE
        WHEN runtime_assistant_moderation_dispositions.status IN ('allowed', 'blocked')
          AND runtime_assistant_moderation_dispositions.moderation_message_id IS excluded.moderation_message_id
          AND excluded.status = 'pending'
        THEN runtime_assistant_moderation_dispositions.reason
        ELSE excluded.reason
      END,
      moderation_event_id = CASE
        WHEN runtime_assistant_moderation_dispositions.status IN ('allowed', 'blocked')
          AND runtime_assistant_moderation_dispositions.moderation_message_id IS excluded.moderation_message_id
          AND excluded.status = 'pending'
        THEN runtime_assistant_moderation_dispositions.moderation_event_id
        ELSE excluded.moderation_event_id
      END,
      moderation_message_id = excluded.moderation_message_id,
      updated_at = excluded.updated_at`);
  const currentWeakStrikes = db.prepare(`SELECT weak_strikes FROM runtime_moderation_weak_strikes
    WHERE chat_id = ? AND user_id = ?`);
  const incrementWeakStrike = db.prepare(`INSERT INTO runtime_moderation_weak_strikes
    (chat_id, user_id, weak_strikes, last_event_id, updated_at) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      weak_strikes = runtime_moderation_weak_strikes.weak_strikes + 1,
      last_event_id = excluded.last_event_id,
      updated_at = excluded.updated_at`);
  const observeModerationMessage = db.prepare(`INSERT INTO runtime_moderation_message_ledger
    (chat_id, message_id, user_id, latest_revision_identity) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET latest_revision_identity = excluded.latest_revision_identity`);
  const observeModerationMessageWithUser = db.prepare(`INSERT INTO runtime_moderation_message_ledger
    (chat_id, message_id, user_id, latest_revision_identity) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, runtime_moderation_message_ledger.user_id),
      latest_revision_identity = excluded.latest_revision_identity`);
  const weakMessageClaim = db.prepare(`UPDATE runtime_moderation_message_ledger
    SET weak_strike_event_id = ? WHERE chat_id = ? AND message_id = ? AND weak_strike_event_id IS NULL`);
  const moderationMessage = db.prepare(`SELECT * FROM runtime_moderation_message_ledger
    WHERE chat_id = ? AND message_id = ?`);
  const knownUndeletedMessagesForUser = db.prepare(`SELECT chat_id, message_id, user_id, deletion_state
    FROM runtime_moderation_message_ledger
    WHERE chat_id = ? AND user_id = ?
      AND COALESCE(deletion_state, '') NOT IN ('deleted', 'uncertain', 'calling')
    ORDER BY rowid ASC
    LIMIT ?`);
  const markWarningDelivered = db.prepare(`UPDATE runtime_moderation_weak_strikes
    SET warning_stage = CASE WHEN warning_stage = 'final' THEN 'final' ELSE ? END,
        warning_delivered_at = ?, last_event_id = ?, updated_at = ?
    WHERE chat_id = ? AND user_id = ?`);
  const recordMessageDeletion = db.prepare(`UPDATE runtime_moderation_message_ledger
    SET deletion_state = ?, deletion_at = ? WHERE chat_id = ? AND message_id = ?`);
  const enforcementReceipt = db.prepare('SELECT * FROM runtime_moderation_enforcement_receipts WHERE event_id = ?');
  const createEnforcementReceipt = db.prepare(`INSERT INTO runtime_moderation_enforcement_receipts
    (event_id, chat_id, message_id, policy_action, policy_json, guard_proof_json,
     status, claim_id, claim_generation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, 1, ?, ?)
    ON CONFLICT(event_id) DO NOTHING`);
  const markEnforcementCalling = db.prepare(`UPDATE runtime_moderation_enforcement_receipts
    SET status = 'calling', receipt_json = ?, error_code = NULL, updated_at = ?
    WHERE event_id = ? AND claim_id = ? AND claim_generation = ? AND status IN ('planned', 'calling')`);
  const completeEnforcementReceipt = db.prepare(`UPDATE runtime_moderation_enforcement_receipts
    SET status = ?, receipt_json = ?, error_code = ?, updated_at = ?, completed_at = ?
    WHERE event_id = ? AND claim_id = ? AND claim_generation = ? AND status IN ('planned', 'calling')`);
  const resumePlannedEnforcement = db.prepare(`UPDATE runtime_moderation_enforcement_receipts
    SET claim_id = ?, claim_generation = claim_generation + 1, updated_at = ?
    WHERE event_id = ? AND status = 'planned'`);
  const autoUnpin = db.prepare(`SELECT * FROM runtime_moderation_auto_unpins
    WHERE chat_id = ? AND message_id = ?`);
  const createAutoUnpin = db.prepare(`INSERT INTO runtime_moderation_auto_unpins
    (chat_id, message_id, first_event_id, state, claimed_at)
    VALUES (?, ?, ?, 'planned', ?)
    ON CONFLICT(chat_id, message_id) DO NOTHING`);
  const markAutoUnpinCalling = db.prepare(`UPDATE runtime_moderation_auto_unpins
    SET state = 'calling', result_json = NULL, error_code = NULL
    WHERE chat_id = ? AND message_id = ? AND state = 'planned'`);
  const completeAutoUnpin = db.prepare(`UPDATE runtime_moderation_auto_unpins
    SET state = ?, result_json = ?, error_code = ?, completed_at = ?
    WHERE chat_id = ? AND message_id = ? AND state IN ('planned', 'calling')`);
  const rememberOwnerPin = db.prepare(`INSERT INTO runtime_moderation_owner_pins
    (chat_id, message_id, source_event_id, remembered_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      message_id = excluded.message_id,
      source_event_id = excluded.source_event_id,
      remembered_at = excluded.remembered_at`);
  const ownerPin = db.prepare('SELECT * FROM runtime_moderation_owner_pins WHERE chat_id = ?');
  const reserveWeakStrike = db.transaction((chatId, userId, messageId, revisionIdentity, eventId, at) => {
    observeModerationMessage.run(chatId, messageId, null, revisionIdentity);
    const before = currentWeakStrikes.get(chatId, userId)?.weak_strikes || 0;
    const claimed = weakMessageClaim.run(eventId, chatId, messageId).changes === 1;
    if (!claimed) return { claimed: false, before, after: before, row: moderationMessage.get(chatId, messageId) };
    incrementWeakStrike.run(chatId, userId, eventId, at);
    return { claimed: true, before, after: before + 1, row: moderationMessage.get(chatId, messageId) };
  });
  /**
   * The provider result, immutable enforcement policy, and (for weak abuse)
   * its native message strike reservation share one SQLite transaction. A
   * `decision_ready` row therefore never relies on a later live strike count.
   */
  const persistModeratorDecisionAndEnforcement = db.transaction(({
    claim: judgementClaim, decision, chatId, messageId, revisionIdentity,
    userId = null, isWeak = false, derivePolicy,
  }) => {
    if (!judgementClaim || typeof derivePolicy !== 'function') return { ready: false, row: null, enforcement: null };
    const normalizedEventId = String(judgementClaim.eventId);
    const normalizedChatId = String(chatId);
    const normalizedMessageId = String(messageId);
    const normalizedUserId = userId == null || String(userId) === '' ? null : String(userId);
    const active = activeModeratorProviderClaim.get(
      normalizedEventId, String(judgementClaim.leaseId), Number(judgementClaim.claimGeneration),
    );
    if (!active) return { ready: false, row: moderatorJob.get(normalizedEventId) || null, enforcement: null };
    if (enforcementReceipt.get(normalizedEventId)) {
      return { ready: false, row: moderatorJob.get(normalizedEventId) || null, enforcement: null };
    }

    const at = now();
    let strike = { claimed: false, before: 0, after: 0, row: null };
    if (isWeak && normalizedUserId) {
      observeModerationMessageWithUser.run(normalizedChatId, normalizedMessageId, normalizedUserId, String(revisionIdentity));
      const before = currentWeakStrikes.get(normalizedChatId, normalizedUserId)?.weak_strikes || 0;
      const claimed = weakMessageClaim.run(normalizedEventId, normalizedChatId, normalizedMessageId).changes === 1;
      if (claimed) incrementWeakStrike.run(normalizedChatId, normalizedUserId, normalizedEventId, at);
      strike = {
        claimed,
        before,
        after: claimed ? before + 1 : before,
        row: moderationMessage.get(normalizedChatId, normalizedMessageId),
      };
    } else {
      observeModerationMessageWithUser.run(normalizedChatId, normalizedMessageId, normalizedUserId, String(revisionIdentity));
    }

    const basePolicy = derivePolicy(strike.before);
    const policy = isWeak && normalizedUserId != null && !strike.claimed
      ? { ...basePolicy, duplicateNative: true }
      : basePolicy;
    const claimId = randomUUID();
    createEnforcementReceipt.run(
      normalizedEventId, normalizedChatId, normalizedMessageId, String(policy.action), JSON.stringify(policy),
      null, claimId, at, at,
    );
    const ready = markModeratorDecisionReady.run(
      JSON.stringify({ ...decision, plan: policy }),
      JSON.stringify({ verdict: policy.verdict, actionPlan: policy.action }),
      at, normalizedEventId, String(judgementClaim.leaseId), Number(judgementClaim.claimGeneration),
    ).changes === 1;
    if (!ready) throw new Error('moderator_decision_enforcement_claim_fenced');
    return {
      ready: true,
      row: moderatorJob.get(normalizedEventId) || null,
      enforcement: {
        claim: { eventId: normalizedEventId, claimId, claimGeneration: 1 },
        policy,
        duplicateNative: policy.duplicateNative === true,
        strike,
      },
    };
  });

  return {
    ...judgementStore,
    ...answerClaims,
    currentTime() { return now(); },
    /**
     * Create the only executable claim for a Telegram delivery. The update
     * payload itself is deliberately not copied into the inbox; its stable
     * SHA-256 fingerprint and exact revision identity are enough to detect a
     * receipt collision while avoiding a second raw-message store.
     */
    claimInboundDelivery({ receiptId, role, updateId, revisionIdentity, payloadFingerprint }) {
      return db.transaction(() => {
      const normalizedReceiptId = String(receiptId);
      const claimId = randomUUID();
      const at = now();
      const native = /^(-?\d+):(?:(edit):[^:]+:)?(\d+)$/.exec(String(revisionIdentity));
      if (native && ['assistant', 'moderator'].includes(role)) {
        writeNativeAskObservation.run(native[1], native[3], native[2] ? 1 : 0, at);
      }
      const claimed = createInboundReceipt.run(
        normalizedReceiptId, String(role), Number(updateId), String(revisionIdentity),
        String(payloadFingerprint), claimId, at, at,
      ).changes === 1;
      const existing = claimed ? null : inboundReceipt.get(normalizedReceiptId);
      const collision = !claimed && existing != null && (
        existing.bot_role !== String(role)
        || Number(existing.update_id) !== Number(updateId)
        || existing.revision_identity !== String(revisionIdentity)
        || existing.payload_fingerprint !== String(payloadFingerprint)
      );
      if (collision) {
        recordInboundConflict.run(
          randomUUID(), normalizedReceiptId, String(revisionIdentity), String(payloadFingerprint), at,
        );
      }
      return {
        claimed,
        claim: claimed ? { receiptId: normalizedReceiptId, claimId, claimGeneration: 1 } : null,
        existing,
        collision,
      };
      })();
    },
    completeInboundDelivery({ claim: inboundClaim, status, result }) {
      if (!inboundClaim || !['completed', 'skipped'].includes(status)) return { completed: false, row: null };
      const completed = completeInboundReceipt.run(
        status, JSON.stringify(result), now(), inboundClaim.receiptId,
        inboundClaim.claimId, inboundClaim.claimGeneration,
      ).changes === 1;
      return { completed, row: inboundReceipt.get(inboundClaim.receiptId) || null };
    },
    /**
     * `errorText` необязателен и аддитивен: прежние вызовы (без него) пишут
     * NULL, как и раньше. Он существует, потому что машинный `errorCode` не
     * говорит, ЧТО именно сломалось, — а без этого падение не расследуется.
     */
    markInboundDeliveryUncertain({ claim: inboundClaim, errorCode = 'runtime_error', errorText = null }) {
      if (!inboundClaim) return { marked: false, row: null };
      const marked = markInboundReceiptUncertain.run(
        String(errorCode).slice(0, 120),
        errorText == null ? null : String(errorText).slice(0, 1_000),
        inboundClaim.receiptId,
        inboundClaim.claimId, inboundClaim.claimGeneration,
      ).changes === 1;
      return { marked, row: inboundReceipt.get(inboundClaim.receiptId) || null };
    },
    /**
     * This is an explicit operator/recovery action, not a retry mechanism. It
     * fences every in-flight claim and records an observable uncertain state;
     * it never invokes a provider or Telegram adapter.
     */
    quarantineProcessingInboundDeliveries({ recoveryId }) {
      const normalizedRecoveryId = String(recoveryId || '').trim();
      if (!normalizedRecoveryId) throw new Error('recoveryId is required to quarantine inbound deliveries');
      return { recoveryId: normalizedRecoveryId, quarantined: quarantineInboundReceipts.run(normalizedRecoveryId, now()).changes };
    },
    listInboundRecovery({ limit = 50 } = {}) {
      return listInboundRecovery.all(Math.max(1, Math.min(500, Number(limit) || 50)));
    },
    getInboundDelivery(receiptId) { return inboundReceipt.get(String(receiptId)) || null; },
    /**
     * Create the private minimal recovery record before any semantic provider
     * boundary. A duplicate returns the original row and never replaces its
     * snapshot, so webhook redelivery cannot smuggle a different message into
     * an already accepted event.
     */
    ensureModeratorJudgement({ eventId, receiptId, comment, snapshotTtlSec = 604_800 }) {
      const snapshot = serializeModeratorSnapshot(comment);
      const ttl = Math.max(60, Math.min(2_592_000, Number(snapshotTtlSec) || 604_800));
      const at = now();
      createModeratorJob.run(
        String(eventId), String(receiptId), snapshot.json, snapshot.sha256, snapshot.bytes,
        at + ttl, at, at, at,
      );
      return moderatorJob.get(String(eventId)) || null;
    },
    getModeratorJudgement(eventId) { return moderatorJob.get(String(eventId)) || null; },
    /** A lease is held while harmless preflight is read, then fenced again immediately before the provider call. */
    claimModeratorJudgement({ eventId, leaseSec = 90 }) {
      const normalizedEventId = String(eventId || '');
      if (!normalizedEventId) return { claimed: false, row: null, claim: null };
      const at = now();
      const duration = Math.max(5, Math.min(900, Number(leaseSec) || 90));
      const leaseId = randomUUID();
      const claimed = claimModeratorJob.run(leaseId, at + duration, at, normalizedEventId, at, at).changes === 1;
      const row = moderatorJob.get(normalizedEventId) || null;
      return {
        claimed,
        row,
        claim: claimed ? { eventId: normalizedEventId, leaseId, claimGeneration: row?.claim_generation } : null,
      };
    },
    claimNextModeratorJudgement({ leaseSec = 90 } = {}) {
      const at = now();
      const candidate = nextRecoverableModeratorJob.get(at, at, at);
      return candidate ? this.claimModeratorJudgement({ eventId: candidate.event_id, leaseSec }) : { claimed: false, row: null, claim: null };
    },
    markModeratorProviderCalling({ claim: judgementClaim, leaseSec = 90 }) {
      if (!judgementClaim) return { marked: false, row: null };
      const at = now();
      const duration = Math.max(5, Math.min(900, Number(leaseSec) || 90));
      const marked = markModeratorCalling.run(
        at + duration, at, judgementClaim.eventId, judgementClaim.leaseId, judgementClaim.claimGeneration,
      ).changes === 1;
      return { marked, row: moderatorJob.get(String(judgementClaim.eventId)) || null };
    },
    deferModeratorJudgement({ claim: judgementClaim, nextAttemptAt, errorCode = 'provider_unavailable' }) {
      if (!judgementClaim) return { deferred: false, row: null };
      const at = now();
      const deferred = deferModeratorJob.run(
        Math.max(at, Number(nextAttemptAt) || at), String(errorCode).slice(0, 120), at,
        judgementClaim.eventId, judgementClaim.leaseId, judgementClaim.claimGeneration,
      ).changes === 1;
      return { deferred, row: moderatorJob.get(String(judgementClaim.eventId)) || null };
    },
    manualReviewModeratorJudgement({ claim: judgementClaim, errorCode = 'manual_review', providerBoundary = 'unknown', providerDiagnostic = null }) {
      if (!judgementClaim) return { marked: false, row: null };
      const boundary = ['not_started', 'calling', 'returned', 'unknown'].includes(providerBoundary)
        ? providerBoundary : 'unknown';
      const diagnostic = sanitizeProviderFailureDiagnostic(providerDiagnostic);
      const marked = manualReviewModeratorJob.run(
        boundary, String(errorCode).slice(0, 120),
        diagnostic ? JSON.stringify({ providerDiagnostic: diagnostic }) : null, now(),
        judgementClaim.eventId, judgementClaim.leaseId, judgementClaim.claimGeneration,
      ).changes === 1;
      return { marked, row: moderatorJob.get(String(judgementClaim.eventId)) || null };
    },
    /** Completes a pre-provider terminal outcome such as an exempt sender. */
    resolveModeratorJudgement({ claim: judgementClaim, decision = null, result = null, providerBoundary = 'returned' }) {
      if (!judgementClaim) return { resolved: false, row: null };
      const boundary = ['not_started', 'returned'].includes(providerBoundary) ? providerBoundary : 'returned';
      const at = now();
      const resolved = resolvePreProviderModeratorJob.run(
        boundary,
        decision == null ? null : JSON.stringify(decision), result == null ? null : JSON.stringify(result), at, at,
        judgementClaim.eventId, judgementClaim.leaseId, judgementClaim.claimGeneration,
      ).changes === 1;
      return { resolved, row: moderatorJob.get(String(judgementClaim.eventId)) || null };
    },
    persistModeratorDecisionAndEnforcement({
      claim: judgementClaim, decision = null, chatId, messageId, revisionIdentity,
      userId = null, isWeak = false, derivePolicy,
    }) {
      return persistModeratorDecisionAndEnforcement({
        claim: judgementClaim, decision: decision || {}, chatId, messageId, revisionIdentity,
        userId, isWeak, derivePolicy,
      });
    },
    completeModeratorDecision({ eventId }) {
      const normalizedEventId = String(eventId || '');
      if (!normalizedEventId) return { resolved: false, row: null };
      const at = now();
      const resolved = resolveModeratorJob.run(at, at, normalizedEventId).changes === 1;
      return { resolved, row: moderatorJob.get(normalizedEventId) || null };
    },
    manualReviewDecisionReadyModeratorJudgement({ eventId, errorCode = 'durable_decision_invalid' }) {
      const normalizedEventId = String(eventId || '');
      if (!normalizedEventId) return { marked: false, row: null };
      const marked = manualReviewDecisionReadyModeratorJob.run(
        String(errorCode).slice(0, 120), now(), normalizedEventId,
      ).changes === 1;
      return { marked, row: moderatorJob.get(normalizedEventId) || null };
    },
    nextDecisionReadyModeratorJudgement() {
      const candidate = nextDecisionReadyModeratorJob.get();
      return candidate ? moderatorJob.get(String(candidate.event_id)) || null : null;
    },
    /** Calling means an outcome may be externally ambiguous; it is never reclaimed for a provider retry. */
    quarantineExpiredModeratorCalls({ allCalling = false } = {}) {
      const at = now();
      const snapshotsExpired = expireModeratorSnapshots.run(at, at, at).changes;
      const expiredRetries = quarantineExpiredModeratorRetries.run(at, at).changes;
      const callingQuarantined = allCalling
        ? quarantineAllCallingModeratorJobs.run(at).changes
        : expireCallingModeratorJobs.run(at, at).changes;
      return { callingQuarantined, expiredRetries, snapshotsExpired };
    },
    listModeratorJudgements({ limit = 50 } = {}) {
      return listModeratorJobs.all(Math.max(1, Math.min(500, Number(limit) || 50)));
    },
    moderatorRecoveryStatus() {
      return {
        states: Object.fromEntries(moderatorJobCounts.all().map((row) => [row.state, row.count])),
        jobs: listModeratorJobs.all(20),
      };
    },
    claimEvent({ eventId, role, updateId }) {
      const claimed = claim.run(eventId, role, updateId, now()).changes === 1;
      return { claimed, existing: claimed ? null : event.get(eventId) };
    },
    completeEvent(eventId, status, result = null, error = null) {
      finish.run(status, result == null ? null : JSON.stringify(result), error, now(), eventId);
    },
    claimAssistantAskCleanup(input) { return claimAskCleanup(input); },
    isAssistantAskCommandUnedited(input) {
      return input?.durable === true ? durableAskCommandUnedited(input) : askCommandUnedited(input);
    },
    validateAssistantAskPromptCleanupClaim(input) { return durableAskCommandUnedited(input); },
    completeAssistantAskCleanup(input) { return { completed: finishAskCleanup(input) }; },
    createAssistantAskPromptJob({ eventId, chatId, userId, commandMessageId, promptMessageId, timeoutMs = 30_000 }) {
      return db.transaction(() => {
        const ids = [chatId, userId, commandMessageId, promptMessageId].map(String);
        const positiveId = (value) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
        const duration = Number(timeoutMs);
        const expiresAt = Math.ceil(nowMs() + duration);
        if (!/^-?[1-9]\d*$/.test(ids[0]) || !Number.isSafeInteger(Number(ids[0]))
          || !ids.slice(1).every(positiveId) || ids[2] === ids[3]
          || !Number.isFinite(duration) || duration <= 0 || duration > 300_000
          || !Number.isSafeInteger(expiresAt)) return null;
        const existing = askPromptJob.get(String(eventId));
        if (existing) return existing.chat_id === ids[0] && existing.user_id === ids[1]
          && existing.command_message_id === ids[2] && existing.prompt_message_id === ids[3] ? existing : null;
        const source = event.get(String(eventId));
        const candidate = { event_id: String(eventId), chat_id: ids[0], command_message_id: ids[2] };
        if (source?.bot_role !== 'assistant' || source.status !== 'processing' || askCleanupAuthority(candidate) != null
          || askPromptJobByPrompt.get(ids[0], ids[1], ids[3])) return null;
        const at = now();
        createAskPromptJob.run(String(eventId), ...ids, expiresAt, at, at);
        if (askReplyObservation.get(ids[0], ids[1], ids[3])) receiveAskPromptQuestion.run(at, String(eventId));
        return askPromptJob.get(String(eventId)) || null;
      })();
    },
    observeAssistantAskPromptReply({ chatId, userId, promptMessageId }) {
      return db.transaction(() => {
      // The runtime admits only authenticated, same-actor, nonempty native
      // replies to this seam; raw question text is deliberately not accepted.
      if (!/^-?[1-9]\d*$/.test(String(chatId)) || !/^[1-9]\d*$/.test(String(userId))
        || !/^[1-9]\d*$/.test(String(promptMessageId))) return { matched: false, row: null };
      writeAskReplyObservation.run(String(chatId), String(userId), String(promptMessageId), now());
      const row = askPromptJobByPrompt.get(String(chatId), String(userId), String(promptMessageId)) || null;
      if (!row) return { matched: false, row: null };
      if (row.state === 'pending') receiveAskPromptQuestion.run(now(), row.event_id);
      return { matched: true, row: askPromptJob.get(row.event_id) || row };
      })();
    },
    observeAssistantAskPromptAnswer({ chatId, userId, promptMessageId, answerEventId }) {
      // Called only after a fully confirmed answer/fallback delivery. An
      // existing authenticated reply observation is required; this never
      // manufactures a question or persists the answer text.
      if (answerEventId == null || event.get(String(answerEventId))?.bot_role !== 'assistant') {
        return { observed: false };
      }
      return { observed: writeAskAnswerObservation.run(String(answerEventId), String(chatId),
        String(userId), String(promptMessageId)).changes === 1 };
    },
    getAssistantAskPromptAnswerObservation({ chatId, userId, promptMessageId }) {
      const observation = askReplyObservation.get(String(chatId), String(userId), String(promptMessageId));
      return observation?.answer_event_id ? { answerEventId: observation.answer_event_id } : null;
    },
    claimNextExpiredAssistantAskPrompt() {
      return db.transaction(() => {
        // Bound work, but a skipped/invalid head must not starve later jobs.
        for (let index = 0; index < 500; index++) {
          const row = nextDueAskPromptJob.get(nowMs());
          if (!row) return null;
          const claim = claimAskPromptJob(row, 'expiry');
          if (claim) return claim;
        }
        return null;
      })();
    },
    claimNextCompletedAssistantAskPrompt() {
      return db.transaction(() => {
        for (let index = 0; index < 500; index++) {
          const row = nextCompletedAskPromptJob.get();
          if (!row) return null;
          const claim = claimAskPromptJob(row, 'answer');
          if (claim) return claim;
        }
        return null;
      })();
    },
    claimAnsweredAssistantAskPrompt({ chatId, userId, promptMessageId, answerEventId = null }) {
      return db.transaction(() => {
      const row = askPromptJobByPrompt.get(String(chatId), String(userId), String(promptMessageId)) || null;
      const claim = claimAskPromptJob(row?.state === 'question_received' ? row : null, 'answer');
      if (!claim) return null;
      const result = Object.freeze({ ...claim, answerEventId: answerEventId == null ? null : String(answerEventId) });
      issuedAskClaims.add(result);
      const eventRow = event.get(result.eventId);
      let prior = null;
      try { prior = JSON.parse(eventRow?.result_json); } catch { prior = null; }
      if (prior?.askPrompt && prior.askPromptCleanup == null) {
        writeAskResult.run(JSON.stringify({ ...prior, askPromptCleanup: {
          state: 'calling', claimedAt: now(), ...(result.answerEventId ? { answerEventId: result.answerEventId } : {}),
        } }), result.eventId, eventRow.result_json);
      }
      return result;
      })();
    },
    getAssistantAskPromptJob({ chatId, userId, promptMessageId }) {
      return askPromptJobByPrompt.get(String(chatId), String(userId), String(promptMessageId)) || null;
    },
    completeAssistantAskPromptJob({ claim: promptClaim, prompt, command }) {
      if (!validAskClaim(promptClaim)) return { completed: false, row: null };
      const uncertain = prompt?.state === 'uncertain' || command?.state === 'uncertain';
      const state = uncertain ? 'uncertain' : 'finished';
      const result = { prompt, command, source: promptClaim.source };
      const completed = completeAskPromptJob.run(
        state, JSON.stringify(result), uncertain ? 'delete_transport_unknown' : null, now(), now(),
        promptClaim.eventId, promptClaim.claimId, promptClaim.claimGeneration,
      ).changes === 1;
      if (completed) {
        const eventRow = event.get(promptClaim.eventId);
        let prior = null;
        try { prior = JSON.parse(eventRow?.result_json); } catch { prior = null; }
        if (prior?.askPrompt && ['calling', undefined].includes(prior.askPromptCleanup?.state)) {
          writeAskResult.run(JSON.stringify({ ...prior, askPromptCleanup: {
            ...prior.askPromptCleanup, state: 'finished', completedAt: now(), prompt, command,
            ...(promptClaim.answerEventId ? { answerEventId: promptClaim.answerEventId } : {}),
          } }), promptClaim.eventId, eventRow.result_json);
        }
      }
      return { completed, row: askPromptJob.get(promptClaim.eventId) || null };
    },
    assistantAskPromptStatus() {
      return { states: Object.fromEntries(promptJobCounts.all().map((row) => [row.state, row.count])) };
    },
    invalidateAssistantAskPrompt(input) {
      const legacy = invalidateAskPrompt(input);
      const row = input.promptMessageId != null
        ? askPromptJobByPrompt.get(String(input.chatId), String(input.userId), String(input.promptMessageId))
        : input.commandMessageId != null
          ? askPromptJobByCommand.get(String(input.chatId), String(input.userId), String(input.commandMessageId))
          : null;
      const job = row ? skipDurableAskPromptJob(row, 'command_edited') : false;
      return { invalidated: legacy || job };
    },
    /**
     * Запись состоявшейся модерации вместе с ценой вызова. Имя модели берётся
     * из самого вердикта (`decision.modelId`), а не из квитанции: вердикт
     * долговечен и известен даже на восстановлении, где квитанции вызова уже
     * нет. Счётчики — из агрегата обеих ступеней; пустые законны и означают
     * «вызова не было или его цену не назвали», но никогда не ноль.
     */
    recordModeration(record) {
      const cost = usageColumns(record.usage);
      insertModeration.run(
        randomUUID(), record.eventId, record.chatId, record.messageId, record.userId,
        record.verdict, record.confidence, record.reason, record.mode,
        JSON.stringify(record.actions || []),
        record.modelId == null ? null : String(record.modelId).slice(0, 200),
        cost.inputTokens, cost.outputTokens, cost.totalTokens,
        now(),
      );
    },
    getAssistantDisposition({ chatId, messageId }) {
      return disposition.get(String(chatId), String(messageId));
    },
    upsertAssistantDisposition({
      chatId, messageId, status, moderationMessageId = null, verdict = null,
      reason = null, moderationEventId = null,
    }) {
      const at = now();
      writeDisposition.run(
        String(chatId), String(messageId), String(status),
        moderationMessageId == null ? null : String(moderationMessageId),
        verdict == null ? null : String(verdict), reason == null ? null : String(reason),
        moderationEventId == null ? null : String(moderationEventId), at, at,
      );
      return disposition.get(String(chatId), String(messageId));
    },
    observeModerationMessage({ chatId, messageId, userId = null, revisionIdentity }) {
      observeModerationMessageWithUser.run(
        String(chatId), String(messageId), userId == null || String(userId) === '' ? null : String(userId), String(revisionIdentity),
      );
      return moderationMessage.get(String(chatId), String(messageId));
    },
    listKnownUndeletedModerationMessages({ chatId, userId, limit = 100 }) {
      if (userId == null || String(userId) === '') return [];
      const boundedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 100));
      return knownUndeletedMessagesForUser.all(String(chatId), String(userId), boundedLimit);
    },
    getWeakStrikeState({ chatId, userId }) {
      if (userId == null || String(userId) === '') return { weakStrikes: 0, warningStage: 'none' };
      const row = db.prepare(`SELECT weak_strikes, warning_stage, warning_delivered_at, last_event_id
        FROM runtime_moderation_weak_strikes WHERE chat_id = ? AND user_id = ?`).get(String(chatId), String(userId));
      return row
        ? { weakStrikes: row.weak_strikes, warningStage: row.warning_stage, warningDeliveredAt: row.warning_delivered_at, lastEventId: row.last_event_id }
        : { weakStrikes: 0, warningStage: 'none' };
    },
    reserveWeakStrikeForMessage({ chatId, userId, messageId, revisionIdentity, eventId }) {
      if (userId == null || String(userId) === '') return { claimed: false, before: 0, after: 0, reason: 'author_identity_missing' };
      return reserveWeakStrike(
        String(chatId), String(userId), String(messageId), String(revisionIdentity), String(eventId), now(),
      );
    },
    hasWeakStrikeReservation({ chatId, userId, messageId, eventId }) {
      if (userId == null || String(userId) === '') return false;
      const row = moderationMessage.get(String(chatId), String(messageId));
      return row?.user_id === String(userId) && row?.weak_strike_event_id === String(eventId);
    },
    markWarningDelivered({ chatId, userId, eventId, stage }) {
      if (userId == null || !['first', 'final'].includes(String(stage))) return { marked: false };
      const at = now();
      const changed = markWarningDelivered.run(String(stage), at, String(eventId), at, String(chatId), String(userId)).changes;
      return { marked: changed === 1 };
    },
    recordModerationDeletion({ chatId, messageId, state }) {
      return { recorded: recordMessageDeletion.run(String(state), now(), String(chatId), String(messageId)).changes === 1 };
    },
    claimModerationEnforcement({ eventId, chatId, messageId, policy, guardProof = null }) {
      const claimId = randomUUID();
      const at = now();
      const claimed = createEnforcementReceipt.run(
        String(eventId), String(chatId), String(messageId), String(policy.action), JSON.stringify(policy),
        guardProof == null ? null : JSON.stringify(guardProof), claimId, at, at,
      ).changes === 1;
      const existing = claimed ? null : enforcementReceipt.get(String(eventId));
      return {
        claimed,
        claim: claimed ? { eventId: String(eventId), claimId, claimGeneration: 1 } : null,
        existing,
      };
    },
    markModerationEnforcementCalling({ claim: enforcementClaim, receipt }) {
      if (!enforcementClaim) return { marked: false };
      const marked = markEnforcementCalling.run(
        JSON.stringify(receipt), now(), enforcementClaim.eventId,
        enforcementClaim.claimId, enforcementClaim.claimGeneration,
      ).changes === 1;
      return { marked, row: enforcementReceipt.get(enforcementClaim.eventId) || null };
    },
    completeModerationEnforcement({ claim: enforcementClaim, status, receipt, errorCode = null }) {
      if (!enforcementClaim || !['completed', 'skipped', 'uncertain'].includes(String(status))) return { completed: false };
      const at = now();
      const completed = completeEnforcementReceipt.run(
        String(status), JSON.stringify(receipt), errorCode == null ? null : String(errorCode).slice(0, 120), at, at,
        enforcementClaim.eventId, enforcementClaim.claimId, enforcementClaim.claimGeneration,
      ).changes === 1;
      return { completed, row: enforcementReceipt.get(enforcementClaim.eventId) || null };
    },
    /** A planned receipt has not crossed a Telegram boundary and may be reclaimed. */
    resumePlannedModerationEnforcement({ eventId }) {
      const normalizedEventId = String(eventId || '');
      if (!normalizedEventId) return { claimed: false, claim: null, row: null };
      const claimId = randomUUID();
      const claimed = resumePlannedEnforcement.run(claimId, now(), normalizedEventId).changes === 1;
      const row = enforcementReceipt.get(normalizedEventId) || null;
      return {
        claimed,
        claim: claimed ? { eventId: normalizedEventId, claimId, claimGeneration: row?.claim_generation } : null,
        row,
      };
    },
    getModerationEnforcement(eventId) { return enforcementReceipt.get(String(eventId)) || null; },
    claimAutoUnpin({ chatId, messageId, eventId }) {
      const normalizedChatId = String(chatId);
      const normalizedMessageId = String(messageId);
      const claimed = createAutoUnpin.run(
        normalizedChatId, normalizedMessageId, String(eventId), now(),
      ).changes === 1;
      return {
        claimed,
        existing: claimed ? null : autoUnpin.get(normalizedChatId, normalizedMessageId),
      };
    },
    markAutoUnpinCalling({ chatId, messageId }) {
      const normalizedChatId = String(chatId);
      const normalizedMessageId = String(messageId);
      const marked = markAutoUnpinCalling.run(normalizedChatId, normalizedMessageId).changes === 1;
      return { marked, row: autoUnpin.get(normalizedChatId, normalizedMessageId) || null };
    },
    completeAutoUnpin({ chatId, messageId, state, result = null, errorCode = null }) {
      if (!['completed', 'skipped', 'uncertain'].includes(String(state))) return { completed: false, row: null };
      const normalizedChatId = String(chatId);
      const normalizedMessageId = String(messageId);
      const completed = completeAutoUnpin.run(
        String(state), JSON.stringify(result), errorCode == null ? null : String(errorCode).slice(0, 120), now(),
        normalizedChatId, normalizedMessageId,
      ).changes === 1;
      return { completed, row: autoUnpin.get(normalizedChatId, normalizedMessageId) || null };
    },
    rememberOwnerPin({ chatId, messageId, eventId }) {
      rememberOwnerPin.run(String(chatId), String(messageId), String(eventId), now());
      return ownerPin.get(String(chatId)) || null;
    },
    getOwnerPin({ chatId }) { return ownerPin.get(String(chatId)) || null; },
    reserveWeakStrike({ chatId, userId }) {
      // Compatibility helper for non-Guard callers. Guard enforcement must use
      // reserveWeakStrikeForMessage so edited revisions cannot create extra strikes.
      if (userId == null || String(userId) === '') return { claimed: false, before: 0, after: 0 };
      const syntheticMessageId = `compat:${randomUUID()}`;
      return reserveWeakStrike(String(chatId), String(userId), syntheticMessageId, syntheticMessageId, syntheticMessageId, now());
    },
    reserveAssistantRequest({ eventId, chatId, userId, cooldownSec = 0, dailyCap = 0 }) {
      if (!eventId || userId == null || String(userId) === '') return { allowed: false, reason: 'missing_user' };
      const at = now();
      const normalizedChatId = String(chatId);
      const normalizedUserId = String(userId);
      const existing = assistantRequest.get(String(eventId));
      if (existing) return { allowed: false, reason: 'already_reserved', existing };
      const cooldown = Math.max(0, Number.parseInt(cooldownSec, 10) || 0);
      const daily = Math.max(0, Number.parseInt(dailyCap, 10) || 0);
      if (cooldown > 0 && countAssistantRequests.get(normalizedChatId, normalizedUserId, at - cooldown).count > 0) {
        return { allowed: false, reason: 'cooldown' };
      }
      if (daily > 0 && countAssistantRequests.get(normalizedChatId, normalizedUserId, at - 86_400).count >= daily) {
        return { allowed: false, reason: 'daily_cap' };
      }
      insertAssistantRequest.run(String(eventId), normalizedChatId, normalizedUserId, at);
      return { allowed: true };
    },
    completeAssistantRequest(eventId) {
      return { completed: completeAssistantRequest.run(now(), String(eventId)).changes === 1 };
    },
    markAssistantRequestUncertain(eventId) {
      return { marked: uncertainAssistantRequest.run(now(), String(eventId)).changes === 1 };
    },
    releaseAssistantRequest(eventId) {
      return { released: releaseAssistantRequest.run(String(eventId)).changes === 1 };
    },
    /**
     * One row per out-of-coverage abstention. The journal is a passive sensor:
     * writing never fails the answer path over a label, so an unknown
     * candidate level degrades to null instead of throwing.
     */
    recordCoverageDeficit({ chatId, userId = null, question, reason, candidateLevel = null }) {
      const level = ['L2', 'L3'].includes(String(candidateLevel)) ? String(candidateLevel) : null;
      insertCoverageDeficit.run(
        randomUUID(), String(chatId), userId == null || String(userId) === '' ? null : String(userId),
        String(question), String(reason), level, now(),
      );
    },
    listCoverageDeficits({ limit = 100 } = {}) {
      const boundedLimit = Math.max(1, Math.min(10_000, Number.parseInt(limit, 10) || 100));
      return listCoverageDeficitRows.all(boundedLimit).map((row) => ({
        id: row.id,
        chatId: row.chat_id,
        userId: row.user_id,
        question: row.question,
        reason: row.reason,
        candidateLevel: row.candidate_level,
        createdAt: row.created_at,
      }));
    },
    /**
     * Наблюдение анализатора. Пишется на КАЖДОМ ходу, где анализатор включён, —
     * и когда ответ дан, и когда рантайм воздержался, и когда сам анализатор
     * сломался. Журнал только удачных ходов показывал бы систему лучше, чем она
     * есть, а нужен обратный эффект.
     */
    recordAnalyzerObservation({
      eventId, chatId, userId, question, status, verdict = null, hints = [],
      route = null, detectorDebt = null, modelId = null, usage = null, routeUsage = null, error = null,
    }) {
      const level = verdict?.level || null;
      const intent = verdict?.intent || null;
      // Затраты хода: вызов анализатора и — когда он был — вызов модельного
      // роутера. Оба пишутся своими счётчиками и своей моделью: сложить их в
      // одно число значило бы потерять, чем именно эта сумма оплачена.
      const analyzerCost = usageColumns(usage);
      const routeCost = usageColumns(routeUsage);
      insertAnalyzerObservation.run(
        randomUUID(), String(eventId), String(chatId), String(userId), String(question), String(status),
        Array.isArray(verdict?.topics) ? verdict.topics.join(',') : null,
        level?.hypothesis || null, level?.confidence || null,
        intent?.kind || null, intent?.confidence || null,
        Array.isArray(hints) && hints.length ? hints.join(',') : null,
        route?.action || null, route?.sourceId || null,
        verdict ? JSON.stringify(verdict) : null,
        detectorDebt ? JSON.stringify(detectorDebt) : null,
        modelId == null ? null : String(modelId),
        analyzerCost.inputTokens, analyzerCost.outputTokens, analyzerCost.totalTokens,
        routeCost.modelId, routeCost.inputTokens, routeCost.outputTokens, routeCost.totalTokens,
        error == null ? null : String(error).slice(0, 500),
        now(),
      );
    },
    listAnalyzerObservations({ limit = 100 } = {}) {
      const boundedLimit = Math.max(1, Math.min(10_000, Number.parseInt(limit, 10) || 100));
      return listAnalyzerObservationRows.all(boundedLimit).map((row) => ({
        id: row.id,
        eventId: row.event_id,
        chatId: row.chat_id,
        userId: row.user_id,
        question: row.question,
        status: row.status,
        topics: row.topics ? row.topics.split(',') : [],
        level: row.level,
        levelConfidence: row.level_confidence,
        intent: row.intent,
        intentConfidence: row.intent_confidence,
        hints: row.hints ? row.hints.split(',') : [],
        route: { action: row.route_action, sourceId: row.route_source_id },
        // Полный вердикт с уликами: без цитаты диагноз нечем проверить, а
        // непроверяемый диагноз — мнение, а не данные.
        verdict: row.verdict_json ? JSON.parse(row.verdict_json) : null,
        detectorDebt: row.detector_debt ? JSON.parse(row.detector_debt) : null,
        modelId: row.model_id,
        // Затраты хода. Пустые счётчики — «не измерено», и это не то же самое,
        // что ноль: ход до этой правки (или вызов, чью цену провайдер не
        // назвал) обязан быть виден как пробел учёта, а не как экономия.
        usage: usageOf(row),
        routeUsage: { modelId: row.route_model_id ?? null, ...usageOf(row, 'route_') },
        error: row.error,
        createdAt: row.created_at,
      }));
    },
    /**
     * Долговечная пара «вопрос → ответ» для приёмочного контура.
     *
     * Пишется ТОЛЬКО там, где включён анализатор (пер-чатный гейт держит
     * рантайм) — в боевом чате ни поведение, ни объём записи не меняются.
     *
     * Маршрут приходит двух форм: объектом `{action, sourceId}` у ответа по
     * домену и строкой (`boundary:…`, `command:…`, `public:…`) у
     * детерминированных ответов и воздержаний. Обе сохраняются как есть:
     * свернуть строку в «неизвестно» значило бы потерять единственный признак,
     * отличающий воздержание от ответа по материалам.
     *
     * `served_unit_ids` — идентификаторы записей знания в том виде, в каком их
     * получила отвечающая модель (источник, не дериватив): разбор на юниты —
     * работа лаборатории, и правило разбора живёт там, а не здесь.
     */
    recordAssistantAnswer({
      eventId, chatId, userId, question, answer, route = null, knowledge = null,
      modelId = null, usage = null, delivery = null,
    }) {
      const action = typeof route === 'string' ? route : (route?.action || null);
      const sourceId = typeof route === 'string' ? null : (route?.sourceId || null);
      const entries = Array.isArray(knowledge?.entries) ? knowledge.entries : [];
      const served = [];
      for (const entry of entries) {
        if (served.length >= 128) break;
        const id = entry?.id == null ? '' : String(entry.id).slice(0, 200);
        if (id && !served.includes(id)) served.push(id);
      }
      // Затраты вызова ответа. Детерминированный текст (граница, воздержание)
      // модель не вызывает — там счётчики остаются пустыми, и это факт «вызова
      // не было», а не ноль расхода.
      const answerCost = usageColumns(usage);
      insertAnswerRecord.run(
        String(eventId), String(chatId), userId == null ? '' : String(userId),
        String(question), String(answer),
        action == null ? null : String(action).slice(0, 200),
        sourceId == null ? null : String(sourceId).slice(0, 200),
        knowledge?.sourceId == null ? null : String(knowledge.sourceId).slice(0, 200),
        served.length ? JSON.stringify(served) : null,
        modelId == null ? null : String(modelId),
        answerCost.inputTokens, answerCost.outputTokens, answerCost.totalTokens,
        delivery == null ? null : String(delivery).slice(0, 120),
        now(),
      );
    },
    listAssistantAnswers({ limit = 100 } = {}) {
      const boundedLimit = Math.max(1, Math.min(10_000, Number.parseInt(limit, 10) || 100));
      return listAnswerRecordRows.all(boundedLimit).map((row) => ({
        eventId: row.event_id,
        chatId: row.chat_id,
        userId: row.user_id,
        question: row.question,
        answer: row.answer,
        route: { action: row.route_action, sourceId: row.route_source_id },
        knowledgeSourceId: row.knowledge_source_id,
        servedUnitIds: row.served_unit_ids ? JSON.parse(row.served_unit_ids) : [],
        modelId: row.model_id,
        usage: usageOf(row),
        delivery: row.delivery,
        createdAt: row.created_at,
      }));
    },
    /** Ходы одного человека для накопления уровня (траектория). */
    recentAnalyzerLevels(chatId, userId, { limit = 20, ttlSeconds = 604_800 } = {}) {
      const ttl = Math.max(0, Number.parseInt(ttlSeconds, 10) || 0);
      const since = ttl > 0 ? now() - ttl : 0;
      const boundedLimit = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 20));
      return listUserAnalyzerLevelRows.all(String(chatId), String(userId), since, boundedLimit)
        .map((row) => ({ level: { hypothesis: row.level, confidence: row.level_confidence } }));
    },
    recentDialogue(chatId, userId, { limit = 3, ttlSeconds = 604_800 } = {}) {
      const at = now();
      const ttl = Math.max(0, Number.parseInt(ttlSeconds, 10) || 0);
      if (ttl > 0) {
        deleteExpiredDialogueTurns.run(at - ttl);
        deleteExpiredDialogues.run(at - ttl);
      }
      const current = dialogue.get(String(chatId), String(userId));
      if (!current) return [];
      const boundedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 3));
      return turns.all(current.id, boundedLimit).reverse().map((row) => ({ question: row.question, answer: row.answer }));
    },
    recordBoundedAssistantTurn(turn, { maxTurns = 3, ttlSeconds = 604_800 } = {}) {
      const at = now();
      const ttl = Math.max(0, Number.parseInt(ttlSeconds, 10) || 0);
      if (ttl > 0) {
        deleteExpiredDialogueTurns.run(at - ttl);
        deleteExpiredDialogues.run(at - ttl);
      }
      let current = dialogue.get(String(turn.chatId), String(turn.userId));
      if (!current) {
        current = { id: randomUUID() };
        insertDialogue.run(current.id, String(turn.chatId), String(turn.userId), at);
      } else {
        touchDialogue.run(at, current.id);
      }
      insertTurn.run(
        randomUUID(), current.id, String(turn.eventId), String(turn.question), String(turn.answer),
        turn.modelId || null, JSON.stringify(turn.receipt || null), at,
      );
      const boundedLimit = Math.max(1, Math.min(100, Number.parseInt(maxTurns, 10) || 3));
      trimDialogueTurns.run(current.id, current.id, boundedLimit);
    },
    getEvent(eventId) { return event.get(eventId); },
  };
}
