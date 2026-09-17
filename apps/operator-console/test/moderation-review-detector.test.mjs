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
  assert.equal(first.version, 'promotion-review-v2');
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

// Synthetic targeting corpus: these are suspicions for a human, not labelled
// proof of a campaign. No production text, user identity or message coordinates.
const TESTIMONIALS = [
  'Недавно наткнулся на книгу «Тихая траектория». Ждал очередных обещаний успеха, а научился спокойнее принимать решения. Принципы пригодились и дома, и на работе. Думаю, стоит почитать.',
  'Дочитала книгу «Линия ветра». Думала, будут одни банальности, но после чтения перестала откладывать важные дела. Есть аудиоверсия. Возможно, вам тоже стоит познакомиться.',
  'Случайно нашёл книгу «Северный шаг» и прочитал за выходные. Мне стало проще выбирать приоритеты. Её принципы работают в повседневной жизни и делах. Можно слушать аудиокнигу, присмотритесь.',
  'Открыл книгу «Ясный поворот» из любопытства. Ожидал привычную мотивацию, однако разбор помог мне перестать метаться между задачами. Эти принципы применяю и в работе, и в личной жизни.',
  'Недавно попалась книга «Ровный горизонт». Прочла её, хотя ожидала пустых советов об успехе. На деле стало легче доводить начатое до конца. Если ищете что-то полезное, советую обратить внимание.',
  'По совету знакомого послушал одну книгу. После неё мне проще справляться с ежедневными решениями. Общие принципы пригодились в жизни и работе. Удобно, что она есть в аудио; могу порекомендовать.',
  'Прошла курс «Спокойный вектор». Думала, опять красивые лозунги, но упражнения помогли мне увереннее расставлять приоритеты. Материалы можно слушать в аудиоформате.',
  'Взял почитать «Новый ритм». Сначала считал эту книгу очередной историей про успешный успех, но она помогла мне наладить привычки. Идеи использую дома и в рабочих делах. Может оказаться полезной.',
  'Я прочитал книгу «Малый компас». Теперь легче отделяю важное от срочного. Принципы универсальные — для работы и обычной жизни. Аудиоверсия тоже есть, рекомендую присмотреться.',
  'Нашла и прочитала книгу «Точка равновесия». Настраивалась на общие слова, а получила понятный способ организовать день. Подход пригодился в личных и рабочих делах. Ещё доступна озвученная версия.',
  'I stumbled upon the book Quiet Meridian and read it last weekend. I expected generic success advice, but it helped me finish neglected tasks. An audiobook is available too; it may be worth a look.',
  'I completed the Clear Path course. It helped me make decisions with less hesitation. I use its principles both at work and in everyday life. There is an audio edition; I would recommend exploring it.',
  'Друзья, попалась книга про личные ориентиры. Думал, снова будет про постоянную гонку за результатом, а автор объясняет, как выбирать важное в работе и повседневной жизни. Если удобно, есть аудио, очень советую.',
];
const UNRELATED_PARENT = { messageId: '501', text: 'Обсуждаем перенос автобусной остановки и новый маршрут.' };

for (const [index, text] of TESTIMONIALS.entries()) {
  test('covert testimonial singleton ' + (index + 1) + ' is review-only without commercial CTA', () => {
    const result = detectPromotionReview(observation({ text, context: UNRELATED_PARENT }));
    assert.deepEqual(result.patternIds, ['covert-testimonial-bait']);
    assert.deepEqual(result.relatedMessageIds, ['3']);
    assert.equal(result.reviewOnly, true);
    assert.ok(result.reasons.includes('personal_testimonial_with_benefit'));
    assert.ok(result.reasons.length >= 3);
    assert.equal(result.reasons.includes('commercial_call_to_action'), false);
    assert.equal(result.reasons.includes('observed_in_multiple_contexts'), false);
    assert.equal(/bot|ownership|automated|ai_author|off_topic/iu.test(result.reasons.join(' ')), false);
  });
}

