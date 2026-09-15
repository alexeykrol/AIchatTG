import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDomainCandidateStore, DomainCandidateError } from '../src/domain-candidates.mjs';
import { DEFAULT_DOMAIN_INDEX } from '../../telegram-runtime/src/assistant-domains.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aichattg-domain-candidates-'));
  return createDomainCandidateStore({ candidateRoot: join(root, 'bundles') });
}

test('Markdown editor offers only the locally bound answer bases', () => {
  const store = fixture();
  const domains = store.list().domains;
  assert.deepEqual(domains.filter((domain) => domain.editable).map((domain) => domain.id),
    ['assistant-self', 'abuse']);
  assert.equal(domains.find((domain) => domain.id === 'content').sourceKind, 'retrieval');
});

test('saving a Markdown edit creates a validated immutable bundle and leaves released files unchanged', () => {
  const store = fixture();
  const before = store.read('assistant-self');
  const releasedFile = join(DEFAULT_DOMAIN_INDEX.slice(0, DEFAULT_DOMAIN_INDEX.lastIndexOf('/')),
    before.knowledgeFile);
  const releasedBytes = readFileSync(releasedFile);
  const first = store.save('assistant-self', {
    text: `${before.releasedText}\nПроверяемая локальная версия.\n`, baseDigest: before.baseDigest,
  });
  assert.equal(first.state, 'prepared');
  assert.equal(first.runtimeApplied, false);
  assert.deepEqual(readFileSync(releasedFile), releasedBytes);
  const after = store.read('assistant-self');
  assert.equal(after.candidateDigest, first.candidateDigest);
  assert.match(after.candidateText, /Проверяемая локальная версия/u);
  assert.equal(store.read('abuse').candidateText, store.read('abuse').releasedText);
  assert.throws(() => store.save('assistant-self', {
    text: `${before.releasedText}\nУстаревшее сохранение.\n`, baseDigest: before.baseDigest,
  }), (error) => error instanceof DomainCandidateError && error.code === 'candidate_stale');
  const second = store.save('abuse', {
    text: `${store.read('abuse').candidateText}\nСледующая версия.\n`,
    baseDigest: store.read('abuse').baseDigest,
  });
  assert.notEqual(second.candidateDigest, first.candidateDigest);
  assert.match(store.read('assistant-self').candidateText, /Проверяемая локальная версия/u);
});

test('malformed Markdown is rejected before a candidate bundle is committed', () => {
  const store = fixture();
  const baseDigest = store.read('assistant-self').baseDigest;
  assert.throws(() => store.save('assistant-self', { text: 'No Markdown heading', baseDigest }),
    (error) => error instanceof DomainCandidateError && error.code === 'markdown_invalid');
  assert.equal(store.read('assistant-self').candidateDigest, null);
});
