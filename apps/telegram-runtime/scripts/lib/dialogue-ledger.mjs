/**
 * Запись сообщений разговора двух экземпляров (`ledger.jsonl`, CONTRACT wave3 §4).
 *
 * Это ИСТОЧНИК: стенограмма, пары и экспорт — его проекции. Одна строка — одно
 * сообщение. Поля — белый список; лишнее поле роняет запись, а не отбрасывается
 * молча (то же правило, что у пары `pair.mjs` в agi: молчаливое отбрасывание
 * превращает нарушение в незамеченную привычку).
 *
 * Дозапись атомарна: новый файл целиком пишется во временный файл рядом,
 * `fsync`, переименование поверх старого, `fsync` каталога. Читатель либо
 * видит прежнюю запись, либо новую — никогда полстроки. Чтение проверяет
 * целостность (seq без пропусков, хэш текста, ссылки `reply_to`, известные
 * участники); повреждённая запись — отказ, не починка.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const LEDGER_FILE = 'ledger.jsonl';
export const LEDGER_SCENARIO_AUTHOR = 'scenario';
export const LEDGER_FROM_KINDS = Object.freeze(['human', 'agent']);
export const LEDGER_TEXT_MAX_CHARS = 32_000;

/** Поля сообщения. Больше в нём нет ничего; добавлять сюда — решение владельца. */
export const LEDGER_FIELDS = Object.freeze([
  'message_id', 'seq', 'from', 'from_kind', 'to', 'reply_to', 'text', 'text_sha256', 'committed_at', 'receipt',
]);

/**
 * Поля устройства, которым в записи не место (§4). Перечислены ради внятного
 * сообщения об ошибке — запрет исполняет белый список выше.
 */
