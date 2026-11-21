import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ASSISTANT_SOURCE_PACKAGES } from '@aichattg/telegram-core';
import { loadRuntimeConfig } from '../src/config.mjs';
import { createKnowledgeAdapter } from '../src/knowledge-adapter.mjs';
import { createKnowledgeRetrieval } from '../src/knowledge-retrieval.mjs';
import {
  PACKAGE_RETRIEVAL_DEFAULTS,
  assertPackageSlotsAdmitted,
  bindRetrievalsToDomains,
} from '../src/knowledge-packages.mjs';
import { DEFAULT_DOMAIN_CATALOG } from '../src/assistant-domains.mjs';
import { MERGED_KNOWLEDGE_MAX_CHARS, resolveDomainSelection } from '../src/assistant-domain-routing.mjs';

/**
 * Generic retrieval-package registry: N bases, each a slot keyed by its source
 * id and bound to domains through the domain registry. The built-in course slot
 * keeps its single-slot env exactly as before.
 */

const COURSE = ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE;
const sha = (text) => createHash('sha256').update(text).digest('hex');

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'aichattg-packages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A v2 package on disk: every listed file exists and matches its digest. */
function writePackage(root, dir, { domainId, digestSeed, withModel = false, manifestSourceId = COURSE }) {
  const folder = join(root, dir);
  mkdirSync(folder, { recursive: true });
  const files = {};
  const put = (rel, content) => {
    mkdirSync(join(folder, rel, '..'), { recursive: true });
    writeFileSync(join(folder, rel), content);
    files[rel] = sha(content);
  };
  put('ai.db', `SQLite fixture ${domainId}`);
  if (withModel) {
    put('model/model_quint8_avx2.onnx', 'shared-model-bytes');
    put('model/tokenizer.json', '{"shared":true}');
    put('model/tokenizer_config.json', '{}');
  }
  const packageDigest = sha(digestSeed);
  writeFileSync(join(folder, 'knowledge.manifest.json'), JSON.stringify({
    format: 'aichattg-knowledge-manifest-v2', sourceId: manifestSourceId, domainId,
    packageDigest, databasePath: 'ai.db', files,
  }));
  return { manifestPath: join(folder, 'knowledge.manifest.json'), packageDigest, rel: `${dir}/knowledge.manifest.json` };
}

function writeRegistry(root, entries, name = 'packages.json') {
  writeFileSync(join(root, name), JSON.stringify(entries));
  return join(root, name);
}

function configWith(root, extraEnv = {}) {
  return loadRuntimeConfig({ TELEGRAM_RUNTIME_KNOWLEDGE_ROOT: root, ...extraEnv }, { cwd: root });
}

// ---- config parsing ---------------------------------------------------------

test('no registry configured = no extra slots; the built-in course slot is unchanged', (t) => {
  const root = tempRoot(t);
  const config = configWith(root, {
    TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_MANIFEST_PATH: join(root, 'ai/knowledge.manifest.json'),
    TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_DIGEST_SHA256: 'ab'.repeat(32),
  });
  assert.deepEqual(config.knowledge.packages.slots, []);
  assert.equal(config.knowledge.packages.path, null);
  const course = config.knowledge.admissions[COURSE];
  assert.equal(course.expectedIdentity.sourceId, COURSE);
  assert.equal(course.manifestPath, join(root, 'ai/knowledge.manifest.json'));
  // The course slot still reads only the old TELEGRAM_RUNTIME_ASSISTANT_RETRIEVAL_* env.
  assert.equal(config.assistantRetrieval.retrievalMode, 'lexical');
  assert.equal(config.assistantRetrieval.maxEntries, 12);
});

