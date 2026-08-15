import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ASSISTANT_SOURCE_PACKAGES } from '@aichattg/telegram-core';
import { createOrgSliceKnowledge, withOrgSlice } from '../src/org-slice.mjs';

const ORG_SLICE_PATH = process.env.AICHATTG_ORG_SLICE_PATH
  || '/Users/alexeykrolmini/Code/allcourses/code/data/knowledge/org/org_slice.json';

const REFERRAL = 'Это вопрос об условиях — их формулирует сайт, а не ассистент.'
  + ' Актуальные условия смотрите на странице: https://alexeykrol.com/offer_1-2/';

function writeSlice(situations, extra = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-org-slice-'));
  const path = join(folder, 'org_slice.json');
  writeFileSync(path, JSON.stringify({
    schema: 'org_slice.v1', fetched_at: '2026-08-15T04:06:44+00:00', situations, ...extra,
  }), 'utf8');
  return { folder, path };
}

test('a procedure entry carries its step text and a citable source url', () => {
  const { folder, path } = writeSlice([{
    id: 'как-залогиниться-1', title: 'Как залогиниться?', kind: 'procedure',
    answer_text: 'Откройте страницу входа и введите email, указанный при оплате.',
    links: ['https://alexeykrol.com/contact/'], source_url: 'https://alexeykrol.com/contact/',
  }]);
  try {
    const admitted = createOrgSliceKnowledge(path);
    assert.equal(admitted.available, true);
    assert.equal(admitted.snapshot.sourceId, ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS);
    const [entry] = admitted.snapshot.entries;
    assert.equal(entry.kind, 'procedure');
    assert.match(entry.content, /Откройте страницу входа/u);
    assert.equal(entry.canonicalUrl, 'https://alexeykrol.com/contact/');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a condition entry stays a referral and gains its links, never a restated term', () => {
  const { folder, path } = writeSlice([{
    id: 'tariffs-and-prices', title: 'Сколько стоит', kind: 'condition',
    answer_text: REFERRAL,
    links: ['https://alexeykrol.com/offer_1-2/', 'https://alexeykrol.com/contact/'],
    source_url: 'https://alexeykrol.com/offer_1-2/',
  }]);
  try {
    const [entry] = createOrgSliceKnowledge(path).snapshot.entries;
    assert.equal(entry.kind, 'condition');
    assert.match(entry.content, /их формулирует сайт/u);
    assert.match(entry.content, /https:\/\/alexeykrol\.com\/offer_1-2\//u);
    assert.match(entry.content, /https:\/\/alexeykrol\.com\/contact\//u);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Решение владельца: бот не пересказывает условия. Запись условия с суммой,
// процентом или сроком — дефект среза, и до модели она не доходит.
test('a condition entry carrying a figure is dropped rather than passed on', () => {
  const { folder, path } = writeSlice([
    {
      id: 'refund-window', title: 'Возврат', kind: 'condition',
      answer_text: 'Вернуть деньги можно в течение 14 дней, скидка 30% не возвращается.',
      links: ['https://alexeykrol.com/offer_1-2/'], source_url: 'https://alexeykrol.com/offer_1-2/',
    },
    {
      id: 'ok-referral', title: 'Тарифы', kind: 'condition', answer_text: REFERRAL,
      links: ['https://alexeykrol.com/offer_1-2/'], source_url: 'https://alexeykrol.com/offer_1-2/',
    },
  ]);
  try {
    const entries = createOrgSliceKnowledge(path).snapshot.entries;
    assert.deepEqual(entries.map((entry) => entry.id), ['ok-referral']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a foreign or malformed slice is refused with a reason instead of an empty snapshot', () => {
  const { folder, path } = writeSlice([], { schema: 'something-else' });
  try {
    assert.equal(createOrgSliceKnowledge(path).reason, 'org_slice_schema_invalid');
    assert.equal(createOrgSliceKnowledge(join(folder, 'nope.json')).reason, 'org_slice_missing');
    assert.equal(createOrgSliceKnowledge('').reason, 'org_slice_missing');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the org slice replaces only the operations source, never the content package', () => {
  const { folder, path } = writeSlice([{
    id: 'p1', title: 'Процедура', kind: 'procedure', answer_text: 'Шаг первый.',
    links: [], source_url: 'https://alexeykrol.com/contact/',
  }]);
  try {
    const base = {
      forSource(sourceId) { return { available: true, reason: null, snapshot: { sourceId, entries: [] } }; },
      forPackage() { return { available: true, reason: null, package: { sourceId: 'course-knowledge-v2' } }; },
    };
    const merged = withOrgSlice(base, createOrgSliceKnowledge(path));
    assert.equal(merged.forSource(ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS).snapshot.entries.length, 1);
    assert.equal(merged.forSource(ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT).snapshot.entries.length, 0);
    assert.equal(merged.forPackage(ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE).package.sourceId, 'course-knowledge-v2');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Проверка против настоящего среза: инвариант должен держаться на боевых данных,
// а не только на выдуманных. Файла нет — тест говорит об этом вслух.
test('the real org slice loads and no admitted condition restates a term', (t) => {
  if (!existsSync(ORG_SLICE_PATH)) {
    t.skip(`org slice is not available at ${ORG_SLICE_PATH}`);
    return;
  }
  const admitted = createOrgSliceKnowledge(ORG_SLICE_PATH);
  assert.equal(admitted.available, true, admitted.reason || '');
  const entries = admitted.snapshot.entries;
  const procedures = entries.filter((entry) => entry.kind === 'procedure');
  const conditions = entries.filter((entry) => entry.kind === 'condition');
  assert.ok(procedures.length >= 30, `procedures: ${procedures.length}`);
  assert.ok(conditions.length >= 1, `conditions: ${conditions.length}`);
  for (const entry of procedures) assert.ok(entry.content.length > 0, entry.id);
  for (const entry of conditions) {
    const withoutLinks = entry.content.replace(/https?:\/\/\S+/gu, '');
    assert.doesNotMatch(withoutLinks, /\d|%|процент/u, `condition restates a term: ${entry.id}`);
    assert.match(entry.content, /https:\/\//u, `condition without a link: ${entry.id}`);
  }
  // Срез на диске обязан оставаться отсылочным: условие с цифрой было бы
  // отброшено загрузчиком, поэтому счётчик сверяется с самим файлом.
  const raw = JSON.parse(readFileSync(ORG_SLICE_PATH, 'utf8'));
  const declared = raw.situations.filter((situation) => situation.kind === 'condition').length;
  assert.equal(conditions.length, declared, 'a condition was dropped as term-restating');
});
