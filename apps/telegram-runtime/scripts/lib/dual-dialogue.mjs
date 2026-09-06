/**
 * Разговор двух экземпляров ассистента (wave3): эксперт и синтетик.
 *
 * Оба экземпляра — один и тот же `createLocalAssistantSession` с разными
 * параметрами: своя `runtime.db`, своя `identity` (в которой «пользователь» —
 * собеседник), свой пакет знания и своя методология поставщика. Роль
 * синтетика — не отдельный механизм: это текст, который адаптер методологии
 * кладёт в системное сообщение стадии `answer`, и пакет знания, собранный из
 * записи участника и обстоятельства сценария.
 *
 * Источник разговора — `ledger.jsonl` (см. `dialogue-ledger.mjs`). Порядок хода:
 * экземпляр порождает текст → строка закрепляется атомарно → только затем текст
 * передаётся собеседнику. Продолжение (`resume`) сверяет квитанцию экземпляра
 * (`completedPair`) с записью и никогда не порождает заново закреплённое;
 * неизвестный исход внешнего вызова — `uncertain`, не повтор.
 *
 * Явный режим: без `.env`, без сервисов, без неявного поставщика. Адаптеры —
 * доверенный проверенный код внутри каталога методологии, не песочница.
 */
import Database from 'better-sqlite3';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSignificant, normalizeForm, tokenize } from '@aichattg/telegram-core';
import { createLocalAssistantSession } from '../local-assistant.mjs';
import { emptyWorkingState, projectWorkingState } from '../../src/assistant-working-state.mjs';
import { createWorkingStateUpdater } from '../../src/working-state-updater.mjs';
import { openDialogueStore } from './local-dialogue-store.mjs';
import { canonical, hash, inside, tree } from './managed-dialogue.mjs';
import { LEDGER_SCENARIO_AUTHOR, atomicWriteFile, openLedger, textSha256 } from './dialogue-ledger.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const CHAT_ID_RE = /^-[1-9]\d*$/;
const USER_ID_RE = /^[1-9]\d*$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

export const DUAL_ROLES = Object.freeze(['expert', 'synthetic']);
export const DUAL_STATUSES = Object.freeze(['paused', 'running', 'completed', 'failed', 'uncertain', 'state_pending']);
export const DUAL_RECORD_KINDS = Object.freeze({ expert: 'assistant', synthetic: 'synthetic' });
export const ROLE_PACKAGE_SOURCE_ID = 'course-knowledge-v2';
export const ROLE_FILE = 'role.txt';
export const PACKAGE_DIR = 'package';
export const TRACE_FILE = 'trace.jsonl';
export const TRANSCRIPT_FILE = 'transcript.md';
/** Предел прогона на сообщения, считая стимул (§5). */
export const TURN_LIMIT_MAX = 1000;

