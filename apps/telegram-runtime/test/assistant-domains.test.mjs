import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DOMAIN_CATALOG, DEFAULT_DOMAIN_INDEX, DomainCatalogError, loadDomainCatalog,
} from '../src/assistant-domains.mjs';

function block(id, { source = `${id}-v1`, kind = 'markdown', action, path = `${id}.md` } = {}) {
  return `## ${id}\n### Title\nDomain ${id}\n### Description\nDescribed ${id}\n`
    + '### Includes\nIts own subject\n### Excludes\nOther subjects\n'
    + `### Examples\n- Explain ${id}\n### Negative examples\n- Unrelated question\n`
    + '### Capability\nExplain the admitted subject\n'
    + (action === undefined ? '' : `### Action\n${action}\n`)
    + `### Source\n${source}\n### Source kind\n${kind}\n`
    + (kind === 'markdown' ? `### Knowledge\n${path}\n` : '')
    + '### Answer policy\nUse supplied evidence only.\n';
}

function fixture(t, blocks = [block('arbitrary')]) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-domains-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const indexPath = join(root, 'INDEX.md');
  const writeIndex = (value) => writeFileSync(indexPath, value);
  const write = (name, value = '# Test knowledge\n\nA grounded test fact.\n') => writeFileSync(join(root, name), value);
  writeIndex(`# Assistant domain registry\n\n${blocks.join('\n')}`);
  write('arbitrary.md');
  return { root, indexPath, write, writeIndex, load: () => loadDomainCatalog({ indexPath }) };
}

function errorCode(code) {
  return (error) => error instanceof DomainCatalogError && error.code === code;
}

test('default registry preserves existing admitted pair bindings and public-only local sources', () => {
  const catalog = DEFAULT_DOMAIN_CATALOG;
  const pairs = {
    content: ['teach', 'course-content-v1', 'retrieval'],
    navigation: ['navigate', 'course-content-v1', 'retrieval'],
    operations: ['support', 'course-operations-v1', 'snapshot'],
    value: ['advise', 'course-value-v1', 'snapshot'],
    'assistant-self': ['self', 'assistant-self-v1', 'markdown'],
    abuse: ['abuse', 'assistant-abuse-v1', 'markdown'],
  };
  for (const [id, [action, sourceId, kind]] of Object.entries(pairs)) {
    assert.deepEqual(catalog.routeFor(id), { domainId: id, action, sourceId });
    assert.equal(catalog.get(id).sourceKind, kind);
  }
  assert.match(DEFAULT_DOMAIN_INDEX, /src\/domains\/INDEX\.md$/);
  assert.ok(readFileSync(DEFAULT_DOMAIN_INDEX, 'utf8').length <= 25_000);
  assert.match(catalog.get('operations').answerPolicy, /must never state, quote, estimate/);
  assert.match(catalog.get('value').answerPolicy, /Never validate the premise/);
  assert.match(catalog.get('content').answerPolicy, /exact canonicalUrl/);
  assert.equal(catalog.get('content').servedSourceId, 'course-knowledge-v2');
  assert.equal(catalog.get('navigation').servedSourceId, 'course-knowledge-v2');
  assert.equal(catalog.get('operations').servedSourceId, 'course-operations-v1');
  assert.match(catalog.markdownKnowledge('assistant-self').entries[0].content, /не Алексей Крол/);
  assert.match(catalog.markdownKnowledge('assistant-self').entries[0].content, /Причина.*не указана/);
  assert.match(catalog.markdownKnowledge('assistant-self').entries[0].content, /Общие вопросы.*правилах/);
  assert.match(catalog.markdownKnowledge('abuse').entries[0].content, /не предоставляет разрешения на санкции/);
});

