import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPromotionReview } from '../src/moderation-review-detector.mjs';

const PROMOTION = 'Я прочитал книгу «Синтетическая орбита». Купите книгу по промокоду FIXTURE.';
const observation = (overrides = {}) => ({
  chatId: '-10001', messageId: '3', userId: '41', revision: 1,
  observedAt: '2026-09-15T12:00:00.000Z', text: PROMOTION, ...overrides,
});
const history = (overrides = {}) => observation({ messageId: '1', observedAt: '2026-09-15T11:00:00.000Z', ...overrides });

test('promotion detector is deterministic, private and explicitly review-only', () => {
  const input = Object.freeze(observation());
  const first = detectPromotionReview(input);
  assert.deepEqual(first, detectPromotionReview(input));
  assert.equal(first.version, 'promotion-review-v1');
  assert.equal(first.reviewOnly, true);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(first.patternIds, ['personal-experience-promotion']);
  assert.deepEqual(first.relatedMessageIds, ['3']);
  assert.ok(first.reasons.includes('commercial_call_to_action'));
  assert.ok(first.reasons.includes('original_context_missing'));
  assert.deepEqual(Object.keys(first).sort(), [
    'fingerprint', 'patternIds', 'reasons', 'relatedMessageIds', 'reviewOnly', 'version',
  ]);
  assert.equal(JSON.stringify(first).includes('Синтетическая'), false);
});

for (const text of [
  'Я прочитал книгу «Синтетическая орбита».',
  'В ответ на вопрос рекомендую книгу: в третьей главе разобран нужный алгоритм.',
  'Полезный источник: https://example.invalid/fixture/book',
  'Великолепно структурированное, безупречно грамотное рассуждение.',
  'Спасибо за пост!',
  'Я прочитал книгу о курсе. Если нужна помощь с упражнением, напишите мне.',
  'Как купить книгу и какой курс выбрать?',
  'This book explains the exercise. Message me if you need help.',
  '',
]) {
  test(`benign cue alone is negative even if repeated: ${text || '(empty)'}`, () => {
    const result = detectPromotionReview(observation({ text }), {
      history: [history({ text }), history({ text, messageId: '2' })],
    });
    assert.deepEqual(result.patternIds, []);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.relatedMessageIds, []);
    assert.equal(result.reviewOnly, true);
  });
}

test('commercial private-message funnel and generic praise produce concrete seed patterns', () => {
  const funnel = detectPromotionReview(observation({
    text: 'Я прошла курс «Синтетическая орбита». Скидка по промокоду FIXTURE, напишите мне в личку.',
  }));
  assert.deepEqual(funnel.patternIds, ['dm-funnel', 'personal-experience-promotion']);
  const praise = detectPromotionReview(observation({ text: 'Спасибо за пост! Купите курс «Синтетическая орбита».' }));
  assert.deepEqual(praise.patternIds, ['generic-comment-promotion']);
});

test('English testimonial uses the same review-only boundary', () => {
  const result = detectPromotionReview(observation({ text: 'I tried the Fixture course. Buy this course now.' }));
  assert.deepEqual(result.patternIds, ['personal-experience-promotion']);
});

test('distinct same-chat native messages establish repeats without claiming common ownership', () => {
  const entries = [history({ userId: '55' }), history({ messageId: '2', userId: '66' })];
  const result = detectPromotionReview(observation(), { history: entries });
  assert.deepEqual(result.relatedMessageIds, ['1', '2', '3']);
  assert.deepEqual(result.patternIds, ['personal-experience-promotion', 'repeated-product-seeding', 'templated-testimonial']);
  assert.ok(result.reasons.includes('repeated_promotional_text'));
  assert.deepEqual(result, detectPromotionReview(observation(), { history: [...entries].reverse() }));
  assert.equal(/bot|ownership|automated|ai_author/iu.test(result.reasons.join(' ')), false);
});

test('webhook retries, current-message revisions, other chats and future history do not add matches', () => {
  const result = detectPromotionReview(observation(), { history: [
    history({ messageId: '3' }), history({ messageId: '3', revision: 2 }),
    history({ chatId: '-10002' }),
    history({ messageId: '4', observedAt: '2026-09-16T12:00:00.000Z' }),
  ] });
  assert.deepEqual(result.relatedMessageIds, ['3']);
  assert.equal(result.patternIds.includes('repeated-product-seeding'), false);
  const duplicateHistory = detectPromotionReview(observation(), { history: [history(), history(), history()] });
  assert.deepEqual(duplicateHistory.relatedMessageIds, ['1', '3']);
});

test('only highest revision counts; conflicting same-revision content fails closed', () => {
  const revised = history({ revision: 2, text: 'Исправление: я отозвал рекомендацию.' });
  for (const entries of [[history(), revised], [revised, history()]]) {
    assert.deepEqual(detectPromotionReview(observation(), { history: entries }).relatedMessageIds, ['3']);
  }
  const conflicted = detectPromotionReview(observation(), {
    history: [history(), history({ text: 'Другой текст той же редакции.' })],
  });
  assert.deepEqual(conflicted.relatedMessageIds, ['3']);
});

test('fingerprint normalizes case/spacing but preserves product, URL and chat identity', () => {
  const base = observation({ text: `${PROMOTION} https://example.invalid/alpha` });
  const first = detectPromotionReview(base).fingerprint;
  assert.equal(first, detectPromotionReview({ ...base, text: `  ${PROMOTION.toUpperCase().replaceAll(' ', '  ')}  https://example.invalid/alpha\n`, messageId: '99', userId: '98', revision: 5 }).fingerprint);
  assert.notEqual(first, detectPromotionReview({ ...base, chatId: '-20001' }).fingerprint);
  assert.notEqual(first, detectPromotionReview({ ...base, text: base.text.replace('/alpha', '/beta') }).fingerprint);
  assert.notEqual(first, detectPromotionReview({ ...base, text: base.text.replace('/alpha', '/Alpha') }).fingerprint);
  assert.notEqual(first, detectPromotionReview({ ...base, text: base.text.replace('орбита', 'река') }).fingerprint);
});