export const LEDGER_FORBIDDEN_FIELDS = Object.freeze([
  'trace', 'usage', 'working_state', 'state', 'prompt', 'system', 'input', 'material', 'knowledge', 'entries',
  'pack', 'route', 'domain', 'domains', 'primary', 'status', 'confidence', 'citations', 'rules', 'defects',
  'tokens', 'kind', 'intent', 'voice', 'hides', 'record', 'attempts', 'observations', 'pairs', 'dialogue',
]);

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class LedgerError extends Error {
  constructor(code, detail = null) {
    super(detail == null ? code : `${code}:${detail}`);
    this.name = 'LedgerError';
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, detail) => { throw new LedgerError(code, detail); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function textSha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Запись файла целиком: временный файл, fsync, rename, fsync каталога. */
export function atomicWriteFile(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

function participantSet(participants) {
  const ids = participants instanceof Set ? [...participants] : Array.isArray(participants) ? participants : null;
  if (!ids || !ids.length || ids.some((id) => typeof id !== 'string' || !id) || ids.includes(LEDGER_SCENARIO_AUTHOR)) {
    fail('ledger_participants_invalid');
  }
  return new Set(ids);
}

/**
 * Одно сообщение против предыдущего. `previous` — последнее принятое сообщение
 * (или null для первого), `messageIds` — идентификаторы уже принятых.
 */
export function validateLedgerMessage(message, { runId, participants, previous = null, messageIds = new Set() } = {}) {
  if (typeof runId !== 'string' || !runId) fail('ledger_run_id_invalid');
  const known = participantSet(participants);
  if (!plain(message)) fail('ledger_message_invalid', 'not_an_object');
  for (const key of Object.keys(message)) {
    if (LEDGER_FIELDS.includes(key)) continue;
    fail(LEDGER_FORBIDDEN_FIELDS.includes(key) ? 'ledger_field_forbidden' : 'ledger_field_unknown', key);
  }
  for (const key of LEDGER_FIELDS) if (!Object.hasOwn(message, key)) fail('ledger_field_missing', key);

  const expectedSeq = previous ? previous.seq + 1 : 1;
  if (!Number.isSafeInteger(message.seq) || message.seq < 1) fail('ledger_seq_invalid');
  if (message.seq !== expectedSeq) fail('ledger_seq_gap', `expected ${expectedSeq}, got ${message.seq}`);
  if (message.message_id !== `${runId}-${message.seq}`) fail('ledger_message_id_invalid', String(message.message_id));

  const fromScenario = message.from === LEDGER_SCENARIO_AUTHOR;
  if (!fromScenario && !known.has(message.from)) fail('ledger_author_unknown', String(message.from));
  if (!LEDGER_FROM_KINDS.includes(message.from_kind)) fail('ledger_from_kind_invalid', String(message.from_kind));
  // Стимул сценария написан человеком и только он открывает разговор (§5);
  // порождённые ходы — агенты. Смешение — ошибка авторства, не вариант.
  if (fromScenario !== (message.seq === 1)) fail('ledger_opening_invalid');
  if (fromScenario && message.from_kind !== 'human') fail('ledger_from_kind_invalid', 'scenario_must_be_human');
  if (!fromScenario && message.from_kind !== 'agent') fail('ledger_from_kind_invalid', 'participant_must_be_agent');
  if (!known.has(message.to) || message.to === message.from) fail('ledger_addressee_invalid', String(message.to));
  // Очерёдность строгая (уточнение координатора к §4): отвечает адресат
  // предыдущего сообщения. Два входящих подряд одной стороне — ошибка прогона.
  if (previous && message.from !== previous.to) fail('ledger_turn_order_invalid', `seq ${message.seq} from ${message.from}, expected ${previous.to}`);

  if (message.reply_to !== null) {
    if (typeof message.reply_to !== 'string' || !messageIds.has(message.reply_to)) fail('ledger_reply_to_unknown', String(message.reply_to));
  } else if (message.seq !== 1) fail('ledger_reply_to_unknown', 'null');

  if (typeof message.text !== 'string' || !message.text || message.text !== message.text.trim()
    || message.text.length > LEDGER_TEXT_MAX_CHARS) fail('ledger_text_invalid');
  if (message.text_sha256 !== textSha256(message.text)) fail('ledger_text_hash_mismatch', message.message_id);
  if (typeof message.committed_at !== 'string' || !ISO_RE.test(message.committed_at)
    || Number.isNaN(Date.parse(message.committed_at))) fail('ledger_committed_at_invalid');

  if (fromScenario) {
    if (message.receipt !== null) fail('ledger_receipt_invalid', 'scenario_receipt_must_be_null');
  } else {
    const receipt = message.receipt;
    if (!plain(receipt) || Object.keys(receipt).sort().join(',') !== 'status,turn_id'
      || typeof receipt.turn_id !== 'string' || !receipt.turn_id
      || typeof receipt.status !== 'string' || !receipt.status) fail('ledger_receipt_invalid');
  }
  return Object.freeze({ ...message, receipt: message.receipt === null ? null : Object.freeze({ ...message.receipt }) });
}

/** Вся запись как цепочка: каждое сообщение — против предыдущего. */
export function validateLedger(messages, { runId, participants }) {
  if (!Array.isArray(messages)) fail('ledger_corrupt', 'not_a_list');
  const accepted = [];
  const messageIds = new Set();
  for (const message of messages) {
    const valid = validateLedgerMessage(message, { runId, participants, previous: accepted.at(-1) ?? null, messageIds });
    accepted.push(valid);
    messageIds.add(valid.message_id);
  }
  return Object.freeze(accepted);
}

/** Чтение с проверкой целостности. Нет файла — пустая запись; полстроки — порча. */
export function readLedger(path, { runId, participants }) {
  if (!existsSync(path)) return Object.freeze([]);
  if (lstatSync(path).isSymbolicLink()) fail('ledger_corrupt', 'symlink');
  const raw = readFileSync(path, 'utf8');
  if (raw && !raw.endsWith('\n')) fail('ledger_corrupt', 'unterminated_line');
  const parsed = [];
  raw.split('\n').forEach((line, index) => {
    if (!line) return;
    try { parsed.push(JSON.parse(line)); } catch { fail('ledger_corrupt', `line_${index + 1}`); }
  });
  try { return validateLedger(parsed, { runId, participants }); } catch (error) {
    if (error instanceof LedgerError && !error.code.startsWith('ledger_corrupt')) fail('ledger_corrupt', error.message);
    throw error;
  }
}

/**
 * Атомарная дозапись: сообщение проверяется против уже принятых, файл
 * переписывается целиком через временный файл. Возвращает принятое сообщение.
 */
export function appendLedgerMessage(path, message, { runId, participants }) {
  const existing = readLedger(path, { runId, participants });
  const valid = validateLedgerMessage(message, {
    runId, participants, previous: existing.at(-1) ?? null, messageIds: new Set(existing.map((item) => item.message_id)),
  });
  // Поля в порядке белого списка; вложенная квитанция сериализуется целиком.
  const lines = [...existing, valid]
    .map((item) => JSON.stringify(Object.fromEntries(LEDGER_FIELDS.map((key) => [key, item[key]])))).join('\n');
  atomicWriteFile(path, `${lines}\n`);
  return valid;
}

/** Удобная обёртка над файлом записи одного прогона. */
export function openLedger({ directory, runId, participants }) {
  const path = join(directory, LEDGER_FILE);
  const context = { runId, participants };
  return Object.freeze({
    path,
    read: () => readLedger(path, context),
    append: (message) => appendLedgerMessage(path, message, context),
  });
}