test('arbitrary seventh domain needs only registry and knowledge files; existing domains remain usable', (t) => {
  const f = fixture(t);
  const original = readFileSync(DEFAULT_DOMAIN_INDEX, 'utf8');
  f.writeIndex(`${original}\n${block('new-unrelated-domain')}`);
  for (const domain of DEFAULT_DOMAIN_CATALOG.domains.filter((d) => d.sourceKind === 'markdown')) {
    f.write(domain.knowledgePath, readFileSync(new URL(`../src/domains/${domain.knowledgePath}`, import.meta.url), 'utf8'));
  }
  f.write('new-unrelated-domain.md', '# New subject\n\nThis statement exists only in the new subject.\n');
  const catalog = f.load();
  assert.equal(catalog.domains.length, 7);
  assert.deepEqual(catalog.routeFor('new-unrelated-domain'), {
    domainId: 'new-unrelated-domain', action: 'new-unrelated-domain', sourceId: 'new-unrelated-domain-v1',
  });
  assert.match(catalog.markdownKnowledge('new-unrelated-domain').entries[0].content, /only in the new subject/);
  for (const domain of DEFAULT_DOMAIN_CATALOG.domains) {
    assert.deepEqual(catalog.routeFor(domain.id), DEFAULT_DOMAIN_CATALOG.routeFor(domain.id));
  }
});

test('all IDs and domain counts derive from files, including arbitrary renaming', (t) => {
  const names = Array.from({ length: 9 }, (_, index) => `rename-${index}`);
  const f = fixture(t, names.map((name) => block(name)));
  for (const name of names) f.write(`${name}.md`);
  const catalog = f.load();
  assert.deepEqual(catalog.domains.map((d) => d.id), names);
  assert.equal(catalog.get('content'), null);
  for (const id of names) assert.equal(catalog.normalizeRoute({ domainId: id }).action, id);
});

test('normalizeRoute validates modern, legacy and redirect routes without contradictory fallback', () => {
  const c = DEFAULT_DOMAIN_CATALOG;
  assert.deepEqual(c.normalizeRoute({ domainId: 'content' }), c.routeFor('content'));
  assert.deepEqual(c.normalizeRoute({ action: 'teach', sourceId: 'course-content-v1' }), c.routeFor('content'));
  assert.deepEqual(c.normalizeRoute({ domainId: 'content', action: 'teach' }), c.routeFor('content'));
  const redirect = { domainId: null, action: 'redirect', sourceId: null };
  assert.deepEqual(c.normalizeRoute({ domainId: null }), redirect);
  assert.deepEqual(c.normalizeRoute({ action: 'redirect', sourceId: null }), redirect);
  assert.deepEqual(c.normalizeRoute(redirect), redirect);
  for (const value of [null, [], 'content', {}, { domainId: 'unknown' },
    { domainId: 'unknown', action: 'teach', sourceId: 'course-content-v1' },
    { domainId: 'content', action: 'support', sourceId: 'course-content-v1' },
    { domainId: 'content', action: 'teach', sourceId: 'course-operations-v1' },
    { domainId: 'content', sourceId: null }, { domainId: undefined },
    { action: 'teach' }, { sourceId: 'course-content-v1' }, { action: 'redirect' },
    { domainId: null, action: 'teach' }, { domainId: null, sourceId: 'course-content-v1' },
    { domainId: 'content', action: 'redirect', sourceId: null }]) {
    assert.equal(c.normalizeRoute(value), null, JSON.stringify(value));
  }
  assert.equal(c.routeFor('unknown'), null);
});

test('shared action with distinct sources is legal but duplicate route pairs are not', (t) => {
  const f = fixture(t, [block('alpha', { action: 'answer', kind: 'snapshot' }), block('beta', { action: 'answer', kind: 'snapshot' })]);
  const catalog = f.load();
  assert.equal(catalog.normalizeRoute({ action: 'answer', sourceId: 'beta-v1' }).domainId, 'beta');
  f.writeIndex(`# Assistant domain registry\n${block('alpha', { source: 'same', action: 'answer', kind: 'snapshot' })}\n${block('beta', { source: 'same', action: 'answer', kind: 'snapshot' })}`);
  assert.throws(f.load, errorCode('route_pair_duplicate'));
});