test('a registry entry gets the live recipe for every retrieval key it leaves out', (t) => {
  const root = tempRoot(t);
  const path = writeRegistry(root, [
    { sourceId: 'book-tcr-v1', manifestPath: 'tcr/knowledge.manifest.json', digestSha256: 'AB'.repeat(32) },
    { sourceId: 'other-base-v1', manifestPath: 'other/knowledge.manifest.json', digestSha256: 'cd'.repeat(32),
      retrieval: { mode: 'lexical', maxEntries: 8, linkMax: 0, linkTypes: [], coverageText: 'content' } },
  ]);
  const config = configWith(root, { TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: path });
  const [book, other] = config.knowledge.packages.slots;
  assert.equal(book.sourceId, 'book-tcr-v1');
  assert.equal(book.manifestPath, join(root, 'tcr/knowledge.manifest.json'));
  assert.equal(book.packageRoot, join(root, 'tcr'));
  assert.equal(book.packageDigest, 'ab'.repeat(32));
  assert.deepEqual(book.retrieval, {
    retrievalMode: 'hybrid', maxEntries: 24, maxContextTokens: 6000, hybridMaxContextTokens: 12000,
    noConceptGate: 'pass', coverageText: 'content+alias',
    linkExpansion: { types: ['contradicts', 'qualifies'], max: 4 },
  });
  assert.equal(PACKAGE_RETRIEVAL_DEFAULTS.mode, 'hybrid');
  assert.equal(other.retrieval.retrievalMode, 'lexical');
  assert.equal(other.retrieval.maxEntries, 8);
  assert.deepEqual(other.retrieval.linkExpansion, { types: [], max: 0 });
  assert.equal(other.retrieval.noConceptGate, 'pass');
});

test('the registry is validated strictly and fails startup on any defect', (t) => {
  const root = tempRoot(t);
  const good = { sourceId: 'book-tcr-v1', manifestPath: 'tcr/knowledge.manifest.json', digestSha256: 'ab'.repeat(32) };
  const cases = [
    [[{ ...good, extra: 1 }], /extra is not a known key/],
    [[{ ...good, retrieval: { mode: 'hybrid', topK: 3 } }], /retrieval\.topK is not a known key/],
    [[good, { ...good }], /duplicated/],
    [[{ ...good, sourceId: COURSE }], /built-in source/],
    [[{ ...good, sourceId: 'Book' }], /sourceId must match/],
    [[{ ...good, manifestPath: '../outside/knowledge.manifest.json' }], /below the knowledge root/],
    [[{ ...good, manifestPath: 'knowledge.manifest.json' }], /package directory below/],
    [[{ ...good, digestSha256: 'nope' }], /sha256/],
    [[{ ...good, retrieval: { mode: 'vector' } }], /mode must be one of/],
    [[{ ...good, retrieval: { maxEntries: 500 } }], /maxEntries must be an integer/],
    [[{ ...good, retrieval: { linkTypes: ['sibling'] } }], /linkTypes/],
    [[{ ...good, retrieval: { linkTypes: [], linkMax: 2 } }], /requires at least one link type/],
    [{ packages: [good] }, /JSON array/],
  ];
  for (const [entries, pattern] of cases) {
    const path = writeRegistry(root, entries);
    assert.throws(() => configWith(root, { TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: path }), pattern);
  }
  writeFileSync(join(root, 'broken.json'), '{not json');
  assert.throws(() => configWith(root, { TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: join(root, 'broken.json') }), /not valid JSON/);
  assert.throws(() => configWith(root, { TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: join(root, 'absent.json') }), /unreadable/);
  assert.throws(() => configWith(root, { TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: '/etc/hosts' }), /below TELEGRAM_RUNTIME_KNOWLEDGE_ROOT/);
});

// ---- admission --------------------------------------------------------------

test('two slots are admitted independently, each by its own pinned digest', (t) => {
  const root = tempRoot(t);
  const course = writePackage(root, 'ai', { domainId: 'ai', digestSeed: 'course' });
  const book = writePackage(root, 'tcr', { domainId: 'tcr', digestSeed: 'book' });
  const path = writeRegistry(root, [{ sourceId: 'book-tcr-v1', manifestPath: book.rel, digestSha256: book.packageDigest }]);
  const config = configWith(root, {
    TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_MANIFEST_PATH: course.manifestPath,
    TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_DIGEST_SHA256: course.packageDigest,
    TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: path,
  });
  const adapter = createKnowledgeAdapter(config.knowledge);
  const coursePkg = adapter.forPackage(COURSE);
  const bookPkg = adapter.forPackage('book-tcr-v1');
  assert.equal(coursePkg.available, true);
  assert.equal(coursePkg.package.sourceId, COURSE);
  assert.equal(coursePkg.package.domainId, 'ai');
  assert.equal(bookPkg.available, true);
  // The immutable manifest still says course-knowledge-v2 (package format
  // family); the slot identity comes from the registry and the digest pin.
  assert.equal(bookPkg.package.sourceId, 'book-tcr-v1');
  assert.equal(bookPkg.package.manifestSourceId, COURSE);
  assert.equal(bookPkg.package.domainId, 'tcr');
  assert.notEqual(bookPkg.package.databasePath, coursePkg.package.databasePath);
  assert.deepEqual(adapter.packageSlots().map(({ sourceId, admitted, domainId }) => ({ sourceId, admitted, domainId })),
    [{ sourceId: 'book-tcr-v1', admitted: true, domainId: 'tcr' }]);
  assert.doesNotThrow(() => assertPackageSlotsAdmitted(adapter.packageSlots()));
});

