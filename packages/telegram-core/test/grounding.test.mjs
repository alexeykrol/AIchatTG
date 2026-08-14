import assert from 'node:assert/strict';
import test from 'node:test';
import { GROUNDING_REASONS, groundingFromPack } from '../src/grounding.mjs';

function pack({ entries, citations = {}, status = 'ready' } = {}) {
  return { status, entries, citations, selected: entries.map((e) => ({ chunk_id: e.id })) };
}

function entries(count, { size = 40 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `lesson:1:a:${String(index).padStart(3, '0')}`,
    content: 'т'.repeat(size),
  }));
}

test('a grounded pack becomes provider entries carrying the lesson title and link', () => {
  const result = groundingFromPack(pack({
    entries: [{ id: 'lesson:9:a:001', content: 'текст урока' }],
    citations: {
      'lesson:9:a:001': {
        unitId: 'lesson:9', title: 'Урок про агентов',
        canonicalUrl: 'https://alexeykrol.com/courses/ai_full/lessons/9/',
      },
    },
  }), { sourceId: 'course-knowledge-v2' });

  assert.equal(result.grounded, true);
  assert.equal(result.knowledge.sourceId, 'course-knowledge-v2');
  assert.deepEqual(result.knowledge.entries[0], {
    id: 'lesson:9:a:001',
    content: 'текст урока',
    title: 'Урок про агентов',
    canonicalUrl: 'https://alexeykrol.com/courses/ai_full/lessons/9/',
  });
});

test('an entry without a citation still reaches the model, just without a link', () => {
  const result = groundingFromPack(pack({ entries: [{ id: 'lesson:9:a:001', content: 'текст' }] }),
    { sourceId: 'course-knowledge-v2' });
  assert.deepEqual(result.knowledge.entries[0], { id: 'lesson:9:a:001', content: 'текст' });
});

test('only an absolute https link may be published to a reader', () => {
  const result = groundingFromPack(pack({
    entries: [{ id: 'a:b:001', content: 'x' }, { id: 'c:d:001', content: 'y' }],
    citations: {
      'a:b:001': { title: 'Урок', canonicalUrl: 'http://insecure.example/lesson' },
      'c:d:001': { title: 'Другой', canonicalUrl: '/relative/path' },
    },
  }), { sourceId: 's' });
  assert.equal(result.knowledge.entries[0].canonicalUrl, undefined);
  assert.equal(result.knowledge.entries[1].canonicalUrl, undefined);
  assert.equal(result.knowledge.entries[0].title, 'Урок');
});

test('a not_found pack yields no grounding and says so as an abstention reason', () => {
  const result = groundingFromPack(pack({ entries: [], status: 'not_found' }), { sourceId: 's' });
  assert.equal(result.grounded, false);
  assert.equal(result.reason, GROUNDING_REASONS.NOT_FOUND);
  assert.equal(result.knowledge, null);
});

test('a missing or malformed pack is a defect reason, not an abstention', () => {
  assert.equal(groundingFromPack(null, { sourceId: 's' }).reason, GROUNDING_REASONS.PACK_MISSING);
  assert.equal(groundingFromPack({ status: 'ready' }, { sourceId: 's' }).reason, GROUNDING_REASONS.PACK_MISSING);
});

test('the entry cap truncates deterministically in relevance order and records it', () => {
  const result = groundingFromPack(pack({ entries: entries(10) }), { sourceId: 's', maxEntries: 4 });
  assert.equal(result.knowledge.entries.length, 4);
  assert.deepEqual(
    result.knowledge.entries.map((e) => e.id),
    entries(10).slice(0, 4).map((e) => e.id),
    'the survivors are the highest ranked entries, in pack order',
  );
  assert.equal(result.trace.droppedByEntryCap, 6);
  assert.equal(result.trace.used, 4);
  assert.equal(result.trace.offered, 10);
});

test('the provider entry ceiling holds even when a caller asks for more', () => {
  const result = groundingFromPack(pack({ entries: entries(200, { size: 5 }) }),
    { sourceId: 's', maxEntries: 999, maxChars: 600_000, charReserve: 0 });
  assert.equal(result.knowledge.entries.length, 128);
  assert.equal(result.trace.droppedByEntryCap, 72);
});

test('the character cap is measured on the serialized entry and is visible in the trace', () => {
  const result = groundingFromPack(pack({ entries: entries(10, { size: 100 }) }),
    { sourceId: 's', maxEntries: 10, maxChars: 700, charReserve: 0 });
  assert.ok(result.knowledge.entries.length < 10, 'the cap actually bit');
  assert.ok(result.trace.chars <= 700);
  assert.equal(result.trace.droppedByCharCap, 10 - result.knowledge.entries.length);
  assert.equal(result.trace.used + result.trace.droppedByCharCap, 10);
});

test('one oversized chunk does not discard the shorter entries ranked behind it', () => {
  const result = groundingFromPack(pack({
    entries: [
      { id: 'a:b:001', content: 'т'.repeat(5_000) },
      { id: 'a:b:002', content: 'короткий, но релевантный' },
    ],
  }), { sourceId: 's', maxEntries: 10, maxChars: 1_000, charReserve: 0 });
  assert.deepEqual(result.knowledge.entries.map((e) => e.id), ['a:b:002']);
  assert.equal(result.trace.droppedByCharCap, 1);
});

test('a budget too small for a single entry is reported, never sent as empty knowledge', () => {
  const result = groundingFromPack(pack({ entries: entries(3, { size: 500 }) }),
    { sourceId: 's', maxChars: 50, charReserve: 0 });
  assert.equal(result.grounded, false);
  assert.equal(result.reason, GROUNDING_REASONS.EMPTY);
  assert.equal(result.knowledge, null);
});

test('the same pack always projects to the same input', () => {
  const built = pack({ entries: entries(30, { size: 60 }) });
  const first = groundingFromPack(built, { sourceId: 's', maxEntries: 8 });
  const second = groundingFromPack(built, { sourceId: 's', maxEntries: 8 });
  assert.deepEqual(first.knowledge, second.knowledge);
  assert.deepEqual(first.trace, second.trace);
});
