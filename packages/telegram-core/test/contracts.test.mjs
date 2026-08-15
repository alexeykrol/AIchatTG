import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ASSISTANT_SOURCE_PACKAGES,
  admitKnowledgeSnapshot,
  BOT_ROLES,
  assistantDispositionForSafety,
  classifyTelegramUpdate,
  detectAssistantQuestion,
  detectTelegramLink,
  incomingEventId,
  isCourseOperationsSupportQuestion,
  isCourseValueQuestion,
  knowledgeManifestDigest,
  loadKnowledgeSnapshot,
  normalizeAssistantRoleRoute,
  normalizeSafetyClassification,
  planTelegramSafetyAction,
  TELEGRAM_SAFETY_POLICY_VERSION,
  validateKnowledgeManifest,
  WARNING_FIRST,
} from '../src/index.mjs';

const message = (text, extra = {}) => ({
  message_id: 8,
  chat: { id: -1001 },
  from: { id: 44, first_name: 'User', is_bot: false },
  text,
  ...extra,
});

test('assistant command recognition keeps the legacy leading-command contract', () => {
  assert.deepEqual(detectAssistantQuestion(message('/ask@assistant_bot  explain'), 'assistant_bot'), {
    isQuestion: true, reason: 'command', text: 'explain',
  });
  assert.equal(detectAssistantQuestion(message('/ask@other_bot explain'), 'assistant_bot').isQuestion, false);
  assert.equal(detectAssistantQuestion(message('before /ask explain'), 'assistant_bot').isQuestion, false);
  assert.equal(detectAssistantQuestion(message('/ask copied', { forward_origin: {} }), 'assistant_bot').isQuestion, false);
});

test('roles remain structurally isolated and message identities stay chat-scoped', () => {
  const update = { update_id: 5, message: message('/ask question') };
  const assistant = classifyTelegramUpdate({
    role: BOT_ROLES.ASSISTANT, update, acceptedChatIds: [-1001], botUsername: 'assistant_bot',
  });
  const moderator = classifyTelegramUpdate({ role: BOT_ROLES.MODERATOR, update, acceptedChatIds: [-1001] });
  assert.equal(assistant.kind, 'question');
  assert.equal(moderator.kind, 'comment');
  assert.equal(classifyTelegramUpdate({
    role: BOT_ROLES.ASSISTANT, update: { update_id: 6, message: message('plain') }, acceptedChatIds: [-1001],
  }).kind, 'skip');
  assert.equal(incomingEventId(BOT_ROLES.MODERATOR, update), 'moderator:5');
  assert.throws(() => incomingEventId(BOT_ROLES.MODERATOR, { update_id: -1 }), /update_id/);
});

test('a named synthetic bot reaches the Assistant while stronger bot barriers still win', () => {
  const fromBot = (id) => ({ update_id: 11, message: message('/ask question', { from: { id, first_name: 'Synthetic', is_bot: true } }) });
  const classify = (extra) => classifyTelegramUpdate({
    role: BOT_ROLES.ASSISTANT, acceptedChatIds: [-1001], botUsername: 'assistant_bot', ...extra,
  });
  const answered = classify({ update: fromBot(77), syntheticBotIds: ['77'] });
  assert.equal(answered.kind, 'question');
  assert.equal(answered.question.text, 'question');
  assert.equal(classify({ update: fromBot(78), syntheticBotIds: ['77'] }).reason, 'bot_sender');
  assert.equal(classify({ update: fromBot(77), syntheticBotIds: [], botId: null }).reason, 'bot_sender');
  // own_bot and exempt_bot are evaluated first and are not overridable.
  assert.equal(classify({ update: fromBot(77), syntheticBotIds: ['77'], botId: 77 }).reason, 'own_bot');
  assert.equal(classify({ update: fromBot(77), syntheticBotIds: ['77'], exemptBotIds: ['77'] }).reason, 'exempt_bot');
  // The Moderator side is untouched: a synthetic bot is still a plain comment.
  const moderated = classifyTelegramUpdate({
    role: BOT_ROLES.MODERATOR, update: fromBot(77), acceptedChatIds: [-1001], syntheticBotIds: ['77'],
  });
  assert.equal(moderated.kind, 'comment');
  assert.equal(moderated.comment.isBot, true);
});

