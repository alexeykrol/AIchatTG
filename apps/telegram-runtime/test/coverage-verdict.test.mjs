import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  DOMAIN_ROUTE_REASONS,
  GROUNDING_REASONS,
  isCourseOperationsSupportQuestion,
  isCourseValueQuestion,
} from '@aichattg/telegram-core';
import {
  ASSISTANT_NOT_IN_MATERIALS_TEXT,
  ASSISTANT_OUT_OF_COVERAGE_TEXT,
  assistantAbstentionReply,
  coverageDeficitCandidateLevel,
  isOutOfCoverageReason,
} from '../src/assistant-policy.mjs';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { createKnowledgeRetrieval } from '../src/knowledge-retrieval.mjs';
import { exportCoverageDeficits } from '../scripts/export-deficits.mjs';

/**
 * The two abstentions and the deficits journal. One reply class ("не нашёл,
 * переформулируйте") used to cover two different facts — a hole inside the
 * covered domain and a topic outside it — and a live run proved the advice is
 * harmful for the second: the user rephrased three times into the same wall.
 */

test('the two abstention verdicts carry different routes and different texts', () => {
  const outOfCoverage = assistantAbstentionReply(DOMAIN_ROUTE_REASONS.NO_SIGNAL);
  assert.equal(outOfCoverage.route, 'boundary:out_of_coverage:domain_no_signal');
  assert.equal(outOfCoverage.text, ASSISTANT_OUT_OF_COVERAGE_TEXT);
  // Warm and useful: names the boundary, points at a place that can help, and
  // never sends the user to rephrase into the same wall.
  assert.match(outOfCoverage.text, /не уполномочен/);
  assert.match(outOfCoverage.text, /ChatGPT|Claude/);
  assert.doesNotMatch(outOfCoverage.text, /переформулировать/);

  for (const reason of [
    GROUNDING_REASONS.NOT_FOUND,
    GROUNDING_REASONS.EMPTY,
    DOMAIN_ROUTE_REASONS.CLAIM_UNKNOWN,
    DOMAIN_ROUTE_REASONS.CLAIM_MISSING,
  ]) {
    const reply = assistantAbstentionReply(reason);
    assert.equal(reply.route, `boundary:not_in_materials:${reason}`, reason);
    assert.equal(reply.text, ASSISTANT_NOT_IN_MATERIALS_TEXT, reason);
  }
});

test('only the domain no-signal verdict classifies as out of coverage', () => {
  assert.equal(isOutOfCoverageReason(DOMAIN_ROUTE_REASONS.NO_SIGNAL), true);
  for (const reason of [
    GROUNDING_REASONS.NOT_FOUND,
    GROUNDING_REASONS.EMPTY,
    DOMAIN_ROUTE_REASONS.CLAIM_UNKNOWN,
    DOMAIN_ROUTE_REASONS.CLAIM_MISSING,
    DOMAIN_ROUTE_REASONS.REGISTRY_EMPTY,
    DOMAIN_ROUTE_REASONS.EVIDENCE_UNAVAILABLE,
    '', null,
  ]) {
    assert.equal(isOutOfCoverageReason(reason), false, String(reason));
  }
});

test('the deficit candidate label is a crude queue marker: L2 business, L3 pill, null otherwise', () => {
  assert.equal(coverageDeficitCandidateLevel('как использовать ИИ для бизнеса в моем салоне'), 'L2');
  assert.equal(coverageDeficitCandidateLevel('как монетизировать канал с ботом'), 'L2');
  assert.equal(coverageDeficitCandidateLevel('как поднять продажи и прибыль'), 'L2');
  // The pill premise in a formulation the value detector does not intercept.
  assert.equal(coverageDeficitCandidateLevel('не хочу разбираться в этих ваших нейросетях'), 'L3');
  // Марина: обычно value-детектор перехватит это раньше воздержания; метка —
  // страховка для непойманных формулировок той же посылки.
  assert.equal(coverageDeficitCandidateLevel(
    'мне самой учиться некогда вообще ноль времени но я хочу понимать это лучше своих админов',
  ), 'L3');
  assert.equal(coverageDeficitCandidateLevel('как приготовить борщ'), null);
  assert.equal(coverageDeficitCandidateLevel(''), null);
  // A question carrying both signals stays in the business queue: L2 is
  // checked first and the label is single-valued by design.
  assert.equal(coverageDeficitCandidateLevel('некогда учиться, но клиенты уходят'), 'L2');
});

