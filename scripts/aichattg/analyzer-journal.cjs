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

const rows = db.prepare(`SELECT question, status, topics, level, level_confidence, intent,
    intent_confidence, hints, route_action, route_source_id, verdict_json, error, created_at
  FROM runtime_assistant_analyzer_observations ORDER BY created_at DESC LIMIT ?`).all(limit);

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

console.log('\n— ходы (свежие сверху) —');
for (const row of rows) {
  const when = new Date(row.created_at * 1000).toISOString().slice(5, 16).replace('T', ' ');
  const head = `${when} [${row.status}]`;
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