const fail = (code) => { throw new Error(code); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const id = (value, code = 'dual_identity_invalid') => { if (typeof value !== 'string' || !ID_RE.test(value)) fail(code); };

/** `/ask` рантайма схлопывает пробелы (`cutAt`): ожидание для `completedPair` — в том же виде. */
export function collapseWhitespace(text) { return String(text).replace(/\s+/g, ' ').trim(); }

// ---------------------------------------------------------------------------
// Сценарий и записи участников
// ---------------------------------------------------------------------------

/**
 * Сценарий по CONTRACT §5: `scenario_id`, `case`, `scenario_class`,
 * `participants[{participant_id, record, role, label}]`, `opening{to, text}`,
 * `turn_limit`, необязательные `expectations` и `note`. Ожидания экземплярам не
 * видны: прогон читает только идентичности, стимул и предел.
 */
export function validateScenario(scenario) {
  if (!plain(scenario)) fail('dual_scenario_invalid');
  const allowed = ['scenario_id', 'case', 'scenario_class', 'participants', 'opening', 'turn_limit', 'expectations', 'note'];
  for (const key of Object.keys(scenario)) if (!allowed.includes(key)) fail(`dual_scenario_invalid:field:${key}`);
  id(scenario.scenario_id, 'dual_scenario_invalid:scenario_id');
  for (const key of ['case', 'scenario_class']) {
    if (typeof scenario[key] !== 'string' || !scenario[key].trim()) fail(`dual_scenario_invalid:${key}`);
  }
  if (!Array.isArray(scenario.participants) || scenario.participants.length !== 2) fail('dual_scenario_invalid:participants');
  const byRole = {};
  const ids = new Set();
  for (const participant of scenario.participants) {
    if (!plain(participant) || Object.keys(participant).sort().join(',') !== 'label,participant_id,record,role') fail('dual_scenario_invalid:participant');
    id(participant.participant_id, 'dual_scenario_invalid:participant_id');
    if (participant.participant_id === LEDGER_SCENARIO_AUTHOR || ids.has(participant.participant_id)) fail('dual_scenario_invalid:participant_id');
    id(participant.record, 'dual_scenario_invalid:record');
    if (!DUAL_ROLES.includes(participant.role) || byRole[participant.role]) fail('dual_scenario_invalid:role');
    if (typeof participant.label !== 'string' || !participant.label.trim()) fail('dual_scenario_invalid:label');
    ids.add(participant.participant_id);
    byRole[participant.role] = participant;
  }
  if (!byRole.expert || !byRole.synthetic) fail('dual_scenario_invalid:roles');
  if (!plain(scenario.opening) || Object.keys(scenario.opening).sort().join(',') !== 'text,to') fail('dual_scenario_invalid:opening');
  if (scenario.opening.to !== byRole.synthetic.participant_id) fail('dual_scenario_invalid:opening_to');
  const text = scenario.opening.text;
  if (typeof text !== 'string' || !text || text !== text.trim() || Buffer.byteLength(text) > 8000 || text.startsWith('/')) fail('dual_scenario_invalid:opening_text');
  if (!Number.isSafeInteger(scenario.turn_limit) || scenario.turn_limit < 2 || scenario.turn_limit > TURN_LIMIT_MAX) fail('dual_scenario_invalid:turn_limit');
  if (scenario.expectations !== undefined) {
    if (!Array.isArray(scenario.expectations)) fail('dual_scenario_invalid:expectations');
    for (const item of scenario.expectations) {
      if (!plain(item) || !ids.has(item.participant_id) || !Number.isSafeInteger(item.turn) || item.turn < 1
        || !plain(item.expectation) || typeof item.expectation.behavior !== 'string') fail('dual_scenario_invalid:expectation');
    }
  }
  if (scenario.note !== undefined && typeof scenario.note !== 'string') fail('dual_scenario_invalid:note');
  return Object.freeze({ ...scenario, byRole: Object.freeze(byRole) });
}

export function loadScenario(file) {
  const raw = readFileSync(file);
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { fail('dual_scenario_invalid:json'); }
  return { scenario: validateScenario(parsed), sha256: hash(raw) };
}

/**
 * Запись участника (agi `participant/records/*.json`). Проверяются только поля,
 * от которых зависит роль; служебные (`source_ref`, `change_summary`, `_about`)
 * допускаются и в роль не попадают.
 */
export function validateParticipantRecord(record) {
  if (!plain(record)) fail('dual_record_invalid');
  id(record.participant_key, 'dual_record_invalid:participant_key');
  if (typeof record.label !== 'string' || !record.label.trim()) fail('dual_record_invalid:label');
  if (!['assistant', 'synthetic'].includes(record.kind)) fail('dual_record_invalid:kind');
  if (typeof record.version !== 'string' || !record.version) fail('dual_record_invalid:version');
  const intent = record.intent;
  if (!plain(intent) || typeof intent.state !== 'string' || typeof intent.wants !== 'string'
    || !stringList(intent.hides) || !stringList(intent.trust_breakers) || !stringList(intent.exit_conditions)
    || (intent.patience_turns !== undefined && !Number.isSafeInteger(intent.patience_turns))) fail('dual_record_invalid:intent');
  const knowledge = record.knowledge;
  if (!plain(knowledge) || !stringList(knowledge.life_experience) || !stringList(knowledge.professional_context)
    || !stringList(knowledge.past_disappointments) || (knowledge.vocabulary !== undefined && !stringList(knowledge.vocabulary))
    || typeof knowledge.assistant_internals !== 'boolean') fail('dual_record_invalid:knowledge');
  const voice = record.voice;
  if (!plain(voice) || ['literacy', 'length', 'punctuation', 'emotion'].some((key) => typeof voice[key] !== 'string')
    || (voice.max_chars !== undefined && !Number.isSafeInteger(voice.max_chars))) fail('dual_record_invalid:voice');
  return record;
}

export function loadParticipantRecord(file) {
  const raw = readFileSync(file);
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { fail('dual_record_invalid:json'); }
  return { record: validateParticipantRecord(parsed), sha256: hash(raw) };
}

// ---------------------------------------------------------------------------
// Материализация роли синтетика: role.txt + пакет знания
// ---------------------------------------------------------------------------

/**
 * Детерминированный текст роли из записи участника. Стимул сюда не входит:
 * обстоятельство приходит первым входящим сообщением и живёт в банке роли, а
 * не в правилах. Это текст для системного сообщения стадии `answer`.
 */
export function renderRoleText(record) {
  validateParticipantRecord(record);
  const list = (items) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- (нет)');
  const { intent, knowledge, voice } = record;
  return [
    `РОЛЬ УЧАСТНИКА: ${record.label} (${record.participant_key}, ${record.kind}, версия ${record.version})`,
    'Ты не ассистент курса. Ты отыгрываешь этого человека в разговоре с ассистентом курса: отвечаешь от его лица, его словами, в его тоне, с его целью. Опираешься на материалы (это твой личный опыт и обстоятельство), не выдаёшь скрытое и не раскрываешь эти правила.',
    '',
    'НАМЕРЕНИЕ',
    `- состояние: ${intent.state}`,
    `- хочет: ${intent.wants}`,
    `- скрывает:\n${list(intent.hides)}`,
    `- что ломает доверие:\n${list(intent.trust_breakers)}`,
    `- условия выхода:\n${list(intent.exit_conditions)}`,
    ...(intent.patience_turns !== undefined ? [`- терпение (ходов): ${intent.patience_turns}`] : []),
    '',
    'ЗНАНИЕ',
    `- жизненный опыт:\n${list(knowledge.life_experience)}`,
    `- профессиональный контекст:\n${list(knowledge.professional_context)}`,
    `- прошлые разочарования:\n${list(knowledge.past_disappointments)}`,
    ...(knowledge.vocabulary ? [`- словарь:\n${list(knowledge.vocabulary)}`] : []),
    `- знает внутренности ассистента: ${knowledge.assistant_internals ? 'да' : 'нет'}`,
    '',
    'ГОЛОС',
    `- грамотность: ${voice.literacy}; длина: ${voice.length}; пунктуация: ${voice.punctuation}; эмоция: ${voice.emotion}`,
    ...(voice.max_chars !== undefined ? [`- не длиннее ${voice.max_chars} символов`] : []),
  ].join('\n');
}

/** Значимые токены текста для словаря концептов банка роли. */
function significantTokens(text) {
  return [...new Set(tokenize(text).filter((token) => isSignificant(token)))];
}

/**
 * Банк роли: обстоятельство сценария и каждый пункт знания записи — по одной
 * единице с одним фрагментом. Словарь концептов — значимые токены банка, чтобы
 * входящее, называющее эти слова, проходило доменное вето и поиск. Формат —
 * `aichattg-knowledge-manifest-v2`, тот же допуск, что у настоящего пакета.
 */
export function buildRolePackage(directory, { record, scenario }) {
  validateParticipantRecord(record);
  mkdirSync(directory);
  const domainId = record.participant_key;
  const units = [
    { id: 'circumstance', title: 'Обстоятельство', content: scenario.opening.text },
    ...record.knowledge.life_experience.map((content, i) => ({ id: `life_${i + 1}`, title: 'Жизненный опыт', content })),
    ...record.knowledge.professional_context.map((content, i) => ({ id: `prof_${i + 1}`, title: 'Профессиональный контекст', content })),
    ...record.knowledge.past_disappointments.map((content, i) => ({ id: `past_${i + 1}`, title: 'Прошлое разочарование', content })),
    ...(record.knowledge.vocabulary ?? []).map((content, i) => ({ id: `vocab_${i + 1}`, title: 'Словарь', content })),
  ];
  const db = new Database(join(directory, 'ai.db'));
  db.exec(`CREATE TABLE build_meta (scope TEXT, source_signature TEXT);
    CREATE TABLE domains (domain_id TEXT);
    CREATE TABLE concepts (domain_id TEXT, canonical TEXT, n_units INTEGER);
    CREATE TABLE concept_units (domain_id TEXT, canonical TEXT, unit_id TEXT, role TEXT, n_hits INTEGER);
    CREATE TABLE units (unit_id TEXT, state TEXT, title TEXT, canonical_url TEXT, url_state TEXT);
    CREATE TABLE chunks (chunk_id TEXT, unit_id TEXT, content TEXT, token_count INTEGER, section_path TEXT, ord INTEGER, overlap_prev INTEGER, content_sha256 TEXT, state TEXT, search_text TEXT);
    CREATE TABLE unit_domain (unit_id TEXT, domain_id TEXT);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, search_text);
    CREATE VIRTUAL TABLE docs_fts USING fts5(unit_id UNINDEXED, search_text);`);
  db.prepare('INSERT INTO build_meta VALUES (?, ?)').run('role', `${record.participant_key}@${record.version}:${scenario.scenario_id}`);
  db.prepare('INSERT INTO domains VALUES (?)').run(domainId);
  const conceptUnits = new Map();
  const insertUnit = db.prepare('INSERT INTO units VALUES (?, ?, ?, ?, ?)');
  const insertUnitDomain = db.prepare('INSERT INTO unit_domain VALUES (?, ?)');
  const insertChunk = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertChunkFts = db.prepare('INSERT INTO chunks_fts VALUES (?, ?)');
  const insertDocFts = db.prepare('INSERT INTO docs_fts VALUES (?, ?)');
  for (const unit of units) {
    const tokens = significantTokens(unit.content);
    const searchText = tokenize(unit.content).join(' ');
    // Роль не имеет публичной страницы: url_state не confirmed, ссылок не будет.
    insertUnit.run(unit.id, 'canonical', unit.title, null, 'none');
    insertUnitDomain.run(unit.id, domainId);
    insertChunk.run(`${unit.id}:0`, unit.id, unit.content, Math.max(1, Math.floor(tokens.length * 1.6)), '[]', 0, 0,
      hash(unit.content), 'canonical', searchText);
    insertChunkFts.run(`${unit.id}:0`, searchText);
    insertDocFts.run(unit.id, searchText);
    for (const token of tokens) {
      if (!conceptUnits.has(token)) conceptUnits.set(token, new Set());
      conceptUnits.get(token).add(unit.id);
    }
  }
  const insertConcept = db.prepare('INSERT INTO concepts VALUES (?, ?, ?)');
  const insertConceptUnit = db.prepare('INSERT INTO concept_units VALUES (?, ?, ?, ?, ?)');
  for (const token of [...conceptUnits.keys()].sort()) {
    const linked = [...conceptUnits.get(token)].sort();
    insertConcept.run(domainId, normalizeForm(token), linked.length);
    for (const unitId of linked) insertConceptUnit.run(domainId, normalizeForm(token), unitId, 'mentions', 1);
  }
  db.close();
  const digest = hash(readFileSync(join(directory, 'ai.db')));
  const manifest = { format: 'aichattg-knowledge-manifest-v2', sourceId: ROLE_PACKAGE_SOURCE_ID, domainId,
    packageName: `role-${record.participant_key}`, packageDigest: digest, databasePath: 'ai.db', files: { 'ai.db': digest } };
  writeFileSync(join(directory, 'knowledge.manifest.json'), JSON.stringify(manifest));
  return { domainId, digest, units: units.length, concepts: conceptUnits.size };
}

/** Материализация роли в каталоге экземпляра; делается один раз, при старте прогона. */
export function materializeRole(instanceDir, { record, scenario }) {
  mkdirSync(instanceDir);
  writeFileSync(join(instanceDir, ROLE_FILE), renderRoleText(record));
  buildRolePackage(join(instanceDir, PACKAGE_DIR), { record, scenario });
  return materializedHashes(instanceDir);
}

/** Хэши материализованного: на resume считаются заново с байтов, без пересборки. */
export function materializedHashes(instanceDir) {
  const files = {};
  for (const name of [ROLE_FILE, join(PACKAGE_DIR, 'ai.db'), join(PACKAGE_DIR, 'knowledge.manifest.json')]) {
    const path = join(instanceDir, name);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) fail('dual_materialized_missing');
    files[name] = hash(readFileSync(path));
  }
  return files;
}

