#!/usr/bin/env node
/**
 * Чтение журнала наблюдений анализатора. ТОЛЬКО чтение: база открывается
 * readonly, ни одной записи, ни одного платного вызова.
 *
 * Зачем скрипт, а не запрос руками: замер повторяется каждый раз, когда в
 * тестовом чате накопились ходы. Повторяемая разведка, живущая в голове,
 * каждый раз собирается заново и каждый раз чуть иначе — и цифры перестают
 * быть сравнимыми между прогонами.
 *
 * Запуск на проде (образ содержит только src/, поэтому скрипт скармливается
 * контейнеру через stdin — копировать файлы внутрь работающего контейнера ради
 * чтения не нужно):
 *   ssh news-vps 'docker exec -i aichattg-aichattg-telegram-runtime-1 node - --limit 50' \
 *     < scripts/aichattg/analyzer-journal.cjs
 * Локально:
 *   node scripts/aichattg/analyzer-journal.cjs --db path/to.sqlite
 *
 * Формат CommonJS выбран ровно поэтому: скрипт со stdin исполняется как CJS.
 */

// Драйвер ищется сначала рядом со скриптом, потом от текущей папки: со stdin в
// контейнере путь скрипта отсутствует и разрешение идёт от cwd, а локально —
// наоборот. Один и тот же файл обязан работать в обоих случаях.
function loadDriver() {
  try { return require('better-sqlite3'); } catch { /* локальный запуск вне пакета */ }
  const { createRequire } = require('node:module');
  return createRequire(`${process.cwd()}/`)('better-sqlite3');
}

const Database = loadDriver();

const DEFAULT_DB = '/var/lib/aichattg/telegram-runtime/telegram-runtime.sqlite';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const db = new Database(arg('db', DEFAULT_DB), { readonly: true });
const limit = Math.max(1, Math.min(1_000, Number.parseInt(arg('limit', '30'), 10) || 30));

// `detector_debt` дописан аддитивно (этап Ф3). Читалка обязана работать и с
// базой, где колонки ещё нет: иначе разведка по старому снимку падает вместо
// того, чтобы честно сказать «долга не записано».
function columnsOf(table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch { return new Set(); }
}
function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
const observationColumns = columnsOf('runtime_assistant_analyzer_observations');
const debtColumn = observationColumns.has('detector_debt') ? 'detector_debt' : 'NULL AS detector_debt';

