import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decideAnswers, evaluateChoice, evaluateCustomTopic, nonsenseReason, TOPIC_ROW, topicState,
} from '../src/answers.mjs';
import { adSignals, precheckApplicant } from '../src/screening.mjs';
import { scenario } from './helpers.mjs';

const sc = scenario();
const user = (overrides = {}) => ({ id: 1, is_bot: false, first_name: 'Мария', last_name: 'Петрова', username: 'maria_p', ...overrides });
const q = (id) => sc.questions.find((question) => question.id === id);
const pre = (input) => precheckApplicant({ photoCount: 2, ...input }, sc);

describe('precheckApplicant (A0-bis)', () => {
  test('clean profile passes with no signals', () => {
    assert.deepEqual(pre({ from: user() }), { reason: null, signals: [], info: [] });
  });

  test('is_bot / is_scam / is_fake → R_SCAM, before anything else', () => {
    assert.equal(pre({ from: user({ is_bot: true }), bio: 'https://spam.example' }).reason, 'R_SCAM');
    assert.deepEqual(pre({ from: user(), isScam: true }).signals, ['is_scam']);
    assert.deepEqual(pre({ from: user(), isFake: true }).signals, ['is_fake']);
  });

  test('link or t.me in bio → R_PROFILE_AD', () => {
    assert.equal(pre({ from: user(), bio: 'Мой блог https://example.com' }).reason, 'R_PROFILE_AD');
    assert.deepEqual(pre({ from: user(), bio: 'канал t.me/my_channel' }).signals, ['link:bio']);
  });

  test('@mention in bio or name → R_PROFILE_AD', () => {
    assert.deepEqual(pre({ from: user(), bio: 'пишите @other_account' }).signals, ['mention:bio']);
    assert.deepEqual(pre({ from: user({ last_name: '@my_channel' }) }).signals, ['mention:name']);
  });

  test('link in name → R_PROFILE_AD', () => {
    assert.deepEqual(pre({ from: user({ first_name: 'Мария shop.ru' }) }).signals, ['link:name']);
  });

  test('personal_chat true → R_PROFILE_AD; false and null (unknown) are not signals', () => {
    assert.deepEqual(pre({ from: user(), personalChat: true }), { reason: 'R_PROFILE_AD', signals: ['personal_chat'], info: [] });
    assert.equal(pre({ from: user(), personalChat: false }).reason, null);
    assert.equal(pre({ from: user(), personalChat: null }).reason, null);
  });

  test('a single spam keyword → R_STOPWORD', () => {
    const result = pre({ from: user({ first_name: 'Казино' }) });
    assert.equal(result.reason, 'R_STOPWORD');
    assert.deepEqual(result.signals, ['spam_keyword:казино']);
    assert.equal(pre({ from: user(), bio: 'Заработок каждый день' }).reason, 'R_STOPWORD');
    assert.equal(pre({ from: user({ username: 'crypto_maria' }) }).reason, 'R_STOPWORD');
  });

  test('precedence: profile ad wins over stopword', () => {
    const result = pre({ from: user(), bio: 'Заработок: t.me/rich_channel' });
    assert.equal(result.reason, 'R_PROFILE_AD');
    assert.deepEqual(result.signals, ['link:bio', 'spam_keyword:заработ']);
  });

  test('core audience wording stays clean (PO keyword decision 2026-11-17)', () => {
    for (const bio of [
      'Предприниматель, инвестор, продвижение в соцсетях, 1000 подписчиков',
      'Better marketing with AI, learning every day',
      'Пишу скрипты на Python, ставка на автоматизацию',
    ]) {
      assert.deepEqual(pre({ from: user(), bio }), { reason: null, signals: [], info: [] }, bio);
    }
  });

  test('keyword stems match only at word start', () => {
    assert.equal(pre({ from: user({ first_name: 'Elizabeth', last_name: 'Learner', username: 'liz_learner' }) }).reason, null);
  });

  test('zero-width characters do not hide a spam keyword', () => {
    assert.equal(pre({ from: user({ first_name: 'Ка​зино' }) }).reason, 'R_STOPWORD');
  });

  test('soft signals are informational only: never a reason', () => {
    const cases = [
      [{ from: user({ first_name: 'Ма​рия' }) }, 'invisible_chars'],
      [{ from: user({ first_name: '🔥🔥💰', last_name: undefined }) }, 'empty_name'],
      [{ from: user({ first_name: 'A 🔥💰🚀', last_name: undefined }) }, 'emoji_name'],
      [{ from: user({ first_name: 'Mapия' }) }, 'mixed_script'],
      [{ from: user(), photoCount: 0 }, 'no_photo'],
    ];
    for (const [input, info] of cases) {
      const result = pre(input);
      assert.equal(result.reason, null, info);
      assert.ok(result.info.includes(info), info);
    }
    assert.ok(!pre({ from: user(), photoCount: null }).info.includes('no_photo'), 'unknown photo count is no signal');
  });
});