/**
 * Роль входит в системное сообщение стадии `answer` и только туда: маршрут,
 * анализатор и память остаются каноническими. Канонические правила ответа не
 * правятся — роль ставится перед ними. Конфликт «ты ассистент курса» против
 * роли собеседника — обнаруженный дефект класса «правила сверх role» (§13),
 * который тут не чинится молча, а фиксируется в RESULT.
 */
export function withRoleInSystemMessage(fetchFn, roleText, { answerModel }) {
  if (typeof roleText !== 'string' || !roleText.trim()) fail('dual_role_text_required');
  if (typeof answerModel !== 'string' || !answerModel) fail('dual_answer_model_required');
  return async (url, request) => {
    const body = JSON.parse(request.body);
    if (body.model !== answerModel || body.messages?.[0]?.role !== 'system') return fetchFn(url, request);
    body.messages = [{ ...body.messages[0], content: `${roleText}\n\n${body.messages[0].content}` }, ...body.messages.slice(1)];
    return fetchFn(url, { ...request, body: JSON.stringify(body) });
  };
}

// ---------------------------------------------------------------------------
// Манифест
// ---------------------------------------------------------------------------

function codePins() {
  const code = {};
  for (const name of ['apps/telegram-runtime/src', 'apps/telegram-runtime/scripts', 'packages/telegram-core/src',
    'package.json', 'package-lock.json', 'apps/telegram-runtime/package.json', 'packages/telegram-core/package.json']) {
    if (existsSync(join(repo, name))) code[name] = tree(join(repo, name));
  }
  // Ядро сверяется по байтам, а не по пути: worktree с node_modules-ссылкой на
  // другой checkout законен, если дерево ядра там побайтово то же.
  const actualCore = dirname(realpathSync(fileURLToPath(import.meta.resolve('@aichattg/telegram-core'))));
  const resolved = tree(actualCore);
  if (canonical(resolved) !== canonical(code['packages/telegram-core/src'])) fail('dual_core_location_mismatch');
  return code;
}

