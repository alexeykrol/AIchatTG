#!/usr/bin/env node
/**
 * Прогон произвольных вопросов через ретривер — что бот НАШЁЛ БЫ.
 *
 * Отличие от eval-gold: там измеряются метрики против эталона, здесь эталона
 * нет. Это инструмент для живых вопросов, у которых никто не размечал
 * правильный ответ: показывает статус, найденные уроки и ссылки, чтобы человек
 * посмотрел глазами и сказал, попал бот или нет.
 *
 * Модель НЕ вызывается: ни рубля не тратится, ответ не генерируется. Меряется
 * ровно то, что решает качество ответа, — попал ли поиск в нужный урок.
 *
 *   node probe-questions.mjs --db <пакет>/ai.db --questions вопросы.txt
 *   node probe-questions.mjs --db … --questions q.jsonl --field text
 *   node probe-questions.mjs --db … --questions q.txt --out отчёт.md --json сырое.json
 *
 * Формат входа: .txt — один вопрос на строку; .jsonl — объекты, поле берётся
 * из --field (по умолчанию `question`); .json — массив строк или объектов.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRetrieverAdapter } from '../src/retriever-adapter.mjs';
import { groundingFromPack } from '@aichattg/telegram-core';

function parseArgs(argv) {
  const args = { field: 'question', maxEntries: 12, maxContextTokens: 6_000 };
  for (let i = 2; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    if (inline === undefined && key.startsWith('--')) i += 1;
    if (key === '--db') args.db = value;
    else if (key === '--questions') args.questions = value;
    else if (key === '--field') args.field = value;
    else if (key === '--out') args.out = value;
    else if (key === '--json') args.json = value;
    else if (key === '--limit') args.limit = Number(value);
    else if (key === '--max-entries') args.maxEntries = Number(value);
  }
  if (!args.db || !args.questions) {
    throw new Error('нужны --db <путь к ai.db> и --questions <файл>');
  }
  return args;
}

/** Вопросы из txt / jsonl / json, без предположений о формате. */
function loadQuestions(path, field) {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    return raw.split('\n').filter((l) => l.trim()).map((line, i) => {
      const row = JSON.parse(line);
      return { id: row.query_id || row.id || `q${i + 1}`, text: String(row[field] ?? row.question ?? row.text ?? '') };
    }).filter((q) => q.text.trim());
  }
  if (path.endsWith('.json')) {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed.questions || [];
    return rows.map((row, i) => (typeof row === 'string'
      ? { id: `q${i + 1}`, text: row }
      : { id: row.query_id || row.id || `q${i + 1}`, text: String(row[field] ?? row.question ?? row.text ?? '') }))
      .filter((q) => q.text.trim());
  }
  return raw.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((text, i) => ({ id: `q${i + 1}`, text }));
}

function unitOfChunk(chunkId) {
  const parts = String(chunkId).split(':');
  return parts.length <= 2 ? chunkId : parts.slice(0, parts.length - 2).join(':');
}

const args = parseArgs(process.argv);
const packageRoot = args.db.replace(/\/[^/]*$/, '');
const retriever = createRetrieverAdapter({
  databasePath: args.db,
  maxEntries: args.maxEntries,
  maxContextTokens: args.maxContextTokens,
});

let questions = loadQuestions(args.questions, args.field);
if (Number.isFinite(args.limit) && args.limit > 0) questions = questions.slice(0, args.limit);

const started = process.hrtime.bigint();
const results = [];
for (const question of questions) {
  const answer = retriever.forQuestion({ question: question.text, sessionId: `probe:${question.id}` });
  if (!answer.available) {
    results.push({ ...question, status: 'ERROR', reason: answer.reason, units: [], entries: 0 });
    continue;
  }
  const pack = answer.pack;
  const grounding = groundingFromPack(pack, { sourceId: 'course-knowledge-v2' });
  const entries = grounding.knowledge?.entries ?? [];
  const units = [];
  for (const entry of entries) {
    const unit = unitOfChunk(entry.id);
    if (!units.some((u) => u.unit === unit)) {
      units.push({ unit, title: entry.title ?? null, url: entry.canonicalUrl ?? null });
    }
  }
  results.push({
    ...question,
    status: pack.status,
    confidence: pack.confidence,
    grounded: grounding.grounded,
    reason: grounding.reason ?? null,
    entries: entries.length,
    withUrl: entries.filter((e) => e.canonicalUrl).length,
    chars: entries.reduce((sum, e) => sum + e.content.length, 0),
    concepts: pack.retrieval_trace?.concept_matches ?? [],
    gaps: pack.gaps ?? [],
    units,
  });
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

const byStatus = {};
for (const row of results) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
const grounded = results.filter((r) => r.grounded);
const linked = grounded.filter((r) => r.withUrl > 0);

console.log(`вопросов: ${results.length}   пакет: ${packageRoot.split('/').pop()}`);
console.log(`статусы: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`с материалом: ${grounded.length} (${(grounded.length / results.length * 100).toFixed(0)}%), из них со ссылкой: ${linked.length}`);
console.log(`время: ${(elapsedMs / 1000).toFixed(1)} с (${(elapsedMs / results.length).toFixed(0)} мс/вопрос)`);

if (args.json) {
  writeFileSync(args.json, `${JSON.stringify({ package: packageRoot, results }, null, 2)}\n`, 'utf8');
  console.log(`сырое: ${args.json}`);
}

if (args.out) {
  const lines = [
    '# Прогон живых вопросов через ретривер', '',
    `**Пакет:** \`${packageRoot.split('/').pop()}\`  `,
    `**Вопросов:** ${results.length}  `,
    `**С материалом:** ${grounded.length}, из них со ссылкой на урок: ${linked.length}  `,
    `**Молчаний:** ${results.length - grounded.length}`, '',
    'Модель не вызывалась: показано, что ретривер НАШЁЛ, а не что бот ответил.',
    'Смотреть глазами: попал ли найденный урок в смысл вопроса.', '',
  ];
  for (const row of results) {
    lines.push(`## ${row.id}. ${row.text}`, '');
    if (!row.grounded) {
      lines.push(`**МОЛЧАНИЕ** — status=\`${row.status}\`${row.reason ? `, ${row.reason}` : ''}`);
      if (row.gaps?.length) lines.push('', ...row.gaps.map((g) => `- ${g}`));
      lines.push('');
      continue;
    }
    lines.push(`status=\`${row.status}\` confidence=\`${row.confidence}\` — ${row.entries} фрагментов, ${row.chars} знаков`);
    if (row.concepts?.length) lines.push(`концепты: ${row.concepts.join(', ')}`);
    lines.push('');
    for (const unit of row.units) {
      lines.push(`- ${unit.title || unit.unit}${unit.url ? `  \n  ${unit.url}` : '  \n  *(без ссылки)*'}`);
    }
    lines.push('');
  }
  writeFileSync(args.out, `${lines.join('\n')}\n`, 'utf8');
  console.log(`отчёт: ${args.out}`);
}