test('a slot whose digest does not match is not admitted and fails startup', (t) => {
  const root = tempRoot(t);
  const book = writePackage(root, 'tcr', { domainId: 'tcr', digestSeed: 'book' });
  const path = writeRegistry(root, [{ sourceId: 'book-tcr-v1', manifestPath: book.rel, digestSha256: '0'.repeat(64) }]);
  const adapter = createKnowledgeAdapter(configWith(root, { TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: path }).knowledge);
  assert.equal(adapter.forPackage('book-tcr-v1').reason, 'knowledge_identity_mismatch');
  assert.equal(adapter.forPackage('book-tcr-v1').package, null);
  assert.throws(() => assertPackageSlotsAdmitted(adapter.packageSlots()), /book-tcr-v1\(knowledge_identity_mismatch\)/);

  const missing = writeRegistry(root, [{ sourceId: 'gone-v1', manifestPath: 'gone/knowledge.manifest.json', digestSha256: 'ab'.repeat(32) }], 'gone.json');
  const adapter2 = createKnowledgeAdapter(configWith(root, { TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: missing }).knowledge);
  assert.throws(() => assertPackageSlotsAdmitted(adapter2.packageSlots()), /gone-v1\(knowledge_manifest_missing\)/);
});

test('a manifest of an unknown package family is refused even with the right digest', (t) => {
  const root = tempRoot(t);
  const book = writePackage(root, 'tcr', { domainId: 'tcr', digestSeed: 'book', manifestSourceId: 'book-tcr-v1' });
  const path = writeRegistry(root, [{ sourceId: 'book-tcr-v1', manifestPath: book.rel, digestSha256: book.packageDigest }]);
  const adapter = createKnowledgeAdapter(configWith(root, { TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: path }).knowledge);
  assert.equal(adapter.forPackage('book-tcr-v1').available, false);
  assert.equal(adapter.forPackage('book-tcr-v1').reason, 'knowledge_package_manifest_invalid');
});

// ---- retrieval per slot + dispatch -----------------------------------------

function fakeRetriever(domainId, concept, entryId) {
  const asked = [];
  return {
    asked,
    adapter: {
      unavailableReason: () => null,
      contractStatus: () => 'enforced',
      dictionary: () => ({
        concepts: new Map([[concept, { canonical: concept, domainId, nUnits: 3, nLinked: 3 }]]),
        conceptsStem: new Map(),
        maxConceptLen: 2,
      }),
      forQuestion(input) {
        asked.push(input);
        const entries = [{ id: entryId, content: `${concept} fixture passage` }];
        return {
          available: true, reason: null,
          pack: {
            schema_version: 'kb_retrieval_pack_v1', pack_id: entryId, status: 'ready', confidence: 'high',
            package_version: 'v', entries,
            selected: entries.map((e) => ({ chunk_id: e.id, score: 0.9, selection_reason: 'fts' })),
            gaps: [], citations: {}, retrieval_trace: { concept_matches: [concept] },
          },
        };
      },
      forQuestionWithRewrite(input) { return Promise.resolve(this.forQuestion(input)); },
      close() {},
    },
  };
}