test('only the Moderator classifies guarded-chat automatic pins as housekeeping', () => {
  const forwarded = {
    update_id: 9,
    message: message('channel post', { message_id: 71, is_automatic_forward: true }),
  };
  assert.deepEqual(classifyTelegramUpdate({
    role: BOT_ROLES.MODERATOR, update: forwarded, acceptedChatIds: [-1001],
  }), {
    kind: 'pin_governance',
    pin: { kind: 'unpin_auto_forward', chatId: '-1001', messageId: '71' },
  });
  assert.equal(classifyTelegramUpdate({
    role: BOT_ROLES.ASSISTANT, update: forwarded, acceptedChatIds: [-1001], botUsername: 'assistant_bot',
  }).kind, 'skip');

  const manualPin = {
    update_id: 10,
    message: message('', { message_id: 72, pinned_message: { message_id: 70 } }),
  };
  assert.deepEqual(classifyTelegramUpdate({
    role: BOT_ROLES.MODERATOR, update: manualPin, acceptedChatIds: [-1001],
  }), {
    kind: 'pin_governance',
    pin: { kind: 'remember_owner_pin', chatId: '-1001', messageId: '70' },
  });
  assert.equal(classifyTelegramUpdate({
    role: BOT_ROLES.MODERATOR, update: forwarded, acceptedChatIds: [-2002],
  }).reason, 'unknown_chat');
});

test('closed safety policy owns actions and Assistant access dispositions', () => {
  const weak = normalizeSafetyClassification({ safety_route: 'abuse', abuse_level: 'weak', confidence: 0.9, reason: 'fixture' });
  assert.deepEqual(planTelegramSafetyAction(weak, 0), {
    safetyRoute: 'abuse', abuseLevel: 'weak', strikeBefore: 0, strikeAfter: 1,
    policyVersion: TELEGRAM_SAFETY_POLICY_VERSION,
    verdict: 'suspect', action: 'delete_warn_1', warning: WARNING_FIRST,
  });
  const strong = planTelegramSafetyAction({ safetyRoute: 'abuse', abuseLevel: 'strong', confidence: 1 }, 2);
  assert.equal(strong.action, 'ban_purge');
  assert.deepEqual(assistantDispositionForSafety(strong), { status: 'blocked', verdict: 'ban' });
  assert.deepEqual(assistantDispositionForSafety(planTelegramSafetyAction({ safetyRoute: 'clean', confidence: 1 }, 2)), {
    status: 'allowed', verdict: 'clean',
  });
  assert.equal(normalizeSafetyClassification({ safetyRoute: 'clean', abuseLevel: 'weak', confidence: 1 }), null);
});

test('Telegram real-link signal keeps ordinary @mentions legal', () => {
  assert.equal(detectTelegramLink(message('@participant спасибо', {
    entities: [{ type: 'mention', offset: 0, length: 12 }],
  })), false);
  assert.equal(detectTelegramLink(message('посмотри https://example.test')), true);
  assert.equal(detectTelegramLink(message('канал', {
    entities: [{ type: 'text_link', offset: 0, length: 5, url: 'https://example.test' }],
  })), true);
  assert.equal(detectTelegramLink(message('not.me/fragment')), false);
  assert.equal(detectTelegramLink(message('t.me/example')), true);
});