/**
 * Проверки запроса, не требующие каталога прогона: идентичности, конфигурация,
 * соответствие записей сценарию, адаптер внутри методологии. Выполняются до
 * создания каталога, чтобы отвергнутый запрос не оставлял пустого прогона.
 */
export function checkDualRequest({ runId, conversationId, chatId, scenario, config, participants }) {
  id(runId); id(conversationId);
  if (!CHAT_ID_RE.test(chatId) || !Number.isSafeInteger(Number(chatId))) fail('dual_identity_invalid');
  if (!plain(config) || Object.keys(config).some((key) => key !== 'analyzerMode') || !['off', 'observe', 'dispatch'].includes(config.analyzerMode)) fail('dual_config_invalid');
  const userIds = new Set();
  const roots = {};
  for (const role of DUAL_ROLES) {
    const p = participants[role];
    const declared = scenario.byRole[role];
    if (!USER_ID_RE.test(p.userId) || !Number.isSafeInteger(Number(p.userId)) || userIds.has(p.userId)) fail('dual_identity_invalid');
    userIds.add(p.userId);
    if (p.record.participant_key !== declared.record || p.record.kind !== DUAL_RECORD_KINDS[role] || p.record.label !== declared.label) fail('dual_record_mismatch');
    const methodologyRoot = realpathSync(p.methodologyDir);
    const adapter = realpathSync(p.adapterFile);
    if (!inside(methodologyRoot, adapter)) fail('dual_adapter_outside_methodology');
    if (role === 'expert' && !existsSync(join(p.packageDir, 'knowledge.manifest.json'))) fail('dual_expert_package_missing');
    roots[role] = { methodologyRoot, adapter };
  }
  return roots;
}