test('catalog, descriptors, examples and preloaded Markdown evidence are immutable', (t) => {
  const f = fixture(t);
  const c = f.load();
  const material = c.markdownKnowledge('arbitrary');
  assert.throws(() => { c.digest = 'different'; }, TypeError);
  assert.throws(() => c.domains.push({}), TypeError);
  assert.throws(() => { c.get('arbitrary').title = 'different'; }, TypeError);
  assert.throws(() => c.get('arbitrary').examples.push('different'), TypeError);
  assert.throws(() => { material.entries[0].content = 'different'; }, TypeError);
  f.write('arbitrary.md', '# Changed\n\nChanged after admission.\n');
  assert.equal(c.markdownKnowledge('arbitrary'), material);
  assert.doesNotMatch(material.entries[0].content, /Changed/);
  assert.notEqual(c.digest, f.load().digest);
  assert.throws(() => c.markdownKnowledge('unknown'), errorCode('domain_unknown'));
  assert.throws(() => DEFAULT_DOMAIN_CATALOG.markdownKnowledge('content'), errorCode('domain_knowledge_not_markdown'));
});

test('registry digest is repeatable and includes knowledge content', (t) => {
  const f = fixture(t);
  const digest = f.load().digest;
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(f.load().digest, digest);
  f.write('arbitrary.md', '# Same title\n\nDifferent fact.\n');
  assert.notEqual(f.load().digest, digest);
});

test('empty, duplicate, malformed and incomplete catalogs fail closed', (t) => {
  const f = fixture(t);
  const cases = [
    ['', 'index_heading_invalid'],
    ['# Assistant domain registry\n', 'registry_empty'],
    [`# Assistant domain registry\n${block('arbitrary')}\n${block('arbitrary')}`, 'domain_duplicate'],
    [`# Assistant domain registry\n${block('../bad')}`, 'domain_id_invalid'],
    [`# Assistant domain registry\n${block('redirect')}`, 'domain_id_invalid'],
    [`# Assistant domain registry\n${block('arbitrary').replace('### Title', '### Unknown')}`, 'field_unknown'],
    [`# Assistant domain registry\n${block('arbitrary')}\n### Title\nTwice`, 'field_duplicate'],
    [`# Assistant domain registry\n${block('arbitrary').replace('### Title\nDomain arbitrary\n', '')}`, 'field_required'],
    [`# Assistant domain registry\n${block('arbitrary').replace('- Explain arbitrary', 'Explain arbitrary')}`, 'examples_invalid'],
    [`# Assistant domain registry\n${block('arbitrary').replace('### Source kind\nmarkdown', '### Source kind\nremote')}`, 'source_kind_invalid'],
    [`# Assistant domain registry\n${block('arbitrary').replace('### Knowledge\narbitrary.md\n', '')}`, 'knowledge_binding_invalid'],
    [`# Assistant domain registry\n${block('arbitrary').replace('Domain arbitrary', 'Domain arbitrary\nMultiline')}`, 'scalar_invalid'],
  ];
  for (const [text, code] of cases) {
    f.writeIndex(text);
    assert.throws(f.load, errorCode(code), code);
  }
});

test('missing configured Markdown knowledge fails catalog startup instead of becoming outside-scope', (t) => {
  const f = fixture(t, [block('absent')]);
  assert.throws(f.load, errorCode('knowledge_unavailable'));
});

test('source identity cannot silently select different source kinds or Markdown files', (t) => {
  const f = fixture(t, [block('alpha', { source: 'same', kind: 'snapshot' }), block('beta', { source: 'same', kind: 'retrieval' })]);
  assert.throws(f.load, errorCode('source_binding_conflict'));
  f.write('alpha.md');
  f.write('beta.md');
  f.writeIndex(`# Assistant domain registry\n${block('alpha', { source: 'same' })}\n${block('beta', { source: 'same' })}`);
  assert.throws(f.load, errorCode('source_binding_conflict'));
});