function twoSlotRig(t, { withBook = true } = {}) {
  const root = tempRoot(t);
  const course = writePackage(root, 'ai', { domainId: 'ai', digestSeed: 'course' });
  const book = writePackage(root, 'tcr', { domainId: 'tcr', digestSeed: 'book' });
  const env = {
    TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_MANIFEST_PATH: course.manifestPath,
    TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGE_DIGEST_SHA256: course.packageDigest,
  };
  if (withBook) {
    env.TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES = writeRegistry(root, [{
      sourceId: 'book-tcr-v1', manifestPath: book.rel, digestSha256: book.packageDigest,
      retrieval: { mode: 'lexical', linkMax: 0 },
    }]);
  }
  const config = configWith(root, env);
  const knowledge = createKnowledgeAdapter(config.knowledge);
  const courseFake = fakeRetriever('ai', 'агент', 'lesson:1');
  const bookFake = fakeRetriever('tcr', 'каста', 'passage:1');
  const slots = new Map();
  const courseRetrieval = createKnowledgeRetrieval(config.assistantRetrieval, {
    knowledge, buildRetriever: () => courseFake.adapter });
  slots.set(courseRetrieval.sourceId, courseRetrieval);
  for (const slot of config.knowledge.packages.slots) {
    slots.set(slot.sourceId, createKnowledgeRetrieval({ ...slot.retrieval, sourceId: slot.sourceId },
      { knowledge, buildRetriever: () => bookFake.adapter }));
  }
  return { slots, courseFake, bookFake, retrievals: bindRetrievalsToDomains(DEFAULT_DOMAIN_CATALOG, slots) };
}

const question = (text) => ({ text, chatId: '-1', userId: '7' });
const select = (...ids) => ({ routes: ids.map((id) => DEFAULT_DOMAIN_CATALOG.routeFor(id)), riskFlags: [], legacy: false });
const noKnowledge = { forSource: () => ({ available: false, reason: 'knowledge_identity_missing' }) };

test('domains bind to slots through their Source / Served source', (t) => {
  const { retrievals, slots } = twoSlotRig(t);
  assert.equal(retrievals.get('course-content-v1'), slots.get(COURSE), 'content and navigation are served by the course slot');
  assert.equal(retrievals.get('book-tcr-v1'), slots.get('book-tcr-v1'));
  assert.equal(slots.get('book-tcr-v1').sourceId, 'book-tcr-v1');
  assert.equal(slots.get('book-tcr-v1').domainId, 'tcr');
  assert.equal(retrievals.size, 2);
});

test('a book question goes to the book slot, a course question to the course slot', async (t) => {
  const { retrievals, courseFake, bookFake } = twoSlotRig(t);
  const book = await resolveDomainSelection(select('book'), {
    catalog: DEFAULT_DOMAIN_CATALOG, knowledge: noKnowledge, retrievals, question: question('чем каста отличается от роли') });
  assert.equal(book.knowledge.sourceId, 'book-tcr-v1');
  assert.deepEqual(book.retrievalSlots, [{ domainId: 'book', slot: 'book-tcr-v1', grounded: true, reason: null }]);
  assert.equal(book.trace.slot, 'book-tcr-v1');
  assert.equal(bookFake.asked.length, 1);
  assert.equal(bookFake.asked[0].domainId, 'tcr');
  assert.equal(courseFake.asked.length, 0);

  const course = await resolveDomainSelection(select('content'), {
    catalog: DEFAULT_DOMAIN_CATALOG, knowledge: noKnowledge, retrievals, question: question('что такое агент') });
  assert.equal(course.knowledge.sourceId, COURSE);
  assert.deepEqual(course.retrievalSlots, [{ domainId: 'content', slot: COURSE, grounded: true, reason: null }]);
  assert.equal(courseFake.asked.length, 1);
  assert.equal(courseFake.asked[0].domainId, 'ai');
  assert.equal(bookFake.asked.length, 1);
});

test('a compound question queries both slots once and merges entries with their source ids', async (t) => {
  const { retrievals, courseFake, bookFake } = twoSlotRig(t);
  const both = await resolveDomainSelection(select('book', 'content'), {
    catalog: DEFAULT_DOMAIN_CATALOG, knowledge: noKnowledge, retrievals,
    question: question('как агент поможет мне выйти из касты') });
  assert.equal(bookFake.asked.length, 1);
  assert.equal(courseFake.asked.length, 1);
  assert.deepEqual(both.retrievalSlots.map((s) => s.slot), ['book-tcr-v1', COURSE]);
  assert.deepEqual(both.knowledge.entries.map((e) => [e.sourceId, e.domainId]),
    [['book-tcr-v1', 'book'], [COURSE, 'content']]);
  assert.deepEqual(both.domainCoverage.map((c) => c.status), ['available', 'available']);
});