// Окно прогона. Без него журнал смешивает прогоны, а вопросы ритуала от
// прогона к прогону ОДНИ И ТЕ ЖЕ — и по тексту строки неотличимы. Один такой
// разбор уже привёл к выводу «правило не сработало» по строкам прошлого
// прогона; правду дал только идентификатор хода. Поэтому: окно фильтром,
// идентификатор — в выводе.
function toEpoch(value, name) {
  if (!value) return null;
  const parsed = /^\d+$/u.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name}: не дата и не epoch — ${value}`);
  return parsed > 1e11 ? Math.floor(parsed / 1000) : parsed;
}
const since = toEpoch(arg('since', ''), '--since');
const until = toEpoch(arg('until', ''), '--until');
const chat = arg('chat', '');

const where = ['1=1'];
const params = [];
if (since !== null) { where.push('created_at >= ?'); params.push(since); }
if (until !== null) { where.push('created_at <= ?'); params.push(until); }
if (chat) { where.push('chat_id = ?'); params.push(String(chat)); }

const rows = db.prepare(`SELECT event_id, chat_id, question, status, topics, level, level_confidence, intent,
    intent_confidence, hints, route_action, route_source_id, verdict_json, ${debtColumn}, error, created_at
  FROM runtime_assistant_analyzer_observations WHERE ${where.join(' AND ')}
  ORDER BY created_at DESC, event_id DESC LIMIT ?`).all(...params, limit);

if (rows.length === 0) {
  console.log('журнал пуст: в наблюдаемых чатах ещё не было вопросов');
  process.exit(0);
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
    .map(([value, count]) => `${value || '—'}=${count}`).join(' ');
}

const ok = rows.filter((row) => row.status === 'ok');
console.log(`ходов: ${rows.length} · ok=${ok.length} `
  + `invalid=${rows.filter((r) => r.status === 'invalid').length} `
  + `error=${rows.filter((r) => r.status === 'error').length}`);
console.log(`темы:      ${tally(ok.flatMap((row) => (row.topics || '').split(',').filter(Boolean)))}`);
console.log(`уровень:   ${tally(ok.map((row) => row.level))}`);
console.log(`намерение: ${tally(ok.map((row) => row.intent))}`);
console.log(`хинты:     ${tally(rows.flatMap((row) => (row.hints || '').split(',').filter(Boolean)))}`);
console.log(`маршрут:   ${tally(rows.map((row) => row.route_action))}`);

// ── Расход ──────────────────────────────────────────────────────────────────
// Имя модели рантайм писал и раньше, токены — нет, поэтому по бою можно было
// назвать число вызовов, но не стоимость. Здесь суммируются ровно те счётчики,
// которые назвал провайдер: вызовы без учёта печатаются отдельным числом и в
// сумму нулями НЕ подмешиваются — иначе пробел учёта выглядел бы экономией.
//
// Сумма считается по ОКНУ, а не по показанным строкам: `--limit` режет вывод,
// но не прогон, и складывать «последние 30 напечатанных» значило бы мерить
// длину вывода вместо цены прогона.
//
// Колонки дописаны аддитивно (как detector_debt), поэтому снимок, сделанный до
// них, обязан читаться: честное «расход не записан» полезнее падения.
function spend(table, { modelColumn = 'model_id', prefix = '' } = {}) {
  if (!tableExists(table)) return null;
  const columns = columnsOf(table);
  if (!columns.has(`${prefix}input_tokens`) || !columns.has(modelColumn)) return null;
  const row = db.prepare(`SELECT
      COUNT(${modelColumn}) AS calls,
      COUNT(${prefix}input_tokens) AS measured,
      SUM(${prefix}input_tokens) AS input,
      SUM(${prefix}output_tokens) AS output,
      SUM(${prefix}total_tokens) AS total
    FROM ${table} WHERE ${where.join(' AND ')}`).get(...params);
  return {
    calls: row.calls || 0, measured: row.measured || 0,
    input: row.input || 0, output: row.output || 0, total: row.total || 0,
  };
}

const OBSERVATIONS = 'runtime_assistant_analyzer_observations';
const ANSWERS = 'runtime_assistant_answer_records';
const stages = [
  ['анализатор', spend(OBSERVATIONS)],
  ['роутер', spend(OBSERVATIONS, { modelColumn: 'route_model_id', prefix: 'route_' })],
  ['ответ', spend(ANSWERS)],
];
const measuredStages = stages.filter(([, value]) => value !== null);
if (measuredStages.length === 0) {
  console.log('\nрасход за окно: в этом снимке базы учёт затрат не записан (колонки добавлены позже)');
} else {
  const totals = measuredStages.reduce((sum, [, value]) => ({
    calls: sum.calls + value.calls, measured: sum.measured + value.measured,
    input: sum.input + value.input, output: sum.output + value.output, total: sum.total + value.total,
  }), { calls: 0, measured: 0, input: 0, output: 0, total: 0 });
  const unmeasured = totals.calls - totals.measured;
  // Деньги не считаются намеренно: тариф — знание вне рантайма, а выдуманная
  // цифра в отчёте хуже её отсутствия (тот же контракт, что у лаборатории).
  // «за окно» в заголовке не украшение: строки выше режет `--limit`, а расход
  // считается по всему окну, и без этого слова два числа читались бы как одно.
  console.log(`\nрасход за окно: вызовов ${totals.calls} · вход ${totals.input} · выход ${totals.output}`
    + ` · всего ${totals.total}${unmeasured ? ` · без учёта вызовов: ${unmeasured}` : ''}`);
  for (const [name, value] of stages) {
    if (value === null) { console.log(`  · ${name}: в базе нет колонок учёта`); continue; }
    console.log(`  · ${name}: вызовов ${value.calls} · вход ${value.input} · выход ${value.output}`
      + ` · всего ${value.total}${value.calls > value.measured ? ` · без учёта: ${value.calls - value.measured}` : ''}`);
  }
}

// Расхождение хинта и модели — самое ценное место журнала: там либо детектор
// слеп, либо суждение мимо. Сравнение СИММЕТРИЧНО: односторонняя проверка
// (только «хинт сработал, а модель не согласна») не видит именно тот случай,
// ради которого журнал и заведён, — молчащий детектор при уверенной модели.
// `pill` из сравнения исключён: это не тема, а признак класса ответа.
const TOPIC_HINTS = new Set(['operations', 'value']);
function hintTopics(row) {
  return (row.hints || '').split(',').filter((h) => TOPIC_HINTS.has(h));
}
function modelTopics(row) {
  return (row.topics || '').split(',').filter((t) => TOPIC_HINTS.has(t));
}
const disagreements = ok.filter((row) => {
  const hints = new Set(hintTopics(row));
  const topics = new Set(modelTopics(row));
  return [...hints].some((h) => !topics.has(h)) || [...topics].some((t) => !hints.has(t));
});
console.log(`\nрасхождений хинт↔модель: ${disagreements.length}`);
for (const row of disagreements) {
  const side = hintTopics(row).length ? '' : ' (детектор молчит)';
  console.log(`  · хинты:[${hintTopics(row).join(',') || '—'}] ↔ модель:[${modelTopics(row).join(',')}]${side}`
    + ` — ${String(row.question).slice(0, 70)}`);
}

// Долг детектора: спор слоёв маршрута, разрешённый в пользу доказанной
// точности (§2.3а, правило 3). Спор, выигранный молча, скрыл бы пробел
// детектора и выглядел бы чистым прогоном — поэтому он печатается отдельной
// строкой, а не растворяется в расхождениях выше.
const debts = rows.map((row) => {
  try { return row.detector_debt ? JSON.parse(row.detector_debt) : null; } catch { return null; }
});
const withDebt = rows.filter((row, index) => debts[index]);
console.log(`долг детектора: ${withDebt.length}`);
for (const row of withDebt) {
  const debt = debts[rows.indexOf(row)];
  console.log(`  · ${debt.kind}: детектор:${debt.detector} ↔ модель:${debt.model}`
    + ` (${debt.modelAction}) → ${debt.resolvedTo} по ${debt.resolvedBy}`
    + ` — ${String(row.question).slice(0, 60)}`);
}

// Недоказанная улика: модель сослалась на цитату, которой в ходе нет.
const invented = ok.filter((row) => {
  try { return (JSON.parse(row.verdict_json || '{}').quotesUnverified || []).length > 0; } catch { return false; }
});
console.log(`вердиктов с недоказанной уликой: ${invented.length}`);
// `quotesUnverified` держит ИМЕНА полей, а не сами цитаты, поэтому печатаем и то и
// другое: без текста цитаты непонятно, выдумала модель улику или оборвала её.
for (const row of invented) {
  let verdict = {};
  try { verdict = JSON.parse(row.verdict_json || '{}'); } catch { verdict = {}; }
  const quoteOf = {
    topics: verdict.topicsEvidence,
    level: verdict.level?.evidence,
    intent: verdict.intent?.evidence,
  };
  console.log(`  · ${String(row.question).slice(0, 60)}`);
  for (const field of verdict.quotesUnverified || []) {
    console.log(`      ${field}: «${String(quoteOf[field] ?? '').slice(0, 110)}» — дословно в ходе не найдено`);
  }
}

console.log(`\n— ходы (свежие сверху)${since !== null || until !== null || chat ? ', окно задано' : ''} —`);
for (const row of rows) {
  const when = new Date(row.created_at * 1000).toISOString().slice(5, 16).replace('T', ' ');
  // Идентификатор хода печатается всегда: вопросы ритуала повторяются от
  // прогона к прогону, и по тексту строку от строки не отличить.
  const head = `${when} ${String(row.event_id || '').replace(/^assistant:/u, '#')} [${row.status}]`;
  if (row.status !== 'ok') {
    console.log(`${head} ${String(row.question).slice(0, 90)}\n    ошибка: ${row.error}`);
    continue;
  }
  let evidence = '';
  try {
    const verdict = JSON.parse(row.verdict_json || '{}');
    evidence = verdict.level?.evidence || verdict.topicsEvidence || '';
  } catch { evidence = ''; }
  console.log(`${head} ${String(row.question).slice(0, 90)}`);
  console.log(`    ${row.topics} · ${row.level}/${row.level_confidence} · ${row.intent}/${row.intent_confidence}`
    + ` · хинты:${row.hints || '—'} · маршрут:${row.route_action}`);
  if (evidence) console.log(`    улика: «${evidence.slice(0, 120)}»`);
}
