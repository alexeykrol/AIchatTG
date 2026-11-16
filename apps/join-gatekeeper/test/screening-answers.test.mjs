import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateAnswer } from '../src/answers.mjs';
import { screenApplicant } from '../src/screening.mjs';
import { GOOD_ABOUT, scenario } from './helpers.mjs';

const sc = scenario();
const user = (overrides = {}) => ({ id: 1, is_bot: false, first_name: 'Мария', last_name: 'Петрова', username: 'maria_p', ...overrides });
const q = (id) => sc.questions.find((question) => question.id === id);

describe('screenApplicant', () => {
  test('bot account is blocked', () => {
    assert.deepEqual(screenApplicant({ from: user({ is_bot: true }), photoCount: 3 }, sc), { verdict: 'block', reasons: ['is_bot'] });
  });

  test('link together with a spam keyword is blocked', () => {
    const result = screenApplicant({ from: user(), bio: 'Заработок каждый день: t.me/rich_channel', photoCount: 1 }, sc);
    assert.equal(result.verdict, 'block');
    assert.ok(result.reasons.includes('link:bio'));
    assert.ok(result.reasons.includes('spam_keyword:заработ'));
  });

  test('link alone is review', () => {
    const result = screenApplicant({ from: user(), bio: 'Мой блог https://example.com', photoCount: 2 }, sc);
    assert.equal(result.verdict, 'review');
    assert.ok(result.reasons.includes('link:bio'));
  });

  test('@mention of another account is review', () => {
    const result = screenApplicant({ from: user(), bio: 'пишите @other_account', photoCount: 2 }, sc);
    assert.equal(result.verdict, 'review');
    assert.ok(result.reasons.includes('mention:bio'));
  });

  test('single spam keyword is review, two distinct keywords are block', () => {
    const one = screenApplicant({ from: user({ first_name: 'Казино' }), photoCount: 2 }, sc);
    assert.equal(one.verdict, 'review');
    assert.deepEqual(one.reasons, ['spam_keyword:казино']);
    const two = screenApplicant({ from: user({ username: 'crypto_casino_bet' }), photoCount: 2 }, sc);
    assert.equal(two.verdict, 'block');
  });

  test('keyword stems match only at word start (no false hit on normal names)', () => {
    const result = screenApplicant({ from: user({ first_name: 'Elizabeth', last_name: 'Learner', username: 'liz_learner' }), photoCount: 1 }, sc);
    assert.deepEqual(result, { verdict: 'clean', reasons: [] });
  });

  test('normal Russian name is clean, even without a photo', () => {
    assert.deepEqual(screenApplicant({ from: user(), photoCount: 0 }, sc), { verdict: 'clean', reasons: [] });
    assert.deepEqual(screenApplicant({ from: user(), photoCount: null }, sc), { verdict: 'clean', reasons: [] });
  });

  test('zero-width characters in the name are review', () => {
    const result = screenApplicant({ from: user({ first_name: 'Ма​рия' }), photoCount: 2 }, sc);
    assert.equal(result.verdict, 'review');
    assert.ok(result.reasons.includes('invisible_chars'));
  });

  test('zero-width characters do not hide a spam keyword', () => {
    const result = screenApplicant({ from: user({ first_name: 'Ка​зино' }), photoCount: 2 }, sc);
    assert.ok(result.reasons.includes('spam_keyword:казино'));
  });

  test('emoji-only name and empty name are review', () => {
    assert.ok(screenApplicant({ from: user({ first_name: '🔥🔥💰', last_name: undefined }), photoCount: 2 }, sc).reasons.includes('empty_name'));
    assert.ok(screenApplicant({ from: user({ first_name: 'A 🔥💰🚀', last_name: undefined }), photoCount: 2 }, sc).reasons.includes('emoji_name'));
    assert.ok(screenApplicant({ from: user({ first_name: '​​', last_name: undefined }), photoCount: 2 }, sc).reasons.includes('empty_name'));
  });

  test('mixed Latin+Cyrillic look-alike inside one word is review', () => {
    const result = screenApplicant({ from: user({ first_name: 'Mapия' }), photoCount: 2 }, sc);
    assert.equal(result.verdict, 'review');
    assert.ok(result.reasons.includes('mixed_script'));
  });

  test('no photo is added only together with another signal', () => {
    const withOther = screenApplicant({ from: user({ first_name: 'Ма​рия' }), photoCount: 0 }, sc);
    assert.ok(withOther.reasons.includes('no_photo'));
    assert.equal(withOther.verdict, 'review');
    const unknown = screenApplicant({ from: user({ first_name: 'Ма​рия' }), photoCount: null }, sc);
    assert.ok(!unknown.reasons.includes('no_photo'));
  });
});

