#!/usr/bin/env node
/**
 * Выгрузка журнала дефицитов покрытия из SQLite рантайма в JSON-файл для
 * лаборатории. Журнал пишет рантайм при каждом out_of_coverage-воздержании
 * (см. runtime.mjs / runtime_assistant_coverage_deficits); мост между боевым
 * рантаймом и лабораторией — файл, а не общая база.
 *
 * Запуск:
 *   node apps/telegram-runtime/scripts/export-deficits.mjs \
 *     --db <runtime.db> --out <deficits.json> [--limit 1000]
 *
 * База открывается строго read-only: инструмент выгрузки не имеет права менять
 * схему или данные боевого рантайма. Старая база без таблицы журнала — не
 * ошибка, а честный пустой экспорт: рантайм этой версии ещё ничего не журналил.
 */
import { writeFileSync } from 'node:fs';
import { openReadOnlyRuntimeDatabase } from '../src/database.mjs';

const DEFAULT_LIMIT = 1_000;

function parseArgs(argv) {
  const args = { db: null, out: null, limit: DEFAULT_LIMIT };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    if (inline === undefined) i += 1;
    if (key === '--db') args.db = value;
    else if (key === '--out') args.out = value;
    else if (key === '--limit') args.limit = Number(value);
  }
  return args;
}

/**
 * Один снимок журнала из read-only базы. Вынесен отдельной функцией, чтобы тест
 * вызывал ровно то же, что и main, без подмены аргументов процесса.
 */
export function exportCoverageDeficits({ databasePath, limit = DEFAULT_LIMIT }) {
  const db = openReadOnlyRuntimeDatabase(databasePath);
  try {
    const table = db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'runtime_assistant_coverage_deficits'`).get();
    const boundedLimit = Math.max(1, Math.min(100_000, Number.parseInt(limit, 10) || DEFAULT_LIMIT));
    const deficits = table
      ? db.prepare(`SELECT id, chat_id, user_id, question, reason, candidate_level, created_at
          FROM runtime_assistant_coverage_deficits
          ORDER BY created_at DESC, id DESC LIMIT ?`).all(boundedLimit)
        .map((row) => ({
          id: row.id,
          chatId: row.chat_id,
          userId: row.user_id,
          question: row.question,
          reason: row.reason,
          candidateLevel: row.candidate_level,
          createdAt: row.created_at,
        }))
      : [];
    return Object.freeze({
      schema: 'coverage_deficits_export.v1',
      exported_at: new Date().toISOString(),
      database: databasePath,
      journal_present: table != null,
      count: deficits.length,
      deficits,
    });
  } finally {
    db.close();
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || !args.out) {
    console.error('нужны --db <runtime.db> и --out <deficits.json>');
    return 2;
  }
  const snapshot = exportCoverageDeficits({ databasePath: args.db, limit: args.limit });
  writeFileSync(args.out, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`журнал дефицитов: записей ${snapshot.count}`
    + `${snapshot.journal_present ? '' : ' (таблицы журнала в базе ещё нет)'} → ${args.out}`);
  return 0;
}

// Запуск как скрипта; при импорте из теста main не выполняется.
if (process.argv[1] && process.argv[1].endsWith('export-deficits.mjs')) {
  process.exit(main());
}