test('course operations and course content use disjoint closed routing packages', () => {
  assert.deepEqual(normalizeAssistantRoleRoute({ action: 'support', sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS }), {
    action: 'support', sourceId: 'course-operations-v1',
  });
  assert.equal(normalizeAssistantRoleRoute({ action: 'support', sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT }), null);
  // Третий домен замкнут так же жёстко: advise открывает только value-срез.
  assert.deepEqual(normalizeAssistantRoleRoute({ action: 'advise', sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE }), {
    action: 'advise', sourceId: 'course-value-v1',
  });
  assert.equal(normalizeAssistantRoleRoute({ action: 'advise', sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT }), null);
  assert.equal(normalizeAssistantRoleRoute({ action: 'teach', sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE }), null);
  assert.deepEqual(normalizeAssistantRoleRoute({ action: 'redirect', sourceId: null }), { action: 'redirect', sourceId: null });
  assert.equal(isCourseOperationsSupportQuestion('В курсе как перейти к следующему уроку?'), true);
  assert.equal(isCourseOperationsSupportQuestion('В курсе какая цена?'), true);
  assert.equal(isCourseOperationsSupportQuestion('В курсе где чат участников?'), true);
  assert.equal(isCourseOperationsSupportQuestion('В курсе с чего начать?'), true);
  assert.equal(isCourseOperationsSupportQuestion('В курсе в каком порядке изучать модули по агентам?'), false);
});

// Восемь боевых вопросов, на которых прежний детектор молчал: он требовал
// буквального слова «курс», а операционный вопрос его почти никогда не содержит.
const OPERATIONS_QUESTIONS = [
  'есть у вас счёт для юрлица и акт потом. я через ООО плачу',
  'а если пятерых послать это сколько по деньгам',
  'у меня пропал доступ, что делать',
  'деньги с Трибьют списали, а подписка заблокирована',
  'переключите меня на живого агента поддержки',
  'сколько стоит и какие тарифы',
  'как поставить подписку на паузу',
  'какой у вас курс это закрывает и сколько по времени займёт',
];

test('operations questions are recognised without the literal word "курс"', () => {
  for (const question of OPERATIONS_QUESTIONS) {
    assert.equal(isCourseOperationsSupportQuestion(question), true, question);
  }
});

test('a methodological question about module order stays with course content', () => {
  assert.equal(isCourseOperationsSupportQuestion('в каком порядке изучать модули'), false);
  assert.equal(isCourseOperationsSupportQuestion('В каком порядке проходить модули по агентам?'), false);
});

test('teaching questions never reach the operations route', () => {
  for (const question of [
    'Что такое промптинг',
    'как работает RAG',
    'чем отличается агент от бота',
    'Где в курсе разбирается RAG?',
    // Названный чужой сервис: деньги в вопросе есть, но прайс не наш.
    'скок стоит клод код и можно ли им пользоваться без подписки на антропик?',
    'Я из России, как вообще зарегистрироваться в ChatGPT и оплатить подписку?',
  ]) {
    assert.equal(isCourseOperationsSupportQuestion(question), false, question);
  }
});

// Вопросы третьего домена — пригодность, польза, выбор, «некогда учиться».
// Формулировки взяты из живого диалога, а не выдуманы.
const VALUE_QUESTIONS = [
  'мне самой учиться некогда вообще ноль времени но я хочу понимать это лучше своих админов чтобы они мне лапшу не вешали',
  'зачем это мне как руководителю',
  'подойдёт ли мне ваш курс',
  'потяну ли я в 67 лет',
  'мне 67 лет, справлюсь ли',
  'с чего мне начать обучение',
  'какой курс выбрать для начала',
  'что я получу на выходе',
  'в каком порядке проходить курсы',
];

test('value questions about fit, benefit and course choice are recognised', () => {
  for (const question of VALUE_QUESTIONS) {
    assert.equal(isCourseValueQuestion(question), true, question);
  }
});

// Контракт порядка доменов: операционный детектор сильнее. Ни один из восьми
// боевых операционных вопросов не должен перехватываться value-детектором —
// ни на уровне самого детектора, ни в эффективной маршрутизации (ops первым).
test('the value detector never intercepts an operations question', () => {
  for (const question of OPERATIONS_QUESTIONS) {
    assert.equal(isCourseValueQuestion(question), false, question);
    assert.equal(
      isCourseValueQuestion(question) && !isCourseOperationsSupportQuestion(question),
      false,
      question,
    );
  }
});