test('served source aliases are explicit safe retrieval-only data and do not rewrite routing', (t) => {
  const f = fixture(t, [block('arbitrary', { kind: 'retrieval' }) + '\n### Served source\nalternate-v2\n']);
  const catalog = f.load();
  assert.equal(catalog.get('arbitrary').servedSourceId, 'alternate-v2');
  assert.equal(catalog.routeFor('arbitrary').sourceId, 'arbitrary-v1');
  assert.equal(catalog.normalizeRoute({ action: 'arbitrary', sourceId: 'alternate-v2' }), null);
  for (const kind of ['markdown', 'snapshot']) {
    f.writeIndex(`# Assistant domain registry\n${block('arbitrary', { kind })}\n### Served source\nalternate-v2\n`);
    assert.throws(f.load, errorCode('served_source_invalid'));
  }
  f.writeIndex(`# Assistant domain registry\n${block('arbitrary', { kind: 'retrieval' })}\n### Served source\n../unsafe\n`);
  assert.throws(f.load, errorCode('served_source_invalid'));
  f.writeIndex(`# Assistant domain registry\n${block('alpha', { kind: 'retrieval', source: 'same' })}\n### Served source\none-v2\n${block('beta', { kind: 'retrieval', source: 'same' })}\n### Served source\ntwo-v2\n`);
  assert.throws(f.load, errorCode('source_binding_conflict'));
});

test('absolute paths, traversal and directory symlinks are rejected before reading knowledge', (t) => {
  const f = fixture(t);
  for (const path of ['/tmp/outside.md', '../outside.md', 'sub/../../outside.md', './arbitrary.md', 'a\\b.md', 'https://example.com/file.md']) {
    f.writeIndex(`# Assistant domain registry\n${block('arbitrary', { path })}`);
    assert.throws(f.load, errorCode('knowledge_path_invalid'), path);
  }
  symlinkSync(join(f.root, 'arbitrary.md'), join(f.root, 'linked.md'));
  f.writeIndex(`# Assistant domain registry\n${block('arbitrary', { path: 'linked.md' })}`);
  assert.throws(f.load, errorCode('knowledge_symlink'));
  mkdirSync(join(f.root, 'sub'));
  symlinkSync(join(f.root, 'sub'), join(f.root, 'linked-directory'));
  f.writeIndex(`# Assistant domain registry\n${block('arbitrary', { path: 'linked-directory/inside.md' })}`);
  assert.throws(f.load, errorCode('knowledge_symlink'));
});

test('regular contained nested Markdown is supported without source imports', (t) => {
  const f = fixture(t, [block('arbitrary', { path: 'nested/source.md' })]);
  mkdirSync(join(f.root, 'nested'));
  f.write('nested/source.md', '# Nested\n\nNested local evidence.\n');
  assert.match(f.load().markdownKnowledge('arbitrary').entries[0].content, /Nested local evidence/);
});

test('catalog index itself must be a regular readable bounded file', (t) => {
  const f = fixture(t);
  const linked = join(f.root, 'linked-index.md');
  symlinkSync(f.indexPath, linked);
  assert.throws(() => loadDomainCatalog({ indexPath: linked }), errorCode('index_not_regular'));
  assert.throws(() => loadDomainCatalog({ indexPath: f.root }), errorCode('index_not_regular'));
  assert.throws(() => loadDomainCatalog({ indexPath: join(f.root, 'missing.md') }), errorCode('index_unavailable'));
  assert.throws(() => loadDomainCatalog({ indexPath: '' }), errorCode('index_path_invalid'));
  f.writeIndex(`# Assistant domain registry\n${'x'.repeat(25_000)}`);
  assert.throws(f.load, errorCode('index_too_large'));
});

test('knowledge must be nonempty, valid UTF-8 and bounded in characters and bytes', (t) => {
  const f = fixture(t);
  for (const text of ['', '# Title\n\n', 'No title\nBody']) {
    f.write('arbitrary.md', text);
    assert.throws(f.load, errorCode('knowledge_empty_or_malformed'));
  }
  f.write('arbitrary.md', '# Title\n\n' + 'x'.repeat(16_000));
  assert.throws(f.load, errorCode('knowledge_too_large'));
  f.write('arbitrary.md', '# Title\n\n' + 'я'.repeat(16_000));
  assert.throws(f.load, errorCode('knowledge_too_large'));
  f.write('arbitrary.md', Buffer.from([0xff, 0xfe]));
  assert.throws(f.load, errorCode('knowledge_encoding_invalid'));
  f.write('arbitrary.md', '# Title\n\nBad\0content');
  assert.throws(f.load, errorCode('knowledge_invalid'));
});