describe('evaluateAnswer', () => {
  test('choice by button: accepted, not accepted, unknown', () => {
    assert.equal(evaluateAnswer(q('purpose'), { optionId: 'discuss' }).pass, true);
    assert.equal(evaluateAnswer(q('purpose'), { optionId: 'look' }).pass, true);
    assert.deepEqual(evaluateAnswer(q('purpose'), { optionId: 'ads' }), {
      pass: false, reason: 'option_not_accepted', retryable: false, optionId: 'ads',
    });
    assert.equal(evaluateAnswer(q('purpose'), { optionId: 'nope' }).retryable, true);
  });

  test('choice by typed label or alias', () => {
    assert.equal(evaluateAnswer(q('purpose'), { text: '  учусь на КУРСЕ! ' }).pass, true);
    assert.equal(evaluateAnswer(q('rules'), { text: 'Согласна' }).pass, true);
    assert.equal(evaluateAnswer(q('rules'), { text: 'Согласен(на)' }).pass, true);
    assert.equal(evaluateAnswer(q('rules'), { text: 'нет' }).pass, false);
    assert.equal(evaluateAnswer(q('rules'), { text: 'нет' }).retryable, false);
    assert.deepEqual(evaluateAnswer(q('rules'), { text: 'может быть' }), { pass: false, reason: 'no_matching_option', retryable: true });
  });

  test('free text passes a real answer', () => {
    assert.deepEqual(evaluateAnswer(q('about'), { text: GOOD_ABOUT }), { pass: true, reason: 'ok', retryable: false });
  });

  test('free text rules: short, few words, links', () => {
    assert.equal(evaluateAnswer(q('about'), { text: 'Привет всем' }).reason, 'too_short');
    assert.equal(evaluateAnswer(q('about'), { text: 'Программирование нейросетей ежедневно' }).reason, 'too_few_words');
    assert.equal(evaluateAnswer(q('about'), { text: 'Я маркетолог, смотрите мой сайт https://spam.example и пишите' }).reason, 'contains_link');
  });

  test('nonsense guard: emoji, punctuation, repeated char, copy of the question', () => {
    assert.equal(evaluateAnswer(q('about'), { text: '🔥🔥🔥🔥🔥🔥' }).reason, 'nonsense:only_emoji');
    assert.equal(evaluateAnswer(q('about'), { text: '?!.....,,,,' }).reason, 'nonsense:only_punctuation');
    assert.equal(evaluateAnswer(q('about'), { text: 'аааааааааааааааааааааааааааааа' }).reason, 'nonsense:repeated_char');
    assert.equal(evaluateAnswer(q('about'), { text: q('about').promptText }).reason, 'nonsense:copy_of_question');
    assert.equal(evaluateAnswer(q('about'), { text: null }).reason, 'not_text');
  });

  test('anyOf keywords are enforced when configured', () => {
    const custom = scenario((raw) => { raw.questions[1].rule.anyOf = ['ии', 'нейросет']; });
    const question = custom.questions[1];
    assert.equal(evaluateAnswer(question, { text: 'Я работаю бухгалтером и люблю читать хорошие книги вечером' }).reason, 'missing_keyword');
    assert.equal(evaluateAnswer(question, { text: 'Я работаю бухгалтером и пробую нейросети для отчётов каждый день' }).pass, true);
  });
});
