import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { detectPromotionReview } from '../src/moderation-review-detector.mjs';
import { classifySafetyV3 } from '../../telegram-runtime/src/safety-v3.mjs';
import { planTelegramSafetyAction } from '../../../packages/telegram-core/src/index.mjs';

// All inputs are synthetic. Safety labels below are injected reference labels:
// these tests exercise contracts, never live model recognition or Telegram.
const corpus = JSON.parse(readFileSync(new URL(
  '../../telegram-runtime/test/fixtures/porn-spam-policy-v1.json', import.meta.url,
), 'utf8')).cases;
const BOOK = 'Я прочитал книгу. Она помогла с решением задач в жизни и работе. Есть аудиоверсия.';
const observation = (text, overrides = {}) => ({
  chatId: '-10001', messageId: '3', revision: 1,
  observedAt: '2026-09-23T12:00:00.000Z', text, ...overrides,
});

function labelledRouter(message, matched, evidence = message.slice(0, 200)) {
  return JSON.stringify({
    threat: { match: matched, types: matched ? ['spam_or_scam'] : [],
      confidence: 0.35, evidence: matched ? [evidence] : [] },
    abuse: { match: false, types: [], confidence: 0.99, evidence: [] },
    target: matched ? 'group' : 'none', context_used: false,
  });
}

for (const id of ['ps-pos-010', 'ps-pos-011', 'ps-pos-012', 'ps-pos-014', 'ps-pos-018']) {
  test(`recurrence boundary: ${id} skips book Review but injected spam still plans immediate ban`, async () => {
    const fixture = corpus.find((item) => item.id === id);
    assert.ok(fixture?.expectedThreat);
    const review = detectPromotionReview(observation(fixture.text));
    assert.deepEqual(review.patternIds, []);
    assert.equal(review.reviewOnly, true);
    let calls = 0;
    const result = await classifySafetyV3({ message: fixture.text, async invoke(input) {
      calls++;
      assert.equal(input.stage, 'router');
      assert.equal(JSON.parse(input.user).message, fixture.text);
      assert.match(input.system, /Recognize the communicative purpose/);
      return { text: labelledRouter(fixture.text, true) };
    } });
    assert.equal(calls, 1);
    assert.equal(result.safetyRoute, 'threat');
    assert.equal(result.safetyTrace.router.context_used, false);
    assert.deepEqual(result.safetyTrace.router.threat.evidence, [fixture.text.slice(0, 200)]);
    const plan = planTelegramSafetyAction(result, 0);
    assert.equal(plan.action, 'ban_purge');
    assert.equal(plan.warning, null);
    assert.equal(plan.strikeAfter, 0);
  });
}

test('recurrence boundary: normalizing obfuscated evidence is rejected, not silently accepted', async () => {
  const message = 'Мои п\u200bорно-видео в пр\u200bофиле, заходи за полной коллекцией.';
  await assert.rejects(classifySafetyV3({ message, async invoke() {
    return { text: labelledRouter(message, true, 'порно-видео в профиле') };
  } }), { stage: 'router', reason: 'threat_evidence_not_verbatim' });
  const result = await classifySafetyV3({ message, async invoke() {
    return { text: labelledRouter(message, true, 'п\u200bорно-видео в пр\u200bофиле') };
  } });
  assert.equal(planTelegramSafetyAction(result, 0).action, 'ban_purge');
});

for (const id of ['ps-neg-001', 'ps-neg-003', 'ps-neg-014', 'ps-neg-016', 'ps-neg-018']) {
  test(`recurrence boundary: ${id} with injected clean label acquires no Review sanction`, async () => {
    const fixture = corpus.find((item) => item.id === id);
    assert.equal(fixture.expectedThreat, false);
    assert.deepEqual(detectPromotionReview(observation(fixture.text)).patternIds, []);
    const result = await classifySafetyV3({ message: fixture.text, async invoke() {
      return { text: labelledRouter(fixture.text, false) };
    } });
    assert.equal(planTelegramSafetyAction(result, 0).action, 'none');
  });
}

test('recurrence boundary: a covert-book Review finding cannot turn injected clean safety into a ban', async () => {
  for (const text of [BOOK, BOOK.toUpperCase(), BOOK.replace('прочитал', 'про\u200bчитал')]) {
    const review = detectPromotionReview(observation(text));
    assert.deepEqual(review.patternIds, ['covert-testimonial-bait']);
    assert.equal(review.reviewOnly, true);
    assert.equal(Object.hasOwn(review, 'action'), false);
    const safety = await classifySafetyV3({ message: text, async invoke() {
      return { text: labelledRouter(text, false) };
    } });
    assert.equal(planTelegramSafetyAction(safety, 0).action, 'none');
  }
});

// Negative controls extend the existing requested-context / withdrawn-benefit
// exclusions. They do not exempt explicit commercial promotion or exact repeats.
for (const [name, text] of [
  ['Russian qualified negation', 'Я прочитал книгу. Она не очень помогла в жизни и работе. Есть аудиоверсия.'],
  ['English qualified negation', 'I read the book. It has not really helped me in life or work. There is an audiobook.'],
  ['Russian recommendation withdrawn', BOOK + ' Не могу рекомендовать: авторские советы опасны.'],
  ['Russian recommendation to avoid', BOOK + ' Советую не читать её: упражнения оказались опасными.'],
]) {
  test(`recurrence negative control: ${name} is not an endorsement`, () => {
    assert.deepEqual(detectPromotionReview(observation(text)).patternIds, []);
  });
}

test('recurrence negative control: invisible separators in supplied request preserve its exception', () => {
  for (const text of [
    'Посоветуйте книгу для работы.',
    'По\u200bсоветуйте кни\u200bгу для работы.',
    'По\u200dсоветуйте кни\u2060гу для работы.',
  ]) {
    assert.deepEqual(detectPromotionReview(observation(BOOK, {
      context: { messageId: '1', text },
    })).patternIds, []);
  }
});

test('recurrence repair controls: negative wording does not erase separate commercial or repetition findings', () => {
  const commercial = BOOK + ' Не могу рекомендовать бумажную версию. Купите книгу по промокоду FIXTURE.';
  assert.ok(detectPromotionReview(observation(commercial)).patternIds.includes('personal-experience-promotion'));
  const text = BOOK + ' Не могу рекомендовать: авторские советы опасны.';
  const history = ['1', '2'].map((messageId) => observation(text, {
    messageId, observedAt: '2026-09-23T11:00:00.000Z',
  }));
  const repeated = detectPromotionReview(observation(text), { history });
  assert.ok(repeated.patternIds.includes('repeated-standard-reply'));
  assert.equal(repeated.reviewOnly, true);
});
