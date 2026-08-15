import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ASSISTANT_SOURCE_PACKAGES } from '@aichattg/telegram-core';
import { createValueSliceKnowledge, withValueSlice } from '../src/value-slice.mjs';

// Настоящий файл делается параллельно в лаборатории и может ещё не существовать:
// контрактные тесты идут по фикстурам, а тест против реального файла — со skip.
const VALUE_SLICE_PATH = process.env.AICHATTG_VALUE_SLICE_PATH
  || '/Users/alexeykrolmini/Code/allcourses/code/data/knowledge/value/value_slice.json';

function writeSlice(situations, extra = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-value-slice-'));
  const path = join(folder, 'value_slice.json');
  writeFileSync(path, JSON.stringify({
    schema: 'value_slice.v1', fetched_at: '2026-08-14T00:00:00+00:00', situations, ...extra,
  }), 'utf8');
  return { folder, path };
}

test('a value entry carries its answer text, its course links and a citable source url', () => {
  const { folder, path } = writeSlice([{
    id: 'зачем-руководителю-1', title: 'Зачем это руководителю?', kind: 'value',
    question_forms: ['Зачем мне это как руководителю?'],
    answer_text: 'Чтобы отличать реальную работу от лапши, нужен минимальный трек: модуль 1 и модуль 2.',
    links: ['https://alexeykrol.com/courses/ai_intro/'], source_file: 'value/зачем-руководителю.md',
  }]);
  try {
    const admitted = createValueSliceKnowledge(path);
    assert.equal(admitted.available, true);
    assert.equal(admitted.snapshot.sourceId, ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE);
    const [entry] = admitted.snapshot.entries;
    assert.equal(entry.kind, 'value');
    assert.match(entry.content, /минимальный трек/u);
    // Ссылка на страницу курса дописана в запись: модель цитирует только то,
    // что снимок ей показал, и без этой строки вести читателя было бы некуда.
    assert.match(entry.content, /https:\/\/alexeykrol\.com\/courses\/ai_intro\//u);
    assert.equal(entry.canonicalUrl, 'https://alexeykrol.com/courses/ai_intro/');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a foreign kind or malformed slice is refused with a reason instead of an empty snapshot', () => {
  const { folder, path } = writeSlice([
    { id: 'org-запись', title: 'Процедура', kind: 'procedure', answer_text: 'Шаг первый.' },
    { id: 'ок', title: 'Польза', kind: 'value', answer_text: 'Честный минимальный трек.' },
  ]);
  try {
    // Запись чужого kind (орг-срез в чужом файле) отброшена, а не переосмыслена.
    assert.deepEqual(createValueSliceKnowledge(path).snapshot.entries.map((entry) => entry.id), ['ок']);
    const { folder: badFolder, path: badPath } = writeSlice([], { schema: 'org_slice.v1' });
    try {
      assert.equal(createValueSliceKnowledge(badPath).reason, 'value_slice_schema_invalid');
    } finally { rmSync(badFolder, { recursive: true, force: true }); }
    assert.equal(createValueSliceKnowledge(join(folder, 'nope.json')).reason, 'value_slice_missing');
    assert.equal(createValueSliceKnowledge('').reason, 'value_slice_missing');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('an all-dropped slice is unavailable rather than an admitted empty snapshot', () => {
  const { folder, path } = writeSlice([{ id: 'пусто', kind: 'value', answer_text: '' }]);
  try {
    assert.equal(createValueSliceKnowledge(path).reason, 'value_slice_empty');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Живой прогон ent-01: срез в 64.5k знаков превышал лимит входа провайдера
// (60k), boundedJson молча давал null и клиент получал пустой ответ. Класс
// ошибки закрыт на входе: негабаритный срез не допускается вовсе.
test('an oversized slice is refused loudly instead of silently emptying the model request', () => {
  const { folder, path } = writeSlice([{
    id: 'гигант', kind: 'value', answer_text: 'х'.repeat(51_000),
    links: ['https://alexeykrol.com/courses/ai_full/'],
  }]);
  try {
    assert.equal(createValueSliceKnowledge(path).reason, 'value_slice_too_large');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the value slice replaces only the value source, never operations or content', () => {
  const { folder, path } = writeSlice([{
    id: 'v1', title: 'Польза', kind: 'value', answer_text: 'Минимальный трек.',
    links: ['https://alexeykrol.com/courses/'],
  }]);
  try {
    const base = {
      forSource(sourceId) { return { available: true, reason: null, snapshot: { sourceId, entries: [] } }; },
      forPackage() { return { available: true, reason: null, package: { sourceId: 'course-knowledge-v2' } }; },
    };
    const merged = withValueSlice(base, createValueSliceKnowledge(path));
    assert.equal(merged.forSource(ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE).snapshot.entries.length, 1);
    assert.equal(merged.forSource(ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS).snapshot.entries.length, 0);
    assert.equal(merged.forSource(ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT).snapshot.entries.length, 0);
    assert.equal(merged.forPackage(ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE).package.sourceId, 'course-knowledge-v2');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Проверка против настоящего среза, когда он появится: файла нет — тест говорит
// об этом вслух, а не зеленеет молча.
test('the real value slice loads and every entry keeps a course link to cite', (t) => {
  if (!existsSync(VALUE_SLICE_PATH)) {
    t.skip(`value slice is not available at ${VALUE_SLICE_PATH}`);
    return;
  }
  const admitted = createValueSliceKnowledge(VALUE_SLICE_PATH);
  assert.equal(admitted.available, true, admitted.reason || '');
  for (const entry of admitted.snapshot.entries) {
    assert.equal(entry.kind, 'value', entry.id);
    assert.ok(entry.content.length > 0, entry.id);
  }
});
