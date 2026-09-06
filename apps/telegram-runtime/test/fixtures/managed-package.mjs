import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// Tiny admitted fixture with actual SQLite/FTS retrieval. No private corpus required.
export function createManagedPackage(directory) {
  mkdirSync(directory);
  const db = new Database(join(directory, 'ai.db'));
  db.exec(`CREATE TABLE build_meta (scope TEXT, source_signature TEXT);
    INSERT INTO build_meta VALUES ('fixture','1');
    CREATE TABLE domains (domain_id TEXT); INSERT INTO domains VALUES ('ai');
    CREATE TABLE concepts (domain_id TEXT, canonical TEXT, n_units INTEGER);
    INSERT INTO concepts VALUES ('ai','prompting',2);
    CREATE TABLE concept_units (domain_id TEXT, canonical TEXT, unit_id TEXT, role TEXT, n_hits INTEGER);
    CREATE TABLE units (unit_id TEXT, state TEXT, title TEXT, canonical_url TEXT, url_state TEXT);
    CREATE TABLE chunks (chunk_id TEXT, unit_id TEXT, content TEXT, token_count INTEGER, section_path TEXT, ord INTEGER, overlap_prev INTEGER, content_sha256 TEXT, state TEXT, search_text TEXT);
    CREATE TABLE unit_domain (unit_id TEXT, domain_id TEXT);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, search_text);
    CREATE VIRTUAL TABLE docs_fts USING fts5(unit_id UNINDEXED, search_text);`);
  for (let i = 1; i <= 2; i += 1) {
    const unit = `u${i}`; const content = 'Prompting teaches clear instructions and conditions for an AI model.';
    db.prepare('INSERT INTO units VALUES (?, ?, ?, ?, ?)').run(unit, 'canonical', 'Prompting', 'https://example.invalid/lesson', 'public');
    db.prepare('INSERT INTO unit_domain VALUES (?, ?)').run(unit, 'ai');
    db.prepare('INSERT INTO concept_units VALUES (?, ?, ?, ?, ?)').run('ai', 'prompting', unit, 'explains', 3);
    db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`${unit}:0`, unit, content, 20, '[]', 0, 0, createHash('sha256').update(content).digest('hex'), 'canonical', content);
    db.prepare('INSERT INTO chunks_fts VALUES (?, ?)').run(`${unit}:0`, 'prompting clear instructions conditions AI model');
    db.prepare('INSERT INTO docs_fts VALUES (?, ?)').run(unit, 'prompting clear instructions conditions AI model');
  }
  db.close();
  const digest = createHash('sha256').update(readFileSync(join(directory, 'ai.db'))).digest('hex');
  writeFileSync(join(directory, 'knowledge.manifest.json'), JSON.stringify({ format: 'aichattg-knowledge-manifest-v2',
    sourceId: 'course-knowledge-v2', domainId: 'ai', packageName: 'managed-offline-fixture', packageDigest: digest,
    databasePath: 'ai.db', files: { 'ai.db': digest } }));
  return directory;
}