describe('adSignals (custom topic)', () => {
  test('link, mention, spam keyword', () => {
    assert.deepEqual(adSignals('Нейросети для маркетинга', sc), []);
    assert.deepEqual(adSignals('смотрите https://x.example', sc), ['link']);
    assert.deepEqual(adSignals('мой канал @best_channel', sc), ['mention']);
    assert.deepEqual(adSignals('крипто и forex', sc), ['spam_keyword:forex']);
  });
});

describe('evaluateChoice', () => {
  test('buttons: accepted, rejecting option carries its code, unknown', () => {
    assert.deepEqual(evaluateChoice(q('participate'), { optionId: 'yes' }), { pass: true, reason: 'accepted_option', optionId: 'yes' });
    assert.deepEqual(evaluateChoice(q('participate'), { optionId: 'no' }), { pass: false, reason: 'R_READER', optionId: 'no' });
    assert.deepEqual(evaluateChoice(q('rules'), { optionId: 'disagree' }), { pass: false, reason: 'R_RULES', optionId: 'disagree' });
    assert.deepEqual(evaluateChoice(q('participate'), { optionId: 'nope' }), { pass: false, reason: 'unknown_option' });
  });

  test('typed label or alias', () => {
    assert.equal(evaluateChoice(q('participate'), { text: '  да, хочу УЧАСТВОВАТЬ! ' }).pass, true);
    assert.equal(evaluateChoice(q('rules'), { text: 'Согласна' }).pass, true);
    assert.equal(evaluateChoice(q('rules'), { text: 'Прочитал(а), согласен(на)' }).pass, true);
    assert.equal(evaluateChoice(q('rules'), { text: 'нет' }).reason, 'R_RULES');
    assert.deepEqual(evaluateChoice(q('rules'), { text: 'может быть' }), { pass: false, reason: 'no_matching_option' });
    assert.deepEqual(evaluateChoice(q('participate'), { text: null }), { pass: false, reason: 'no_matching_option' });
  });
});

describe('topics (multi_choice)', () => {
  const topics = q('topics');
  const row = (reason, text, pass = 1) => ({ question_id: 'topics', reason, text, pass });

  test('toggle parity, custom count, satisfied', () => {
    assert.deepEqual(topicState(topics, []), { selected: [], custom: 0, satisfied: false });
    const rows = [row('toggle', 'tools'), row('toggle', 'agents'), row('toggle', 'tools')];
    assert.deepEqual(topicState(topics, rows), { selected: ['agents'], custom: 0, satisfied: true });
    assert.deepEqual(topicState(topics, [row('toggle', 'agents'), row('toggle', 'agents')]).satisfied, false);
    assert.deepEqual(topicState(topics, [row('custom_topic', 'Своя тема')]), { selected: [], custom: 1, satisfied: true });
    assert.equal(topicState(topics, [row('custom_topic', 'реклама', 0)]).satisfied, false, 'rejected custom topic does not count');
  });

  test('custom topic: clean accepted, dirty rejected, nonsense ignored', () => {
    assert.deepEqual(evaluateCustomTopic(topics, 'ИИ в медицине', sc), { kind: 'accept' });
    assert.equal(evaluateCustomTopic(topics, 'мой курс https://x.example', sc).reason, 'R_TOPIC_AD');
    assert.equal(evaluateCustomTopic(topics, 'подписывайтесь @channel_x', sc).kind, 'reject');
    assert.equal(evaluateCustomTopic(topics, 'казино онлайн', sc).kind, 'reject');
    assert.deepEqual(evaluateCustomTopic(topics, '🔥🔥', sc), { kind: 'ignore', reason: 'nonsense:only_emoji' });
    assert.equal(evaluateCustomTopic(topics, '', sc).kind, 'ignore');
  });

  test('decideAnswers: all accepted + done with a topic → approve; otherwise not', () => {
    const accepted = [
      { question_id: 'participate', reason: 'accepted_option', pass: 1 },
      { question_id: 'rules', reason: 'accepted_option', pass: 1 },
    ];
    const done = [row('toggle', 'castes'), row(TOPIC_ROW.done, 'selected:castes;custom:0')];
    assert.deepEqual(decideAnswers(sc.questions, [...accepted, ...done]), { approve: true });
    assert.deepEqual(decideAnswers(sc.questions, accepted), { approve: false, missing: 'topics' });
    assert.deepEqual(decideAnswers(sc.questions, [accepted[0], ...done]), { approve: false, missing: 'rules' });
    assert.equal(decideAnswers(sc.questions, [...accepted, row(TOPIC_ROW.done, 'selected:;custom:0')]).approve, false);
  });

  test('nonsense guard', () => {
    assert.equal(nonsenseReason('?!.....'), 'only_punctuation');
    assert.equal(nonsenseReason('аааааа'), 'repeated_char');
    assert.equal(nonsenseReason('Нормальная тема'), null);
  });
});