test('no registry = old behaviour: the course slot still serves content; book is unbound', async (t) => {
  const { retrievals, slots, courseFake } = twoSlotRig(t, { withBook: false });
  assert.equal(slots.size, 1);
  assert.equal(retrievals.size, 1);
  assert.equal(retrievals.get('course-content-v1'), slots.get(COURSE));
  const course = await resolveDomainSelection(select('navigation'), {
    catalog: DEFAULT_DOMAIN_CATALOG, knowledge: noKnowledge, retrievals, question: question('где урок про агент') });
  assert.equal(course.knowledge.sourceId, COURSE);
  assert.equal(courseFake.asked.length, 1);
  // An unbound retrieval domain without snapshot fallback keeps today's contract.
  const book = await resolveDomainSelection(select('book'), {
    catalog: DEFAULT_DOMAIN_CATALOG, knowledge: noKnowledge, retrievals, question: question('что такое каста') });
  assert.equal(book.error, 'domain_retrieval_unavailable');
});

test('hybrid slots with byte-identical model files share one lazy embedder', (t) => {
  const root = tempRoot(t);
  const a = writePackage(root, 'a', { domainId: 'a', digestSeed: 'a', withModel: true });
  const b = writePackage(root, 'b', { domainId: 'b', digestSeed: 'b', withModel: true });
  const path = writeRegistry(root, [
    { sourceId: 'base-a-v1', manifestPath: a.rel, digestSha256: a.packageDigest },
    { sourceId: 'base-b-v1', manifestPath: b.rel, digestSha256: b.packageDigest },
  ]);
  const config = configWith(root, { TELEGRAM_RUNTIME_KNOWLEDGE_PACKAGES: path });
  const knowledge = createKnowledgeAdapter(config.knowledge);
  let built = 0;
  const embedderCache = new Map();
  const layers = config.knowledge.packages.slots.map((slot) => createKnowledgeRetrieval(
    { ...slot.retrieval, sourceId: slot.sourceId },
    { knowledge, embedderCache, log: () => {},
      buildEmbedder: () => { built += 1; return { embedOne: async () => new Float32Array(384) }; },
      buildRetriever: () => fakeRetriever('x', 'x', 'x').adapter },
  ));
  assert.equal(built, 1);
  assert.deepEqual(layers.map((l) => l.embedderShared), [false, true]);
  assert.deepEqual(layers.map((l) => l.sourceId), ['base-a-v1', 'base-b-v1']);
});

test('a compound answer over the merge budget keeps an equal share of the best entries of every base', async () => {
  const big = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}:${i}`, content: 'x'.repeat(2_000) }));
  const slot = (sourceId, entries) => ({ available: true, sourceId, async forQuestion() {
    return { grounded: true, reason: null, knowledge: { sourceId, entries }, trace: { slot: sourceId } };
  } });
  const retrievals = bindRetrievalsToDomains(DEFAULT_DOMAIN_CATALOG, new Map([
    [COURSE, slot(COURSE, big('lesson', 20))], ['book-tcr-v1', slot('book-tcr-v1', big('passage', 20))]]));
  const merged = await resolveDomainSelection(select('book', 'content'), {
    catalog: DEFAULT_DOMAIN_CATALOG, knowledge: noKnowledge, retrievals, question: question('compound') });
  const chars = merged.knowledge.entries.reduce((n, e) => n + e.content.length, 0);
  assert.ok(chars <= MERGED_KNOWLEDGE_MAX_CHARS, `${chars} chars within budget`);
  const bySource = (id) => merged.knowledge.entries.filter((e) => e.sourceId === id).map((e) => e.id);
  assert.deepEqual(bySource('book-tcr-v1'), Array.from({ length: 10 }, (_, i) => `book-tcr-v1:passage:${i}`));
  assert.deepEqual(bySource(COURSE), Array.from({ length: 10 }, (_, i) => `${COURSE}:lesson:${i}`));

  // Under the budget nothing is dropped.
  const small = bindRetrievalsToDomains(DEFAULT_DOMAIN_CATALOG, new Map([
    [COURSE, slot(COURSE, big('lesson', 3))], ['book-tcr-v1', slot('book-tcr-v1', big('passage', 3))]]));
  const whole = await resolveDomainSelection(select('book', 'content'), {
    catalog: DEFAULT_DOMAIN_CATALOG, knowledge: noKnowledge, retrievals: small, question: question('compound') });
  assert.equal(whole.knowledge.entries.length, 6);
});
