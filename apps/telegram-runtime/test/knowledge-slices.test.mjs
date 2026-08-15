import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ASSISTANT_SOURCE_PACKAGES } from '@aichattg/telegram-core';
import { loadRuntimeConfig } from '../src/config.mjs';
import { assertSlicesAdmitted, composeKnowledgeSlices } from '../src/knowledge-slices.mjs';

/**
 * Корень знания и оба среза под ним: конфигурация боевого сервера повторяется
 * буквально, потому что проверяется именно она, а не удобная выдумка.
 */
function writeSlices({ orgSituations = null, valueSituations = null, valueRaw = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aichattg-knowledge-root-'));
  const orgPath = join(root, 'org_slice.json');
  const valuePath = join(root, 'value_slice.json');
  if (orgSituations) {
    writeFileSync(orgPath, JSON.stringify({
      schema: 'org_slice.v1', fetched_at: '2026-08-15T00:00:00+00:00', situations: orgSituations,
    }), 'utf8');
  }
  if (valueRaw != null) writeFileSync(valuePath, valueRaw, 'utf8');
  else if (valueSituations) {
    writeFileSync(valuePath, JSON.stringify({
      schema: 'value_slice.v1', fetched_at: '2026-08-15T00:00:00+00:00', situations: valueSituations,
    }), 'utf8');
  }
  return { root, orgPath, valuePath };
}

const ORG_SITUATION = {
  id: 'как-оплатить-1', title: 'Как оплатить?', kind: 'procedure',
  answer_text: 'Откройте страницу курса и нажмите кнопку оплаты.',
  source_url: 'https://alexeykrol.com/courses/ai_intro/',
};
const VALUE_SITUATION = {
  id: 'зачем-руководителю-1', title: 'Зачем это руководителю?', kind: 'value',
  answer_text: 'Чтобы отличать реальную работу от лапши, нужен минимальный трек.',
  links: ['https://alexeykrol.com/courses/ai_intro/'],
};

/** Пакет уроков: отдаёт свои источники пустыми и v2-пакет через forPackage. */
function stubPackageKnowledge() {
  return {
    forSource(sourceId) { return { available: true, reason: null, snapshot: { sourceId, entries: [] } }; },
    forPackage(sourceId) { return { available: true, reason: null, package: { sourceId } }; },
  };
}

test('both slice paths are admitted from the environment when they sit below the knowledge root', () => {
  const { root, orgPath, valuePath } = writeSlices({
    orgSituations: [ORG_SITUATION], valueSituations: [VALUE_SITUATION],
  });
  try {
    const config = loadRuntimeConfig({
      TELEGRAM_RUNTIME_KNOWLEDGE_ROOT: root,
      TELEGRAM_RUNTIME_KNOWLEDGE_ORG_SLICE_PATH: orgPath,
      TELEGRAM_RUNTIME_KNOWLEDGE_VALUE_SLICE_PATH: valuePath,
    }, { cwd: root });
    assert.equal(config.knowledge.slices.orgPath, orgPath);
    assert.equal(config.knowledge.slices.valuePath, valuePath);

    const composed = composeKnowledgeSlices(stubPackageKnowledge(), {
      orgSlicePath: config.knowledge.slices.orgPath,
      valueSlicePath: config.knowledge.slices.valuePath,
    });
    assert.deepEqual(composed.slices.map((slice) => [slice.name, slice.configured, slice.admitted, slice.reason]), [
      ['org', true, true, null],
      ['value', true, true, null],
    ]);
    assert.deepEqual(assertSlicesAdmitted(composed.slices), composed.slices);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Тот же гард, что у манифестов: конфигурация не должна уметь показать
// загрузчику произвольный файл на хосте, и срез здесь не исключение.
test('a slice path outside the knowledge root is refused at startup', () => {
  const { root, orgPath, valuePath } = writeSlices({
    orgSituations: [ORG_SITUATION], valueSituations: [VALUE_SITUATION],
  });
  const outside = mkdtempSync(join(tmpdir(), 'aichattg-outside-'));
  try {
    writeFileSync(join(outside, 'org_slice.json'), '{}', 'utf8');
    assert.throws(() => loadRuntimeConfig({
      TELEGRAM_RUNTIME_KNOWLEDGE_ROOT: root,
      TELEGRAM_RUNTIME_KNOWLEDGE_ORG_SLICE_PATH: join(outside, 'org_slice.json'),
    }, { cwd: root }), /TELEGRAM_RUNTIME_KNOWLEDGE_ORG_SLICE_PATH must name a file below TELEGRAM_RUNTIME_KNOWLEDGE_ROOT/);
    assert.throws(() => loadRuntimeConfig({
      TELEGRAM_RUNTIME_KNOWLEDGE_ROOT: root,
      TELEGRAM_RUNTIME_KNOWLEDGE_VALUE_SLICE_PATH: join(root, '..', 'value_slice.json'),
    }, { cwd: root }), /TELEGRAM_RUNTIME_KNOWLEDGE_VALUE_SLICE_PATH must name a file below TELEGRAM_RUNTIME_KNOWLEDGE_ROOT/);
    // Корень знания сам по себе — не файл среза: путь обязан вести ПОД него.
    assert.throws(() => loadRuntimeConfig({
      TELEGRAM_RUNTIME_KNOWLEDGE_ROOT: root,
      TELEGRAM_RUNTIME_KNOWLEDGE_VALUE_SLICE_PATH: root,
    }, { cwd: root }), /must name a file below/);
    assert.ok(valuePath.startsWith(root));
    assert.ok(orgPath.startsWith(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('an unset slice variable leaves the slice unattached without failing startup', () => {
  const config = loadRuntimeConfig({
    TELEGRAM_RUNTIME_KNOWLEDGE_ROOT: '/tmp/aichattg-slice-test',
    // Пустая строка — та же законная конфигурация, что и отсутствие ключа:
    // забытая пустая переменная в env-файле не должна ронять старт.
    TELEGRAM_RUNTIME_KNOWLEDGE_VALUE_SLICE_PATH: '',
  }, { cwd: '/tmp/aichattg-slice-test' });
  assert.equal(config.knowledge.slices.orgPath, null);
  assert.equal(config.knowledge.slices.valuePath, null);

  const base = stubPackageKnowledge();
  const composed = composeKnowledgeSlices(base, {
    orgSlicePath: config.knowledge.slices.orgPath,
    valueSlicePath: config.knowledge.slices.valuePath,
  });
  assert.deepEqual(composed.slices.map((slice) => [slice.name, slice.configured, slice.admitted]), [
    ['org', false, false],
    ['value', false, false],
  ]);
  // Без срезов знание — ровно тот же объект: сервер работает как до врезки.
  assert.equal(composed.knowledge, base);
  assert.equal(composed.baseKnowledge, base);
  assert.doesNotThrow(() => assertSlicesAdmitted(composed.slices));
});

test('the composed knowledge answers from the slices while lesson retrieval never sees them', () => {
  const { root, orgPath, valuePath } = writeSlices({
    orgSituations: [ORG_SITUATION], valueSituations: [VALUE_SITUATION],
  });
  try {
    const base = stubPackageKnowledge();
    const composed = composeKnowledgeSlices(base, { orgSlicePath: orgPath, valueSlicePath: valuePath });

    const operations = composed.knowledge.forSource(ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS);
    assert.equal(operations.available, true);
    assert.deepEqual(operations.snapshot.entries.map((entry) => entry.id), ['как-оплатить-1']);
    const value = composed.knowledge.forSource(ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE);
    assert.equal(value.available, true);
    assert.deepEqual(value.snapshot.entries.map((entry) => entry.id), ['зачем-руководителю-1']);
    // Содержательный источник проходит насквозь: подключение срезов не даёт им
    // доступа к чужому источнику.
    assert.deepEqual(composed.knowledge.forSource(ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT).snapshot.entries, []);

    // Ретривер строится от базового адаптера, а не от склейки. Через него
    // записи срезов недостижимы — иначе поиск по урокам выдавал бы отсылки об
    // оплате как найденный материал урока.
    assert.deepEqual(composed.baseKnowledge.forSource(ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS).snapshot.entries, []);
    assert.deepEqual(composed.baseKnowledge.forSource(ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE).snapshot.entries, []);
    assert.equal(
      composed.baseKnowledge.forPackage(ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE).package.sourceId,
      ASSISTANT_SOURCE_PACKAGES.COURSE_KNOWLEDGE,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Класс дефекта «тихая пустота» уже стоил живого прогона: негабаритный срез
// проваливался в null и клиент получал пустой ответ. Заданный, но отвергнутый
// срез обязан ронять старт, а не оставлять бота внешне исправным без домена.
test('a configured but refused slice fails startup instead of quietly disappearing', () => {
  const { root, orgPath, valuePath } = writeSlices({
    orgSituations: [ORG_SITUATION], valueRaw: '{ это не json',
  });
  try {
    const composed = composeKnowledgeSlices(stubPackageKnowledge(), {
      orgSlicePath: orgPath, valueSlicePath: valuePath,
    });
    const [org, value] = composed.slices;
    assert.deepEqual([org.admitted, org.reason], [true, null]);
    assert.deepEqual([value.configured, value.admitted, value.reason], [true, false, 'value_slice_invalid']);
    assert.throws(() => assertSlicesAdmitted(composed.slices),
      /value knowledge slice is configured but was refused \(value_slice_invalid\)/);

    // Отсутствующий файл по заданному пути — тот же отказ, не молчание.
    const missing = composeKnowledgeSlices(stubPackageKnowledge(), { orgSlicePath: join(root, 'nope.json') });
    assert.equal(missing.slices[0].reason, 'org_slice_missing');
    assert.throws(() => assertSlicesAdmitted(missing.slices),
      /org knowledge slice is configured but was refused \(org_slice_missing\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Отчёт уходит в лог старта: он обязан нести путь, флаг и код причины — и не
// обязан нести содержимое среза.
test('the startup report carries admission facts without leaking slice content', () => {
  const { root, orgPath, valuePath } = writeSlices({
    orgSituations: [ORG_SITUATION], valueSituations: [VALUE_SITUATION],
  });
  try {
    const composed = composeKnowledgeSlices(stubPackageKnowledge(), {
      orgSlicePath: orgPath, valueSlicePath: valuePath,
    });
    for (const slice of composed.slices) {
      assert.deepEqual(Object.keys(slice).sort(),
        ['admitted', 'configured', 'entries', 'name', 'path', 'reason', 'sourceId']);
      assert.equal(slice.entries, 1);
    }
    const serialized = JSON.stringify(composed.slices);
    assert.ok(!serialized.includes(ORG_SITUATION.answer_text));
    assert.ok(!serialized.includes(VALUE_SITUATION.answer_text));
    assert.deepEqual(composed.slices.map((slice) => slice.sourceId), [
      ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS,
      ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