test('a methodological question about module order stays out of the value domain too', () => {
  assert.equal(isCourseValueQuestion('в каком порядке изучать модули'), false);
  assert.equal(isCourseValueQuestion('В курсе в каком порядке изучать модули по агентам?'), false);
  // Пригодность инструмента — не пригодность себе: это содержательный вопрос.
  assert.equal(isCourseValueQuestion('подойдёт ли гит хаб для книги или статей, если я вообще не программист?'), false);
});

// Голд-сет — независимый источник истины: 190 заведомо содержательных вопросов.
// Если файла нет, тест обязан сказать об этом вслух, а не позеленеть молча.
test('the gold set of content questions produces zero false operations routings', (t) => {
  const goldPath = process.env.AICHATTG_CONTENT_GOLD_PATH
    || '/Users/alexeykrolmini/Code/allcourses/code/data/knowledge/packages/ai-887b1966234e/gold/ai.gold.jsonl';
  if (!existsSync(goldPath)) {
    t.skip(`gold set is not available at ${goldPath}`);
    return;
  }
  const questions = readFileSync(goldPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line).question)
    .filter(Boolean);
  assert.ok(questions.length >= 150, `gold set looks truncated: ${questions.length} questions`);
  const falsePositives = questions.filter((question) => isCourseOperationsSupportQuestion(question));
  assert.deepEqual(falsePositives, [], `content questions routed to operations: ${falsePositives.length}`);
  // Тот же независимый замер для третьего домена: содержательный вопрос не
  // имеет права уезжать в value-срез.
  const valueFalsePositives = questions.filter((question) => isCourseValueQuestion(question));
  assert.deepEqual(valueFalsePositives, [], `content questions routed to value: ${valueFalsePositives.length}`);
});

test('knowledge snapshots reject path escapes and accept only matching local digests', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-knowledge-'));
  try {
    const content = 'offline knowledge fixture';
    writeFileSync(join(folder, 'slice.md'), content);
    const manifest = {
      format: 'aichattg-knowledge-manifest-v1', sourceId: 'course-operations-v1', entries: [{
        id: 'operations', path: 'slice.md',
        sha256: createHash('sha256').update(content).digest('hex'),
        title: 'Fixture', canonicalUrl: 'https://example.test/fixture',
      }],
    };
    assert.deepEqual(validateKnowledgeManifest(manifest)?.entries.map(({ content: ignored, ...entry }) => entry), manifest.entries);
    assert.equal(loadKnowledgeSnapshot(manifest, folder)?.entries[0].content, content);
    const identity = {
      sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS,
      manifestDigest: knowledgeManifestDigest(manifest),
    };
    assert.equal(admitKnowledgeSnapshot({ manifest, root: folder, expectedIdentity: identity }).available, true);
    assert.equal(admitKnowledgeSnapshot({ manifest, root: folder, expectedIdentity: { ...identity, manifestDigest: '0'.repeat(64) } }).reason, 'knowledge_identity_mismatch');
    assert.equal(admitKnowledgeSnapshot({ manifest, root: folder, expectedIdentity: { sourceId: 'unreviewed-source', manifestDigest: identity.manifestDigest } }).reason, 'knowledge_identity_invalid');
    assert.equal(admitKnowledgeSnapshot({ manifest, root: folder }).reason, 'knowledge_identity_missing');
    assert.equal(validateKnowledgeManifest({ ...manifest, entries: [{ ...manifest.entries[0], path: '../News.db' }] }), null);
    assert.equal(validateKnowledgeManifest({ ...manifest, sourceId: 'unreviewed-source' }), null);
    assert.equal(loadKnowledgeSnapshot({ ...manifest, entries: [{ ...manifest.entries[0], sha256: '0'.repeat(64) }] }, folder), null);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