test('explicit quotations and classroom templates stay negative even with promotional words', () => {
  const quoted = observation({ text: `Цитата: ${PROMOTION}` });
  assert.deepEqual(detectPromotionReview(quoted, { history: [history({ text: quoted.text })] }).patternIds, []);
  const exercise = observation({ context: { messageId: '100', text: 'Учебное задание: напишите по шаблону пример рекламного текста.' } });
  assert.deepEqual(detectPromotionReview(exercise, { history: [history({ context: exercise.context })] }).patternIds, []);
  const example = observation({ text: `Advertising example: ${PROMOTION}` });
  assert.deepEqual(detectPromotionReview(example).patternIds, []);
});

test('multiple post contexts are reported only when explicit different context IDs were observed', () => {
  const source = observation({ context: { messageId: '100', text: 'Синтетический пост A.' } });
  const result = detectPromotionReview(source, { history: [history({ context: { messageId: '101', text: 'Синтетический пост B.' } })] });
  assert.ok(result.reasons.includes('observed_in_multiple_contexts'));
  assert.equal(result.reasons.includes('original_context_missing'), false);
  const missing = detectPromotionReview(observation(), { history: [history()] });
  assert.equal(missing.reasons.includes('observed_in_multiple_contexts'), false);
});

test('malformed input is rejected and malformed history cannot create evidence', () => {
  for (const change of [{ revision: -1 }, { revision: 0.5 }, { observedAt: 'invalid' }, { text: null }, { chatId: '' }]) {
    assert.throws(() => detectPromotionReview(observation(change)), /moderation_review_observation_invalid/u);
  }
  assert.throws(() => detectPromotionReview(observation(), { history: {} }), /moderation_review_observation_invalid/u);
  assert.deepEqual(detectPromotionReview(observation(), { history: [null, {}, history({ revision: -1 })] }).relatedMessageIds, ['3']);
});

const STANDARD_REPLY = 'Очень полезный разбор. Важно помнить, что настоящий результат складывается из последовательных действий, внимательного наблюдения и готовности возвращаться к основам. Подходите к каждому шагу осознанно и сохраняйте ясность намерений.';

test('local standard-reply seed requires three distinct long native messages, not two', () => {
  const current = observation({ text: STANDARD_REPLY });
  const first = history({ text: STANDARD_REPLY });
  const second = history({ text: STANDARD_REPLY, messageId: '2' });
  assert.deepEqual(detectPromotionReview(current, { history: [first] }).patternIds, []);
  const result = detectPromotionReview(current, { history: [first, second] });
  assert.deepEqual(result.patternIds, ['repeated-standard-reply']);
  assert.deepEqual(result.relatedMessageIds, ['1', '2', '3']);
  assert.deepEqual(result.reasons, ['original_context_missing', 'repeated_long_standard_reply']);
  assert.equal(result.reviewOnly, true);
});

test('standard-reply threshold is not inflated by retries, edits or other chats', () => {
  const current = observation({ text: STANDARD_REPLY });
  const first = history({ text: STANDARD_REPLY });
  const result = detectPromotionReview(current, { history: [
    first, first, { ...first, revision: 2 }, { ...first, messageId: '3' },
    { ...first, chatId: '-20002', messageId: '2' },
  ] });
  assert.deepEqual(result.patternIds, []);
  assert.deepEqual(result.relatedMessageIds, []);
});

test('standard-reply seed excludes short text, long URL alone, quotation and classroom context', () => {
  const negativeTexts = [
    'Спасибо за пост!',
    'https://example.invalid/' + 'synthetic-long-path/'.repeat(12),
    `Цитата: ${STANDARD_REPLY}`,
  ];
  for (const text of negativeTexts) {
    assert.deepEqual(detectPromotionReview(observation({ text }), {
      history: [history({ text }), history({ text, messageId: '2' })],
    }).patternIds, []);
  }
  const exercise = { text: STANDARD_REPLY, context: { messageId: '101', text: 'Учебное задание: повторите заданный текст.' } };
  assert.deepEqual(detectPromotionReview(observation(exercise), {
    history: [history(exercise), history({ ...exercise, messageId: '2' })],
  }).patternIds, []);
});

test('long book narrative is negative alone but three exact native copies give repetition-only review', () => {
  const text = 'Я прочитал книгу «Синтетическая орбита». В третьей главе подробно разобран именно тот алгоритм, о котором спросили выше. Примеры показывают порядок вычисления и помогают проверить самостоятельное решение.';
  assert.deepEqual(detectPromotionReview(observation({ text })).patternIds, []);
  const result = detectPromotionReview(observation({ text }), {
    history: [history({ text }), history({ text, messageId: '2' })],
  });
  assert.deepEqual(result.patternIds, ['repeated-standard-reply']);
  assert.deepEqual(result.reasons, ['original_context_missing', 'repeated_long_standard_reply']);
  assert.equal(result.reviewOnly, true);
});

test('standard-reply local character threshold has an exact 120-character boundary', () => {
  for (const length of [119, 120]) {
    const text = 'с'.repeat(length);
    const result = detectPromotionReview(observation({ text }), {
      history: [history({ text }), history({ text, messageId: '2' })],
    });
    assert.deepEqual(result.patternIds, length === 120 ? ['repeated-standard-reply'] : []);
  }
});