const BENIGN_TESTIMONIALS = [
  { text: 'Я прочитал книгу «Тихая траектория». Не понял, почему рассказчик меняет точку зрения в последней главе. Как вы это объясняете?' },
  { text: TESTIMONIALS[0], context: { messageId: '502', text: 'Посоветуйте книги, которые помогли вам принимать решения. Интересует ваш личный опыт.' } },
  { text: TESTIMONIALS[2], context: { messageId: '503', text: 'Какую аудиокнигу о выборе приоритетов вы посоветуете и почему?' } },
  { text: 'Цитата: ' + TESTIMONIALS[1] },
  { text: 'Модераторы, проверьте сообщение: «Я прочитал книгу, ожидал банальностей, но она помогла мне изменить жизнь и работу. Есть аудиоверсия, рекомендую». Это повторяют под разными темами.' },
  { text: TESTIMONIALS[4], context: { messageId: '504', text: 'Учебное задание: напишите по шаблону пример рекламного текста.' } },
  { text: 'Я прочитал книгу по геометрии, и пример помог мне понять доказательство. Если нужна помощь с этим упражнением, напишите мне — разберём решение.' },
  { text: 'Я прочитал книгу «Синтетическая геометрия». В главе «Подобие треугольников» разобрано именно ваше построение: проведите высоту и сравните углы. Есть аудиоверсия, но рекомендую рисунок на странице 42.', context: { messageId: '505', text: 'Как доказать подобие этих треугольников?' } },
  { text: 'Я прочитал книгу «Ровный горизонт». Ожидал полезных принципов для жизни и работы, но она мне не помогла. Есть аудиоверсия, однако рекомендовать её не могу.' },
  { text: 'Если бы я прочитал такую книгу и она помогла мне в жизни и работе, возможно, порекомендовал бы её. Пока даже не знаю, существует ли аудиоверсия.' },
  { text: 'У книги «Малый компас» появилась аудиоверсия. Кто сравнивал перевод с бумажным изданием?' },
  { text: 'I read the book and its chapter on fractions helped me solve this exercise. Message me if you want to check the denominator together.' },
  { text: TESTIMONIALS[10], context: { messageId: '506', text: 'Which book would you recommend for making everyday decisions?' } },
  { text: 'Reporting spam: ' + TESTIMONIALS[10] },
  { text: 'I read the book. I expected useful advice but it did not help in life or work. An audiobook is available; I cannot recommend it.' },
];
for (const [index, changes] of BENIGN_TESTIMONIALS.entries()) {
  test('legitimate testimonial counterexample ' + (index + 1) + ' stays negative', () => {
    assert.deepEqual(detectPromotionReview(observation(changes)).patternIds, []);
  });
}

test('testimonial cues tolerate case, whitespace and invisible separators without changing identity', () => {
  const source = TESTIMONIALS[12];
  const base = detectPromotionReview(observation({ text: source }));
  for (const text of [source.toUpperCase(), source.replaceAll(' ', '  '), source.replaceAll(' ', '\n'),
    source.replace('попалась', 'по\u200bпалась').replace('книга', 'кни\u200dга')]) {
    const result = detectPromotionReview(observation({ text }));
    assert.deepEqual(result.patternIds, base.patternIds);
    assert.equal(result.reviewOnly, true);
  }
  assert.notEqual(base.fingerprint, detectPromotionReview(observation({
    text: source.replace('попалась', 'по\u200bпалась'),
  })).fingerprint);
});

test('multiple synonyms in one support family do not replace two independent supports', () => {
  const text = 'Я прочитал книгу, она помогла расставить приоритеты. Рекомендую, советую присмотреться, стоит почитать.';
  assert.deepEqual(detectPromotionReview(observation({ text })).patternIds, []);
});

test('bare product, experience, benefit or format cues do not become findings', () => {
  for (const text of [
    'Книга про жизнь и работу, есть аудиоверсия, рекомендую.',
    'Я прочитал книгу. Есть аудиоверсия, рекомендую.',
    'Мне помогло расставить приоритеты в жизни и работе, рекомендую, есть аудио.',
    'Я прочитал книгу, она помогла выбрать приоритеты.',
  ]) assert.deepEqual(detectPromotionReview(observation({ text })).patternIds, []);
});

test('missing context is not invented as proof of irrelevance', () => {
  const result = detectPromotionReview(observation({ text: TESTIMONIALS[12] }));
  assert.ok(result.reasons.includes('original_context_missing'));
  assert.equal(result.reasons.some((reason) => /irrelevant|unrelated|off_topic/u.test(reason)), false);
});

test('paraphrases and different product names do not create repetition or shared identity', () => {
  const first = history({ text: TESTIMONIALS[0], userId: '55', context: UNRELATED_PARENT });
  const current = observation({ text: TESTIMONIALS[1], context: { messageId: '507', text: 'Другой синтетический пост.' } });
  const result = detectPromotionReview(current, { history: [first] });
  assert.deepEqual(result.patternIds, ['covert-testimonial-bait']);
  assert.deepEqual(result.relatedMessageIds, ['3']);
  assert.notEqual(result.fingerprint, detectPromotionReview(first).fingerprint);
  assert.equal(result.reasons.includes('observed_in_multiple_contexts'), false);
});

