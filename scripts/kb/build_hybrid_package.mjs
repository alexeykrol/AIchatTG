#!/usr/bin/env node
/**
 * Build a content-addressed hybrid knowledge package (offline, free, deterministic).
 *
 *   node scripts/kb/build_hybrid_package.mjs --src PKG_DIR --model-dir MODEL_DIR --out-root DIR
 *
 * Reads the source package (never modifies it) and writes OUT_ROOT/pkg-hybrid-<digest12>/ with:
 *   ai.db                 copy of the source database plus two new tables:
 *                           passage_vectors(chunk_id, piece_ord, dim, vec BLOB float32 little-endian)
 *                           passage_vectors_meta(key, value) — model/tokenizer sha256, recipe, counts;
 *   model/                the exact quantized graph + tokenizer the runtime will use for the QUESTION
 *                         (model_quint8_avx2.onnx, tokenizer.json, tokenizer_config.json);
 *   contracts/, gold/, README.md   copied as listed in the source knowledge.manifest.json;
 *   knowledge.manifest.json        format v2, databasePath ai.db, real sha256 of every file,
 *                                  packageDigest = sha256 of sorted "path  sha256\n" lines.
 *
 * Passage pieces and their vectors are produced by the runtime's own modules
 * (apps/telegram-runtime/src/hybrid-retrieval.mjs passagePieces + embedder.mjs), so the
 * passage side and the question side share tokenizer, graph, pooling and normalization by
 * construction, and the runtime refuses vectors whose recorded model digest differs from the
 * model file it loads. The result is admitted with telegram-core's admitKnowledgePackage
 * before the script reports success.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEmbedder, EMBEDDER_RECIPE, PACKAGE_MODEL_FILES as MODEL_FILES,
} from '../../apps/telegram-runtime/src/embedder.mjs';
import { passagePieces } from '../../apps/telegram-runtime/src/hybrid-retrieval.mjs';
import { admitKnowledgePackage } from '../../packages/telegram-core/src/knowledge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../apps/telegram-runtime/package.json'));
const Database = require('better-sqlite3');

export const PIECE_RECIPE = 'windows3_stride2+alias_lines';
const BATCH = 32;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function packageDigestOf(files) {
  const lines = Object.keys(files).sort().map((path) => `${path}  ${files[path]}\n`).join('');
  return createHash('sha256').update(lines).digest('hex');
}

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['src', 'model-dir', 'out-root']) if (!out[k]) throw new Error(`--${k} is required`);
  return out;
}

async function main() {
  const a = args(process.argv);
  const src = resolve(a.src);
  const modelDir = resolve(a['model-dir']);
  const outRoot = resolve(a['out-root']);
  const srcManifest = JSON.parse(readFileSync(join(src, 'knowledge.manifest.json'), 'utf8'));
  const staging = join(outRoot, `.staging-hybrid-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'model'), { recursive: true });

  // Content files of the source package (its own list), with the database renamed to ai.db.
  for (const path of Object.keys(srcManifest.files)) {
    const target = path === srcManifest.databasePath ? 'ai.db' : path;
    const from = join(src, path === srcManifest.databasePath && !existsSync(join(src, path)) ? 'ai.db' : path);
    mkdirSync(dirname(join(staging, target)), { recursive: true });
    copyFileSync(from, join(staging, target));
  }
  if (!existsSync(join(staging, 'ai.db'))) copyFileSync(join(src, 'ai.db'), join(staging, 'ai.db'));
  copyFileSync(join(modelDir, 'model_quint8_avx2.onnx'), join(staging, MODEL_FILES.model));
  copyFileSync(join(modelDir, 'tokenizer.json'), join(staging, MODEL_FILES.tokenizer));
  copyFileSync(join(modelDir, 'tokenizer_config.json'), join(staging, MODEL_FILES.tokenizerConfig));

  const embedder = createEmbedder({
    modelPath: join(staging, MODEL_FILES.model),
    tokenizerPath: join(staging, MODEL_FILES.tokenizer),
    tokenizerConfigPath: join(staging, MODEL_FILES.tokenizerConfig),
  });

  const db = new Database(join(staging, 'ai.db'));
  db.pragma('journal_mode = DELETE');
  const rows = db.prepare(
    "SELECT chunk_id, content, coalesce(search_alias, '') AS alias FROM chunks ORDER BY unit_id, ord").all();
  const pieces = [];
  for (const row of rows) {
    passagePieces(row.content, row.alias).forEach((text, ord) => pieces.push({ chunkId: row.chunk_id, ord, text }));
  }
  const vectors = [];
  for (let i = 0; i < pieces.length; i += BATCH) {
    vectors.push(...await embedder.embed(pieces.slice(i, i + BATCH).map((p) => p.text)));
  }
  db.exec(`
    DROP TABLE IF EXISTS passage_vectors;
    DROP TABLE IF EXISTS passage_vectors_meta;
    CREATE TABLE passage_vectors (
      chunk_id TEXT NOT NULL, piece_ord INTEGER NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL,
      PRIMARY KEY (chunk_id, piece_ord));
    CREATE TABLE passage_vectors_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const insert = db.prepare('INSERT INTO passage_vectors VALUES (?, ?, ?, ?)');
  const meta = db.prepare('INSERT INTO passage_vectors_meta VALUES (?, ?)');
  db.transaction(() => {
    pieces.forEach((p, i) => {
      const v = vectors[i];
      insert.run(p.chunkId, p.ord, v.length, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    });
    meta.run('model_sha256', sha256File(join(staging, MODEL_FILES.model)));
    meta.run('tokenizer_sha256', sha256File(join(staging, MODEL_FILES.tokenizer)));
    meta.run('recipe', JSON.stringify({ ...EMBEDDER_RECIPE, pieces: PIECE_RECIPE }));
    meta.run('passages', String(rows.length));
    meta.run('pieces', String(pieces.length));
  })();
  db.exec('VACUUM');
  db.close();

  const files = {};
  const listed = [...Object.keys(srcManifest.files).map((p) => (p === srcManifest.databasePath ? 'ai.db' : p)),
    ...Object.values(MODEL_FILES)];
  for (const path of [...new Set(listed)].sort()) files[path] = sha256File(join(staging, path));
  const packageDigest = packageDigestOf(files);
  const manifest = {
    databasePath: 'ai.db',
    domainId: srcManifest.domainId,
    files,
    format: 'aichattg-knowledge-manifest-v2',
    packageDigest,
    packageName: `${srcManifest.domainId}-hybrid-${packageDigest.slice(0, 12)}`,
    sourceId: srcManifest.sourceId,
  };
  writeFileSync(join(staging, 'knowledge.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const admitted = admitKnowledgePackage({
    manifest, root: staging, expectedIdentity: { sourceId: manifest.sourceId, packageDigest },
  });
  if (!admitted.available) throw new Error(`admission failed: ${admitted.reason}`);

  const final = join(outRoot, `pkg-hybrid-${packageDigest.slice(0, 12)}`);
  if (existsSync(final)) {
    rmSync(staging, { recursive: true, force: true });
    console.log(JSON.stringify({ package: final, packageDigest, reused: true }));
    return;
  }
  renameSync(staging, final);
  console.log(JSON.stringify({
    package: final, packageDigest, passages: rows.length, pieces: pieces.length,
    model_sha256: files[MODEL_FILES.model], ai_db_sha256: files['ai.db'],
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