test('the store records and lists coverage deficits, degrading an unknown label to null', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-deficits-store-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  try {
    let tick = 1_000;
    const store = createRuntimeStore(db, { now: () => (tick += 1) });
    store.recordCoverageDeficit({
      chatId: '-100', userId: '7', question: 'как варить борщ', reason: 'domain_no_signal',
    });
    store.recordCoverageDeficit({
      chatId: '-100', userId: '7', question: 'ИИ для бизнеса', reason: 'domain_no_signal', candidateLevel: 'L2',
    });
    store.recordCoverageDeficit({
      chatId: '-100', userId: null, question: 'x', reason: 'domain_no_signal', candidateLevel: 'nonsense',
    });

    const rows = store.listCoverageDeficits({ limit: 10 });
    assert.equal(rows.length, 3);
    // Newest first: the lab reads the journal as a queue of fresh interest.
    assert.equal(rows[0].question, 'x');
    assert.equal(rows[0].candidateLevel, null, 'an unknown label degrades to null, never throws');
    assert.equal(rows[0].userId, null);
    assert.equal(rows[1].candidateLevel, 'L2');
    assert.equal(rows[2].question, 'как варить борщ');
    assert.equal(rows[2].chatId, '-100');
    assert.equal(store.listCoverageDeficits({ limit: 1 }).length, 1);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the export tool reads the journal read-only and treats a pre-journal database as empty', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-deficits-export-'));
  try {
    const withJournal = join(folder, 'runtime.db');
    const db = openRuntimeDatabase(withJournal);
    createRuntimeStore(db).recordCoverageDeficit({
      chatId: '-100', userId: '7', question: 'как варить борщ',
      reason: 'domain_no_signal', candidateLevel: null,
    });
    db.close();

    const snapshot = exportCoverageDeficits({ databasePath: withJournal });
    assert.equal(snapshot.schema, 'coverage_deficits_export.v1');
    assert.equal(snapshot.journal_present, true);
    assert.equal(snapshot.count, 1);
    assert.equal(snapshot.deficits[0].question, 'как варить борщ');
    assert.equal(snapshot.deficits[0].reason, 'domain_no_signal');

    // An older runtime database has no journal table. The export must report
    // that honestly instead of failing or inventing an empty journal silently.
    const legacyPath = join(folder, 'legacy.db');
    const legacy = new Database(legacyPath);
    legacy.exec('CREATE TABLE runtime_inbound_events (event_id TEXT PRIMARY KEY)');
    legacy.close();
    const empty = exportCoverageDeficits({ databasePath: legacyPath });
    assert.equal(empty.journal_present, false);
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.deficits, []);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// --- Acceptance against the real package and gold set ------------------------

const PACKAGE_DIR = process.env.AICHATTG_KNOWLEDGE_PACKAGE_DIR
  || '/Users/alexeykrolmini/Code/allcourses/code/data/knowledge/packages/ai-887b1966234e';
const GOLD_PATH = process.env.AICHATTG_CONTENT_GOLD_PATH
  || join(PACKAGE_DIR, 'gold', 'ai.gold.jsonl');

/**
 * Известные словарные дефициты: answerable-вопросы голд-сета, в которых словарь
 * домена не узнаёт ни одного термина И корпус ничего не находит, поэтому
 * двухслойный вердикт даёт ложный out_of_coverage. Список — рэтчет: он может
 * только сокращаться (лаборатория добавляет алиасы в словарь пакета); новый
 * ложный вердикт вне списка — регрессия и падение теста.
 */
const KNOWN_DICTIONARY_DEFICITS = new Set(['g2-014', 'g3-002', 'g3-006', 'g5-010', 'g5-026']);

test('gold-190: no answerable question outside the known deficits is refused as out of coverage', {
  skip: existsSync(PACKAGE_DIR) && existsSync(GOLD_PATH)
    ? false
    : `real package/gold set is not available at ${PACKAGE_DIR}`,
}, async () => {
  const knowledge = {
    forPackage(sourceId) {
      return {
        available: true,
        reason: null,
        package: {
          sourceId,
          domainId: 'ai',
          databasePath: join(PACKAGE_DIR, 'ai.db'),
          packageDigest: 'measured-directly',
        },
      };
    },
  };
  const layer = createKnowledgeRetrieval({ validatePacks: false }, { knowledge });
  assert.equal(layer.available, true, layer.reason || 'layer must open the real package');
  try {
    const records = readFileSync(GOLD_PATH, 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(records.length >= 150, `gold set looks truncated: ${records.length}`);

    const falseRefusals = [];
    let outOfCoverage = 0;
    for (const record of records) {
      const grounded = await layer.forQuestion({
        question: record.question,
        sessionId: `gold:${record.query_id}`,
      });
      const refusedAsOutOfCoverage = !grounded.grounded
        && isOutOfCoverageReason(grounded.reason);
      if (refusedAsOutOfCoverage) outOfCoverage += 1;
      if (refusedAsOutOfCoverage && record.answerable === true
        && !KNOWN_DICTIONARY_DEFICITS.has(record.query_id)) {
        falseRefusals.push(`${record.query_id}: ${record.question}`);
      }
    }
    assert.deepEqual(falseRefusals, [],
      'an answerable gold question outside the known dictionary deficits was refused as out of coverage');
    // Обе стороны рэтчета: вердикт должен срабатывать на приманках голд-сета
    // (масло, шашлык, шарлотка …), иначе граница выключена молча.
    assert.ok(outOfCoverage >= 10,
      `the decoy questions should still be refused as out of coverage, got ${outOfCoverage}`);
  } finally {
    layer.close();
  }
});

test('operations and value questions are intercepted by their detectors before any abstention', () => {
  // Восемь боевых операционных вопросов и value-набор (включая Марину) уходят
  // в свои маршруты на подсказках роутера — до ретривера и до воздержаний.
  for (const question of [
    'есть у вас счёт для юрлица и акт потом. я через ООО плачу',
    'а если пятерых послать это сколько по деньгам',
    'у меня пропал доступ, что делать',
    'деньги с Трибьют списали, а подписка заблокирована',
    'переключите меня на живого агента поддержки',
    'сколько стоит и какие тарифы',
    'как поставить подписку на паузу',
    'какой у вас курс это закрывает и сколько по времени займёт',
  ]) {
    assert.equal(isCourseOperationsSupportQuestion(question), true, question);
  }
  for (const question of [
    'мне самой учиться некогда вообще ноль времени но я хочу понимать это лучше своих админов чтобы они мне лапшу не вешали',
    'зачем это мне как руководителю',
    'подойдёт ли мне ваш курс',
  ]) {
    assert.equal(isCourseValueQuestion(question), true, question);
  }
});