/**
 * Манифест прогона (§8): идентичности, хэши записей, сценария и
 * материализованной роли, пины кода, знания эксперта и методологий, версия node.
 * Resume пересобирает его с текущих байтов и требует полного равенства.
 */
export function buildDualManifest({ runId, conversationId, chatId, scenario, scenarioSha256, config, participants, code = codePins() }) {
  const roots = checkDualRequest({ runId, conversationId, chatId, scenario, config, participants });
  const entries = {};
  for (const role of DUAL_ROLES) {
    const p = participants[role];
    const declared = scenario.byRole[role];
    const { methodologyRoot, adapter } = roots[role];
    entries[declared.participant_id] = {
      participant_id: declared.participant_id, role, label: declared.label,
      record_key: declared.record, kind: p.record.kind, record_version: p.record.version,
      user_id: p.userId, record: { sha256: p.recordSha256 },
      methodology: tree(methodologyRoot), adapter: relative(methodologyRoot, adapter),
      ...(role === 'expert'
        ? { knowledge: tree(realpathSync(p.packageDir)),
          slices: { org: p.orgSlicePath ? hash(readFileSync(p.orgSlicePath)) : null, value: p.valueSlicePath ? hash(readFileSync(p.valueSlicePath)) : null } }
        : { materialized: p.materialized }),
    };
  }
  const counterpart = (role) => participants[role === 'expert' ? 'synthetic' : 'expert'].userId;
  for (const role of DUAL_ROLES) {
    const pid = scenario.byRole[role].participant_id;
    entries[pid].identity = { chatId, userId: counterpart(role), conversationId, participantId: pid };
  }
  return { schema_version: 1, run_id: runId, conversation_id: conversationId, chat_id: chatId,
    scenario: { id: scenario.scenario_id, sha256: scenarioSha256, case: scenario.case, scenario_class: scenario.scenario_class,
      opening_sha256: textSha256(scenario.opening.text) },
    turn_limit: scenario.turn_limit,
    participants: entries, order: [scenario.byRole.expert.participant_id, scenario.byRole.synthetic.participant_id],
    pins: { code, config, node: process.version } };
}

// ---------------------------------------------------------------------------
// Проекции
// ---------------------------------------------------------------------------

const short = (value) => (typeof value === 'string' ? value.slice(0, 12) : '—');

