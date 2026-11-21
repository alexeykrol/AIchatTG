import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openReadOnlyRuntimeDatabase } from '../../../apps/telegram-runtime/src/database.mjs';
import {
  ASSISTANT_SOURCE_PACKAGES, buildPack, createCandidate, createRun, groundingFromPack,
  validateAgainstSchema,
} from '../../../packages/telegram-core/src/index.mjs';

function readPackSchema(databasePath) {
  try {
    return JSON.parse(readFileSync(join(dirname(databasePath), 'contracts', 'retrieval_pack.v1.schema.json'), 'utf8'));
  } catch (error) {
    // As with normal retrieval, a package without shipped contracts can still run.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function fixedResult(rows, { domainId, packageVersion, schema }) {
  const run = createRun();
  run.selected = rows.map((row) => ({ ...createCandidate(row), reasonExtra: 'context_from' }));
  run.mergedCount = rows.length;
  run.usedTokens = rows.reduce((sum, row) => sum + row.token_count, 0);
  if (rows.length) run.status = 'ready';
  const pack = buildPack({
    request: { domain_id: domainId, max_context_tokens: run.usedTokens },
    run, packRole: 'fresh', subqueries: 0, packageVersion, packId: randomUUID().replaceAll('-', ''),
  });
  if (schema && !validateAgainstSchema(pack, schema).valid) throw new Error('retrieval pack failed schema validation');

  pack.citations = Object.fromEntries(rows.map((row) => [row.chunk_id, {
    title: row.title,
    canonicalUrl: row.url_state === 'confirmed' ? row.canonical_url : null,
  }]));
  const projected = groundingFromPack(pack, {
    sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE, maxChars: Infinity,
  });
  if ((projected.knowledge?.entries.length ?? 0) !== rows.length) {
    throw new Error('fixed context exceeds the provider entry limit');
  }
  return {
    ...projected, pack, domainId,
    trace: { status: pack.status, confidence: pack.confidence, packageVersion, grounding: projected.trace },
  };
}

/** Validate the entire selected question set before constructing any provider. */
export function loadFixedContext(runDir, { questions, databasePath, domainId = 'tcr' }) {
  const path = resolve(runDir);
  const bytes = readFileSync(join(path, 'answers.jsonl'));
  const source = new Map();
  for (const line of bytes.toString('utf8').split('\n').filter((line) => line.trim())) {
    const row = JSON.parse(line);
    if (typeof row?.q !== 'string' || !row.q) throw new Error('--context-from row is missing a question ID');
    if (source.has(row.q)) throw new Error(`--context-from duplicate question ID: ${row.q}`);
    source.set(row.q, row);
  }

  const errors = [];
  const results = new Map();
  const unitByChunk = new Map();
  const schema = readPackSchema(databasePath);
  const db = openReadOnlyRuntimeDatabase(databasePath);
  try {
    const meta = db.prepare('SELECT scope, source_signature FROM build_meta ORDER BY scope').all();
    const packageVersion = meta.length
      ? createHash('sha1').update(meta.map((row) => `${row.scope}:${row.source_signature}`).join('|')).digest('hex').slice(0, 16)
      : 'unbuilt';
    const findChunk = db.prepare(`
      SELECT c.chunk_id, c.unit_id, c.content, c.token_count, u.title, u.canonical_url, u.url_state
      FROM chunks c LEFT JOIN units u ON u.unit_id = c.unit_id WHERE c.chunk_id = ?
    `);
    for (const { q, question } of questions) {
      const row = source.get(q);
      if (!row) { errors.push(`${q}: missing question ID`); continue; }
      if (row.question !== question) { errors.push(`${q}: question text differs`); continue; }
      if (!Array.isArray(row.chunk_ids) || row.chunk_ids.some((id) => typeof id !== 'string' || !id.trim())) {
        errors.push(`${q}: invalid chunk_ids`);
        continue;
      }
      const chunks = [];
      const unknown = [];
      for (const id of new Set(row.chunk_ids)) {
        const chunk = findChunk.get(id);
        if (!chunk) unknown.push(id);
        else chunks.push(chunk);
      }
      if (unknown.length) { errors.push(`${q}: unknown chunk IDs: ${unknown.join(', ')}`); continue; }
      try {
        results.set(q, fixedResult(chunks, { domainId, packageVersion, schema }));
        for (const chunk of chunks) unitByChunk.set(chunk.chunk_id, chunk.unit_id);
      } catch (error) {
        errors.push(`${q}: ${error.message}`);
      }
    }
  } finally { db.close(); }
  if (errors.length) throw new Error(`--context-from validation failed:\n${errors.join('\n')}`);

  return {
    provenance: { path, sha256: createHash('sha256').update(bytes).digest('hex') },
    resultFor(q) { return results.get(q); },
    unitOfChunk(id) { return unitByChunk.get(id); },
  };
}