test('new contextual exclusions do not override existing explicit commercial detection', () => {
  const context = { messageId: '502', text: 'Посоветуйте книги для работы.' };
  assert.deepEqual(detectPromotionReview(observation({ context })).patternIds, ['personal-experience-promotion']);
  const report = 'Модераторы, проверьте текст. Я прочитал книгу. Купите книгу по промокоду FIXTURE.';
  assert.ok(detectPromotionReview(observation({ text: report })).patternIds.includes('personal-experience-promotion'));
});

test('requested narrative exact copies still preserve the separate repetition-only contract', () => {
  const context = { messageId: '502', text: 'Посоветуйте книги для работы.' };
  const text = TESTIMONIALS[0];
  const result = detectPromotionReview(observation({ text, context }), { history: [
    history({ text, context }), history({ text, context, messageId: '2' }),
  ] });
  assert.deepEqual(result.patternIds, ['repeated-standard-reply']);
  assert.deepEqual(result.relatedMessageIds, ['1', '2', '3']);
});

test('life/work cues require word boundaries rather than unrelated substrings', () => {
  const text = 'Я прочитал книгу: она помогла разобраться с различными алгоритмами. Советую сделать таблицу.';
  assert.deepEqual(detectPromotionReview(observation({ text })).patternIds, []);
  for (const text of [
    'Я прочитал книгу, она помогла различными примерами в работе, советую.',
    'Я прочитал книгу, она помогла понять жизнь, советую сделать таблицу.',
  ]) assert.deepEqual(detectPromotionReview(observation({ text })).patternIds, []);
});

test('plural and singular requests for recommendations qualify as supplied context', () => {
  for (const text of [
    'Какие книги вы посоветуете для принятия решений в жизни и работе?',
    'Какую книгу порекомендуете?',
    'Какой курс вы посоветуете?',
    'Посоветуй книгу для работы.',
    'Порекомендуйте аудиокнигу.',
  ]) assert.deepEqual(detectPromotionReview(observation({
    text: TESTIMONIALS[12], context: { messageId: '508', text },
  })).patternIds, []);
});

test('explicit spam reports remain reports with a greeting or a direct label', () => {
  for (const prefix of ['Спам: ', 'Здравствуйте, модераторы, проверьте сообщение: ', 'Привет, модераторы, посмотрите: ']) {
    assert.deepEqual(detectPromotionReview(observation({ text: prefix + '«' + TESTIMONIALS[8] + '»' })).patternIds, []);
  }
});

test('negated experience is not described as a personal testimonial', () => {
  const text = 'Я не прочитал книгу «Малый компас». Мне рассказывали, что она помогла им в жизни и работе. Есть аудиоверсия.';
  assert.deepEqual(detectPromotionReview(observation({ text })).patternIds, []);
});

test('a counterfactual conclusion does not erase an actual narrated endorsement', () => {
  for (const suffix of [
    ' Если бы не она, я бы до сих пор откладывал важные дела.',
    ' Если бы я прочитал её раньше, не тратил бы столько времени зря.',
  ]) assert.deepEqual(detectPromotionReview(observation({ text: TESTIMONIALS[8] + suffix })).patternIds, ['covert-testimonial-bait']);
});

test('polite recommendation requests remain supplied contextual exceptions', () => {
  for (const text of [
    'Можете посоветовать книгу для принятия решений в жизни и работе?',
    'Можете ли вы порекомендовать книгу?',
    'Можешь посоветовать аудиокнигу?',
    'Могли бы вы порекомендовать книгу?',
  ]) assert.deepEqual(detectPromotionReview(observation({
    text: TESTIMONIALS[12], context: { messageId: '509', text },
  })).patternIds, []);
});

test('English negative benefit tenses and advice to avoid a book are not endorsements', () => {
  for (const sentence of [
    'It has not helped me in life or work.',
    "It hasn't helped me in life or work.",
    'It never helped me in life or work.',
    'It does not help me in life or work.',
  ]) assert.deepEqual(detectPromotionReview(observation({
    text: 'I read the book. ' + sentence + ' There is an audiobook; I would recommend exploring it.',
  })).patternIds, []);
  for (const recommendation of ['I would recommend avoiding it.', 'I recommend against reading it.']) {
    assert.deepEqual(detectPromotionReview(observation({
      text: 'I read the book. It has not helped me in life or work. There is an audiobook; ' + recommendation,
    })).patternIds, []);
    assert.deepEqual(detectPromotionReview(observation({
      text: 'I read the book. It helped me initially in life and work, but the advice later proved misleading. There is an audiobook; ' + recommendation,
    })).patternIds, []);
  }
});