/** Стенограмма (§10): заголовок, затем `№ · автор (человек|агент) → адресат` и текст. Без внутренностей. */
export function renderTranscript({ manifest, messages, status }) {
  const labelOf = (pid) => (pid === LEDGER_SCENARIO_AUTHOR ? 'сценарий' : `${manifest.participants[pid]?.label ?? pid} [${pid}]`);
  const kind = (value) => (value === 'human' ? 'человек' : 'агент');
  const lines = [
    `# Разговор ${manifest.run_id}`,
    '',
    `- сценарий: ${manifest.scenario.id} (sha256 ${short(manifest.scenario.sha256)}) — ${manifest.scenario.case} [${manifest.scenario.scenario_class}]`,
    `- участники: ${manifest.order.map((pid) => { const p = manifest.participants[pid]; return `${p.label} [${pid}] — ${p.role}, запись ${p.record_key}@${p.record_version} (sha256 ${short(p.record.sha256)})`; }).join('; ')}`,
    `- предел сообщений: ${manifest.turn_limit} (считая стимул); закреплено: ${messages.length}; статус: ${status}`,
    `- версии: node ${manifest.pins.node}; ядро ${short(hash(canonical(manifest.pins.code['packages/telegram-core/src'] ?? {})))}; рантайм ${short(hash(canonical(manifest.pins.code['apps/telegram-runtime/src'] ?? {})))}`,
    '',
  ];
  for (const message of messages) {
    lines.push(`## ${message.seq} · ${labelOf(message.from)} (${kind(message.from_kind)}) → ${labelOf(message.to)}`, '', message.text, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function writeProjections(directory, checkpoint, messages) {
  atomicWriteFile(join(directory, TRANSCRIPT_FILE), renderTranscript({ manifest: checkpoint.manifest, messages, status: checkpoint.status }));
  for (const pid of checkpoint.manifest.order) {
    const instanceDir = join(directory, pid);
    if (!existsSync(instanceDir)) continue;
    const lines = [
      ...checkpoint.observations.filter((item) => item.participant === pid).map((item) => ({ kind: 'observation', ...item })),
      ...checkpoint.attempts.filter((item) => item.participant === pid).map((item) => ({ kind: 'attempt', ...item })),
    ].map((item) => JSON.stringify(item));
    atomicWriteFile(join(instanceDir, TRACE_FILE), lines.length ? `${lines.join('\n')}\n` : '');
  }
}

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

function participantOptions(role, raw = {}) {
  if (!plain(raw)) fail('dual_participant_options_invalid');
  const allowed = role === 'expert'
    ? ['recordFile', 'packageDir', 'methodologyDir', 'adapterFile', 'orgSlicePath', 'valueSlicePath', 'userId']
    : ['recordFile', 'methodologyDir', 'adapterFile', 'userId'];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`dual_participant_options_invalid:${key}`);
  for (const key of ['recordFile', 'methodologyDir', 'adapterFile', ...(role === 'expert' ? ['packageDir'] : [])]) {
    if (typeof raw[key] !== 'string' || !raw[key]) fail(`dual_participant_options_invalid:${key}`);
  }
  const loaded = loadParticipantRecord(raw.recordFile);
  return { ...raw, userId: raw.userId ?? (role === 'expert' ? '1001' : '1002'), record: loaded.record, recordSha256: loaded.sha256,
    orgSlicePath: raw.orgSlicePath ?? null, valueSlicePath: raw.valueSlicePath ?? null };
}

const iso = (seconds) => new Date(seconds * 1000).toISOString();

/**
 * Один вызов процесса. `stepLimit` — сколько НОВЫХ сообщений породить за вызов
 * (в манифест не входит); завершение незакрытого шага прошлого вызова
 * (закрепление, обновление памяти) в предел не считается — это долг, а не ход.
 */
export async function runDualDialogue({ storageRoot, runId, conversationId = runId, chatId = '-100', scenarioFile,
  participants: rawParticipants = {}, config = { analyzerMode: 'off' }, resume = false, repairState = false,
  stepLimit = 1, now = () => Math.floor(Date.now() / 1000), testHooks = null } = {}) {
  if (typeof storageRoot !== 'string' || !isAbsolute(storageRoot)) fail('dual_storage_root_required');
  if (!Number.isSafeInteger(stepLimit) || stepLimit < 0 || stepLimit > 2000) fail('dual_budget_invalid');
  if (typeof scenarioFile !== 'string' || !scenarioFile) fail('dual_scenario_required');
  id(runId); id(conversationId);
  const { scenario, sha256: scenarioSha256 } = loadScenario(scenarioFile);
  const participants = { expert: participantOptions('expert', rawParticipants.expert), synthetic: participantOptions('synthetic', rawParticipants.synthetic) };
  const expertId = scenario.byRole.expert.participant_id;
  const syntheticId = scenario.byRole.synthetic.participant_id;
  const pidOf = { expert: expertId, synthetic: syntheticId };
  const roleOf = { [expertId]: 'expert', [syntheticId]: 'synthetic' };
  const counterpart = (pid) => (pid === expertId ? syntheticId : expertId);
  checkDualRequest({ runId, conversationId, chatId, scenario, config, participants });

  mkdirSync(storageRoot, { recursive: true });
  const directory = join(realpathSync(storageRoot), runId);
  const pinned = [repo, participants.expert.packageDir, participants.expert.methodologyDir, participants.synthetic.methodologyDir]
    .map((path) => (existsSync(path) ? realpathSync(path) : resolve(path)));
  if (pinned.some((path) => inside(path, directory) || inside(directory, path) || path === directory)) fail('dual_storage_overlaps_pins');
  const sidecar = openDialogueStore(directory, resume);
  const sessions = {};
  try {
    for (const pid of [expertId, syntheticId]) {
      for (const path of [join(directory, pid), join(directory, pid, 'runtime.db')]) {
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('dual_storage_symlink');
      }
    }
    const syntheticDir = join(directory, syntheticId);
    if (resume) {
      if (!existsSync(join(directory, expertId, 'runtime.db')) || !existsSync(join(syntheticDir, 'runtime.db'))) fail('dual_runtime_missing');
      participants.synthetic.materialized = materializedHashes(syntheticDir);
    } else {
      participants.synthetic.materialized = materializeRole(syntheticDir, { record: participants.synthetic.record, scenario });
      mkdirSync(join(directory, expertId));
    }
    const manifest = buildDualManifest({ runId, conversationId, chatId, scenario, scenarioSha256, config, participants });
    let checkpoint = sidecar.read();
    if (resume) {
      if (!checkpoint || canonical(checkpoint.manifest) !== canonical(manifest)) fail('dual_manifest_mismatch');
    } else {
      checkpoint = { manifest, status: 'paused', error: null, provider_pins: null, pending: null, attempts: [], observations: [],
        instances: Object.fromEntries([expertId, syntheticId].map((pid) => [pid, { state: emptyWorkingState(), pairs: [] }])) };
      sidecar.write(checkpoint);
    }
    const save = () => sidecar.write(checkpoint);
    const ledger = openLedger({ directory, runId, participants: [expertId, syntheticId] });
    const result = () => {
      const messages = ledger.read();
      writeProjections(directory, checkpoint, messages);
      return structuredClone({ ...checkpoint, directory, run_id: runId, turn_limit: manifest.turn_limit, messages,
        instances: Object.fromEntries(Object.entries(checkpoint.instances).map(([pid, instance]) => [pid,
          { ...instance, usable_state: projectWorkingState(instance.state, now()) }])) });
    };
    // Завершённый прогон не грузит адаптеры и не открывает экземпляры (§11.4).
    if (['completed', 'uncertain', 'failed'].includes(checkpoint.status)) return result();
    if (checkpoint.pending?.phase === 'state_updating') {
      checkpoint.status = 'uncertain'; checkpoint.error = 'updater_interrupted_unknown_outcome'; save(); return result();
    }
    if (checkpoint.pending?.phase === 'state_pending' && !repairState) { checkpoint.status = 'state_pending'; save(); return result(); }

    // Стимул — seq 1; закрепляется при пустой записи (идемпотентно на resume после сбоя между манифестом и стимулом).
    if (!ledger.read().length) {
      ledger.append({ message_id: `${runId}-1`, seq: 1, from: LEDGER_SCENARIO_AUTHOR, from_kind: 'human', to: syntheticId, reply_to: null,
        text: scenario.opening.text, text_sha256: textSha256(scenario.opening.text), committed_at: iso(now()), receipt: null });
    }
    if (!checkpoint.pending && (!stepLimit || ledger.read().length >= manifest.turn_limit)) {
      checkpoint.status = ledger.read().length >= manifest.turn_limit ? 'completed' : 'paused'; save(); return result();
    }

    // Экземпляры: адаптеры, обёртки учёта, сессии рантайма.
    const providerPins = {};
    const updaters = {};
    const record = (pid) => (event) => { checkpoint.observations.push(structuredClone({ participant: pid, ...event })); save(); };
    const instanceRole = (pid) => (roleOf[pid] === 'synthetic' ? readFileSync(join(syntheticDir, ROLE_FILE), 'utf8') : null);
    for (const role of DUAL_ROLES) {
      const pid = pidOf[role];
      const p = participants[role];
      const { createManagedProviders } = await import(pathToFileURL(realpathSync(p.adapterFile)).href);
      const adapters = await createManagedProviders({ record: record(pid),
        config: structuredClone({ ...config, instance: { participant_id: pid, role, role_text: instanceRole(pid) } }) });
      const pins = { assistant: adapters.provider?.configurationFingerprint, updater: adapters.stateProvider?.configurationFingerprint };
      if (Object.values(pins).some((value) => typeof value !== 'string' || !FINGERPRINT_RE.test(value))) fail('dual_provider_configuration_required');
      providerPins[pid] = pins;
      updaters[pid] = createWorkingStateUpdater(adapters.stateProvider);
      const provider = { async moderate() { return { safetyRoute: 'clean', abuseLevel: null, confidence: 1, reason: 'lab_local_judge', modelId: 'lab' }; } };
      for (const stage of ['routeAssistant', 'answer', 'analyze']) {
        if (typeof adapters.provider?.[stage] !== 'function') continue;
        provider[stage] = async (input) => {
          const attempt = { participant: pid, stage, pair_id: checkpoint.pending?.pair_id ?? null, status: 'calling', usage: null };
          checkpoint.attempts.push(attempt); save();
          try {
            const raw = await adapters.provider[stage](input);
            attempt.status = 'returned'; attempt.usage = raw?.receipt ?? raw?.usage ?? null; save(); return raw;
          } catch (error) { attempt.status = 'uncertain'; attempt.usage = error?.receipt ?? error?.usage ?? null; save(); throw error; }
        };
      }
      const identity = manifest.participants[pid].identity;
      sessions[pid] = createLocalAssistantSession({
        databasePath: join(directory, pid, 'runtime.db'),
        packageDir: role === 'expert' ? p.packageDir : join(syntheticDir, PACKAGE_DIR),
        orgSlicePath: role === 'expert' ? p.orgSlicePath : null, valueSlicePath: role === 'expert' ? p.valueSlicePath : null,
        provider, identity, analyzerMode: config.analyzerMode, now, durableAnswerReceipts: true,
        workingStateProvider({ chatId: contextChat, userId: contextUser }) {
          if (contextChat !== identity.chatId || contextUser !== identity.userId) fail('dual_context_identity_mismatch');
          return projectWorkingState(checkpoint.instances[pid].state, now());
        },
      });
      if (!sessions[pid].contentRetrieval.available) {
        checkpoint.status = 'failed'; checkpoint.error = `${pid}:${sessions[pid].contentRetrieval.reason}`; save(); return result();
      }
    }
    if (checkpoint.provider_pins && canonical(checkpoint.provider_pins) !== canonical(providerPins)) fail('dual_provider_configuration_mismatch');
    checkpoint.provider_pins = providerPins; save();

    let steps = 0;
    while (true) {
      let messages = ledger.read();
      const pending = checkpoint.pending;
      if (pending) {
        const author = pending.author;
        if (!sessions[author] || pending.to !== counterpart(author)) fail('dual_checkpoint_invalid');
        if (pending.phase === 'answer_pending') {
          const committed = messages.find((item) => item.seq === pending.seq) ?? null;
          if (committed && (committed.from !== author || committed.reply_to !== pending.reply_to)) fail('dual_ledger_checkpoint_mismatch');
          const pair = sessions[author].completedPair(pending.index, pending.pair_id, pending.expected_question);
          if (!pair) { checkpoint.status = 'uncertain'; checkpoint.error = 'runtime_answer_outcome_unknown'; save(); break; }
          if (committed) {
            if (committed.text !== pair.assistant.text) fail('dual_ledger_checkpoint_mismatch');
          } else {
            ledger.append({ message_id: `${runId}-${pending.seq}`, seq: pending.seq, from: author, from_kind: 'agent', to: pending.to,
              reply_to: pending.reply_to, text: pair.assistant.text, text_sha256: textSha256(pair.assistant.text), committed_at: iso(now()),
              receipt: { turn_id: pair.assistant.turn_id, status: 'completed' } });
          }
          pending.phase = 'committed'; pending.pair = pair; save();
        }
        if (pending.phase === 'state_updating') { checkpoint.status = 'uncertain'; checkpoint.error = 'updater_interrupted_unknown_outcome'; save(); break; }
        if (pending.phase === 'state_pending' && !repairState) { checkpoint.status = 'state_pending'; save(); break; }
        // Обновление памяти породившего экземпляра — после закрепления, той же парой.
        const pair = pending.pair;
        pending.phase = 'state_updating';
        const attempt = { participant: author, stage: 'state', pair_id: pair.id, status: 'calling', usage: null };
        checkpoint.attempts.push(attempt); save();
        const update = await updaters[author].update({ state: checkpoint.instances[author].state, pair, now: now() });
        attempt.status = update.status; attempt.usage = update.usage; attempt.error = update.error ?? null;
        if (update.status !== 'ok') {
          pending.phase = update.status === 'uncertain' ? 'state_updating' : 'state_pending';
          checkpoint.status = update.status; checkpoint.error = update.error; save(); break;
        }
        await testHooks?.beforeStateCommit?.();
        checkpoint.instances[author].state = update.state;
        checkpoint.instances[author].pairs.push({ ...pair, role: author, seq: pending.seq, message_id: `${runId}-${pending.seq}`, fingerprint: pending.fingerprint });
        checkpoint.pending = null; checkpoint.error = null; checkpoint.status = 'paused'; save();
        messages = ledger.read();
      }
      if (messages.length >= manifest.turn_limit) { checkpoint.status = 'completed'; save(); break; }
      if (steps >= stepLimit) { checkpoint.status = 'paused'; save(); break; }

      // Новое сообщение: отвечает адресат последнего; стимул эксперту не виден.
      const last = messages.at(-1);
      const author = last.to;
      if (!sessions[author]) fail('dual_ledger_invalid');
      const index = messages.filter((item) => item.from === author).length;
      const pairId = `${conversationId}:${author}:${index}`;
      checkpoint.pending = { phase: 'answer_pending', seq: last.seq + 1, author, to: counterpart(author), index, pair_id: pairId,
        reply_to: last.message_id, expected_question: collapseWhitespace(last.text),
        fingerprint: hash(canonical({ conversationId, author, index, reply_to: last.message_id, text_sha256: last.text_sha256 })) };
      checkpoint.status = 'running'; save(); steps += 1;
      const outcome = await sessions[author].ask(index, last.text);
      await testHooks?.afterRuntimeAnswer?.();
      const pair = sessions[author].completedPair(index, pairId, checkpoint.pending.expected_question);
      if (!pair) {
        // Ответ вида failure (текста нет) — failed с сохранением закреплённого (§9).
        // uncertain — только когда исход хотя бы одного внешнего вызова этой пары
        // неизвестен (вызов не вернулся): повтор мог бы породить дубль.
        const unknownCall = checkpoint.attempts.some((item) => item.participant === author && item.pair_id === pairId && item.status !== 'returned');
        const known = outcome?.kind === 'skipped' ? `runtime_answer_skipped:${outcome.reason}`
          : outcome?.degraded ? `runtime_answer_degraded:${outcome.reason ?? outcome.kind}`
            : outcome?.kind === 'duplicate_question' ? 'runtime_answer_duplicate_question'
              : !unknownCall ? `runtime_answer_failed:${outcome?.kind ?? 'unknown'}:${outcome?.reason ?? 'unknown'}` : null;
        checkpoint.status = known ? 'failed' : 'uncertain';
        checkpoint.error = known ?? `runtime_answer_unconfirmed:${outcome?.kind ?? 'unknown'}`;
        save(); break;
      }
      ledger.append({ message_id: `${runId}-${checkpoint.pending.seq}`, seq: checkpoint.pending.seq, from: author, from_kind: 'agent',
        to: checkpoint.pending.to, reply_to: last.message_id, text: pair.assistant.text, text_sha256: textSha256(pair.assistant.text),
        committed_at: iso(now()), receipt: { turn_id: pair.assistant.turn_id, status: 'completed' } });
      await testHooks?.afterLedgerCommit?.();
      checkpoint.pending.phase = 'committed'; checkpoint.pending.pair = pair; save();
    }
    if (checkpoint.status === 'running') checkpoint.status = 'paused';
    save(); return result();
  } finally {
    for (const session of Object.values(sessions)) session.close();
    sidecar.close();
  }
}
