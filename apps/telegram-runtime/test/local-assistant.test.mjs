import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  LAB_SUBSTITUTIONS,
  createRecordingTelegram,
  parseDialogueFile,
  runLocalAssistant,
} from '../scripts/local-assistant.mjs';

/**
 * Каталог реального пакета знания задаётся снаружи: он живёт в лаборатории, а не
 * в этом репозитории. Тесты, которым нужен настоящий корпус, пропускаются без
 * него — молчаливо зелёный прогон на отсутствующих данных был бы хуже пропуска.
 */
const PACKAGE_DIR = process.env.AICHATTG_KNOWLEDGE_PACKAGE_DIR || '';

test('the recording transport returns a Telegram-shaped receipt instead of sending', async () => {
  const telegram = createRecordingTelegram();
  const result = await telegram.sendMessage({ chatId: '-100', text: 'привет', replyToMessageId: '5' });
  assert.equal(result.ok, true);
  assert.equal(typeof result.data.message_id, 'number');
  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.sent[0].text, 'привет');
});

test('a dialogue file yields one question per line and ignores comments', () => {
  assert.deepEqual(
    parseDialogueFile('# заметка\nЧто такое промптинг?\n\n  Как устроен RAG?  \n'),
    ['Что такое промптинг?', 'Как устроен RAG?'],
  );
});

test('a package whose manifest does not match its files is refused, and nothing is answered', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-lab-tamper-'));
  try {
    writeFileSync(join(folder, 'ai.db'), 'not a database');
    writeFileSync(join(folder, 'knowledge.manifest.json'), JSON.stringify({
      databasePath: 'ai.db',
      domainId: 'ai',
      format: 'aichattg-knowledge-manifest-v2',
      packageName: 'tampered',
      sourceId: 'course-knowledge-v2',
      packageDigest: '0'.repeat(64),
      files: { 'ai.db': '1'.repeat(64) },
    }));
    const transcript = await runLocalAssistant({
      questions: ['Что такое промптинг?'],
      packageDir: folder,
    });
    // Допуск — гард, а не формальность: без совпадения sha256 стенд не отвечает.
    assert.equal(transcript.package.admitted, false);
    assert.equal(transcript.package.admissionReason, 'knowledge_package_invalid');
    assert.deepEqual(transcript.turns, []);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the transcript names its substitutions so a lab run is never read as production', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-lab-substitutions-'));
  try {
    writeFileSync(join(folder, 'ai.db'), 'not a database');
    writeFileSync(join(folder, 'knowledge.manifest.json'), JSON.stringify({
      databasePath: 'ai.db', domainId: 'ai', format: 'aichattg-knowledge-manifest-v2',
      packageName: 'tampered', sourceId: 'course-knowledge-v2',
      packageDigest: '0'.repeat(64), files: { 'ai.db': '1'.repeat(64) },
    }));
    const transcript = await runLocalAssistant({ questions: ['x'], packageDir: folder });
    assert.deepEqual(transcript.substitutions, [...LAB_SUBSTITUTIONS]);
    assert.equal(transcript.mode, 'dry');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a course question retrieves a non-empty pack and an off-domain question abstains', {
  skip: PACKAGE_DIR ? false : 'AICHATTG_KNOWLEDGE_PACKAGE_DIR is not set',
}, async () => {
  const transcript = await runLocalAssistant({
    questions: ['Что такое промптинг?', 'Как приготовить шашлык?'],
    packageDir: PACKAGE_DIR,
  });
  assert.equal(transcript.package.admitted, true);

  const [course, offDomain] = transcript.turns;
  // Вопрос по курсу: ретривер нашёл материал, воздержания нет, уроки названы.
  assert.equal(course.abstained, false);
  assert.ok(course.entries > 0, 'вопрос по курсу должен дать непустой пак');
  assert.ok(course.units.length > 0, 'у найденного материала должны быть уроки');
  assert.equal(course.route, 'teach:course-content-v1');

  // Вопрос вне домена: вето срабатывает до модели, ответ — честное воздержание.
  assert.equal(offDomain.abstained, true);
  assert.equal(offDomain.entries, 0);
  assert.match(offDomain.route, /^boundary:not_in_materials:/);
  assert.ok(offDomain.answer.includes('Не нашёл ответа в материалах курса'));
});

test('a value question routes to the value slice while operations and content stay untouched', {
  skip: PACKAGE_DIR ? false : 'AICHATTG_KNOWLEDGE_PACKAGE_DIR is not set',
}, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-lab-value-'));
  try {
    const slicePath = join(folder, 'value_slice.json');
    writeFileSync(slicePath, JSON.stringify({
      schema: 'value_slice.v1',
      fetched_at: '2026-08-14T00:00:00+00:00',
      situations: [{
        id: 'некогда-учиться-1', title: 'Некогда учиться, но хочу понимать', kind: 'value',
        question_forms: ['мне некогда учиться, но я хочу понимать'],
        answer_text: 'Способность отличать реальную работу от лапши не появляется без минимального погружения: честный минимальный трек — вводный модуль.',
        links: ['https://alexeykrol.com/courses/'], source_file: 'value/некогда-учиться.md',
      }],
    }), 'utf8');
    const transcript = await runLocalAssistant({
      questions: ['мне самой учиться некогда вообще ноль времени но я хочу понимать это лучше своих админов чтобы они мне лапшу не вешали'],
      packageDir: PACKAGE_DIR,
      valueSlicePath: slicePath,
    });
    assert.equal(transcript.value_slice.admitted, true);
    assert.equal(transcript.value_slice.entries, 1);
    const [turn] = transcript.turns;
    // Вопрос о пользе не молчит и не уезжает в уроки: он отвечен из value-среза.
    assert.equal(turn.kind, 'answered');
    assert.equal(turn.route, 'advise:course-value-v1');
    assert.equal(turn.abstained, false);
    assert.equal(turn.entries, 1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('dialogue memory carries earlier turns inside one session', {
  skip: PACKAGE_DIR ? false : 'AICHATTG_KNOWLEDGE_PACKAGE_DIR is not set',
}, async () => {
  const transcript = await runLocalAssistant({
    questions: ['Что такое промптинг?', 'А что такое RAG?'],
    packageDir: PACKAGE_DIR,
  });
  assert.equal(transcript.turns[0].dialogueTurnsSent, 0);
  // Второй вопрос уходит в модель вместе с первым ходом — это и есть диалог.
  assert.equal(transcript.turns[1].dialogueTurnsSent, 1);
});
