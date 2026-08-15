import { createHash } from 'node:crypto';

export {
  admitKnowledgePackage,
  admitKnowledgeSnapshot,
  KNOWLEDGE_ALL_SOURCE_IDS,
  KNOWLEDGE_MANIFEST_FORMAT,
  KNOWLEDGE_PACKAGE_MANIFEST_FORMAT,
  KNOWLEDGE_PACKAGE_SOURCE_IDS,
  KNOWLEDGE_SOURCE_IDS,
  knowledgeManifestDigest,
  loadKnowledgePackage,
  loadKnowledgeSnapshot,
  validateKnowledgeManifest,
  validateKnowledgePackageManifest,
} from './knowledge.mjs';

export * from './domain.mjs';
export * from './grounding.mjs';
export * from './retrieval.mjs';
export * from './rewrite.mjs';
export * from './schema.mjs';

export const BOT_ROLES = Object.freeze({
  MODERATOR: 'moderator',
  ASSISTANT: 'assistant',
});

export const ASSISTANT_DISPOSITION_STATUSES = Object.freeze([
  'pending', 'allowed', 'blocked', 'error',
]);

export const ASSISTANT_SOURCE_PACKAGES = Object.freeze({
  COURSE_CONTENT: 'course-content-v1',
  COURSE_OPERATIONS: 'course-operations-v1',
  // Продукт и польза для роли: «зачем это мне», «подойдёт ли», «с чего начать».
  // Идёт тем же v1-путём снимка, что и операционный источник: срез мал и не
  // имеет ни чанков, ни словаря, поэтому ретриверу в нём искать нечего.
  COURSE_VALUE: 'course-value-v1',
  // Binary knowledge package (v2 manifest). It is admitted as a verified
  // database path, not as inlined entries, and the router never names it: the
  // domain veto decides whether a question may reach it.
  COURSE_KNOWLEDGE: 'course-knowledge-v2',
});

export const ASSISTANT_ROLE_ACTIONS = Object.freeze({
  TEACH: 'teach',
  NAVIGATE: 'navigate',
  SUPPORT: 'support',
  // Совет о пригодности и выборе: единственное действие с доступом к value-срезу.
  ADVISE: 'advise',
  REDIRECT: 'redirect',
});

// Code-owned deployed safety policy: model output may describe a route and
// severity, but it never chooses text, strikes, deletions, or bans.
export const TELEGRAM_SAFETY_POLICY_VERSION = 'telegram-safety-v1';
export const WARNING_FIRST =
  'Сообщение удалено за нарушение правил общения. Решения модератора не обсуждаются '
  + 'и не обжалуются. Повторное нарушение или попытка продолжить спор приведёт к '
  + 'последнему предупреждению.';
export const WARNING_FINAL =
  'Это второе и последнее предупреждение. Следующее нарушение или продолжение '
  + 'спора приведёт к немедленной блокировке.';

const ROLE_SET = new Set(Object.values(BOT_ROLES));
const ASSISTANT_DISPOSITION_SET = new Set(ASSISTANT_DISPOSITION_STATUSES);
const ASSISTANT_ROLE_ACTION_SET = new Set(Object.values(ASSISTANT_ROLE_ACTIONS));
const ASSISTANT_CMD_RE = /^\s*\/(ask|help)(?:@([A-Za-z0-9_]+))?(?:\s+|$)/i;
const QUOTED_LITERAL_ENTITY_TYPES = new Set([
  'blockquote', 'expandable_blockquote', 'code', 'pre', 'pre_code',
]);
// Telegram `mention` entities are deliberately not links: a person may address
// another participant without triggering the hard link policy.  Entities are
// authoritative when present; this narrow fallback covers normal URLs, t.me
// links and Telegram deep links when clients omit entity metadata.
const TELEGRAM_LINK_RE = /(?<![\p{L}\p{N}_])(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|tg:\/\/)/iu;
const SERVICE_FIELDS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
  'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'channel_chat_created', 'message_auto_delete_timer_changed', 'pinned_message',
  'migrate_to_chat_id', 'migrate_from_chat_id',
];

export function assertBotRole(role) {
  if (!ROLE_SET.has(role)) throw new Error(`unsupported Telegram bot role: ${role}`);
  return role;
}

export function botIdFromToken(token) {
  const id = String(token || '').split(':')[0].trim();
  return /^\d+$/.test(id) ? id : null;
}

function isForwardedMessage(message) {
  return Boolean(
    message.forward_origin || message.forward_date || message.forward_from || message.forward_from_chat,
  );
}

function isLiteralEntityAt(message, offset) {
  const entities = [...(message.entities || []), ...(message.caption_entities || [])];
  return entities.some((entity) => (
    entity
    && QUOTED_LITERAL_ENTITY_TYPES.has(entity.type)
    && Number.isInteger(entity.offset)
    && Number.isInteger(entity.length)
    && offset >= entity.offset
    && offset < entity.offset + entity.length
  ));
}

/**
 * Exact legacy invocation semantics, extracted from the immutable source object:
 * only leading /ask and /help commands are accepted, optional @bot suffixes must
 * name this bot, and forwarded or literal-quoted commands are ignored.
 */
export function detectAssistantQuestion(message, botUsername = '') {
  const raw = message?.text || message?.caption || '';
  if (!raw || isForwardedMessage(message)) return { isQuestion: false, reason: null, text: '' };
  const command = raw.match(ASSISTANT_CMD_RE);
  if (!command) return { isQuestion: false, reason: null, text: '' };
  const commandOffset = raw.indexOf('/', command.index || 0);
  if (isLiteralEntityAt(message, commandOffset)) return { isQuestion: false, reason: null, text: '' };

  const expectedUsername = String(botUsername || '').replace(/^@/, '').toLowerCase();
  const targetUsername = command[2] || null;
  if (targetUsername && (!expectedUsername || targetUsername.toLowerCase() !== expectedUsername)) {
    return { isQuestion: false, reason: null, text: '' };
  }
  if (command[1].toLowerCase() === 'help') {
    return { isQuestion: true, reason: 'command', text: '', isHelpCommand: true };
  }
  return { isQuestion: true, reason: 'command', text: raw.slice(command[0].length).trim() };
}

export function incomingEventId(role, update) {
  assertBotRole(role);
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
    throw new Error('Telegram update_id must be a non-negative safe integer');
  }
  return `${role}:${update.update_id}`;
}

/**
 * Code-owned Telegram link signal for the Guard safety policy.  Only a URL or
 * text_link entity is a link; an @mention remains ordinary conversation.
 */
export function detectTelegramLink(message) {
  const entities = [...(message?.entities || []), ...(message?.caption_entities || [])];
  if (entities.some((entity) => entity && (entity.type === 'url' || entity.type === 'text_link'))) return true;
  return TELEGRAM_LINK_RE.test(`${message?.text || ''}\n${message?.caption || ''}`);
}

export function messageFromUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const message = update.message || update.edited_message;
  if (!message || !message.chat || message.message_id == null) return null;
  return message;
}

export function messageIdentity(message, update) {
  const chatId = String(message.chat.id);
  const messageId = String(message.message_id);
  const revision = update.edited_message
    ? `edit:${Number.isSafeInteger(update.update_id) ? update.update_id : createHash('sha256')
      .update(JSON.stringify([message.edit_date ?? null, message.text ?? null, message.caption ?? null]))
      .digest('hex').slice(0, 16)}:`
    : '';
  return {
    chatId,
    messageId,
    platformMessageId: `${chatId}:${revision}${messageId}`,
    userId: message.from?.id == null ? null : String(message.from.id),
    text: message.text || message.caption || '',
  };
}

function isServiceMessage(message) {
  return SERVICE_FIELDS.some((field) => field in message);
}

/**
 * Telegram automatically pins posts forwarded from a linked channel.  The
 * deployed Moderator treats that as housekeeping, not as a comment: remove
 * the automatic pin, but never disturb a human or anonymous-admin pin.  Keep
 * the native target here (rather than deriving it from a corpus id) so the
 * runtime always acts on the exact chat and message Telegram supplied.
 */
function pinGovernanceAction(message) {
  const chatId = String(message.chat.id);
  const pinned = message.pinned_message;
  if (pinned) {
    if (pinned.message_id == null) return { kind: 'skip', reason: 'invalid_pinned_message' };
    if (pinned.is_automatic_forward) {
      return { kind: 'unpin_auto_forward', chatId, messageId: String(pinned.message_id) };
    }
    return { kind: 'remember_owner_pin', chatId, messageId: String(pinned.message_id) };
  }
  if (message.is_automatic_forward) {
    return { kind: 'unpin_auto_forward', chatId, messageId: String(message.message_id) };
  }
  return null;
}

/**
 * Preserve the two-bot structural split: an Assistant can never classify a
 * moderation comment and a Moderator can never classify an assistant question.
 *
 * `syntheticBotIds` is a separate list from `exemptBotIds` on purpose: the two
 * carry opposite meanings (answer this bot vs. ignore this bot), and collapsing
 * them once already produced a wrong classification. Own-bot and exempt checks
 * run first so a synthetic id can never re-enable the Assistant's own echo or
 * override an explicit ignore.
 */
export function classifyTelegramUpdate({
  role,
  update,
  acceptedChatIds = [],
  botUsername = '',
  botId = null,
  exemptBotIds = [],
  syntheticBotIds = [],
}) {
  assertBotRole(role);
  const message = messageFromUpdate(update);
  if (!message) return { kind: 'skip', reason: 'unsupported_update' };
  const identity = messageIdentity(message, update);
  if (!new Set(acceptedChatIds.map(String)).has(identity.chatId)) {
    return { kind: 'skip', reason: 'unknown_chat' };
  }
  if (message.from?.is_bot && new Set(exemptBotIds.map(String)).has(String(message.from.id))) {
    return { kind: 'skip', reason: 'exempt_bot' };
  }

  if (role === BOT_ROLES.ASSISTANT) {
    if (botId != null && String(message.from?.id) === String(botId)) {
      return { kind: 'skip', reason: 'own_bot' };
    }
    const isSyntheticSender = message.from?.is_bot
      && new Set(syntheticBotIds.map(String)).has(String(message.from.id));
    if (message.from?.is_bot && !isSyntheticSender) return { kind: 'skip', reason: 'bot_sender' };
    const question = detectAssistantQuestion(message, botUsername);
    if (!question.isQuestion) return { kind: 'skip', reason: 'not_assistant_command' };
    return {
      kind: 'question',
      question: {
        ...identity,
        authorName: message.from?.first_name || null,
        username: message.from?.username || null,
        command: question.isHelpCommand ? 'help' : 'ask',
        text: question.text,
      },
    };
  }

  // Only the Moderator owns the guard token and can perform pin
  // housekeeping.  This is deliberately before text/service-message
  // classification: Telegram pin updates do not normally contain user text.
  const pinAction = pinGovernanceAction(message);
  if (pinAction) {
    if (pinAction.kind === 'skip') return pinAction;
    return { kind: 'pin_governance', pin: pinAction };
  }

  if (botId != null && String(message.from?.id) === String(botId)) {
    return { kind: 'skip', reason: 'own_bot' };
  }

  if (!identity.text.trim()) {
    return { kind: 'skip', reason: isServiceMessage(message) ? 'service_message' : 'no_text' };
  }
  return {
    kind: 'comment',
    comment: {
      ...identity,
      authorName: message.from?.first_name || null,
      username: message.from?.username || null,
      isBot: Boolean(message.from?.is_bot),
      senderChatId: message.sender_chat?.id == null ? null : String(message.sender_chat.id),
      hasLink: detectTelegramLink(message),
    },
  };
}

export function normalizeModerationVerdict(value) {
  if (!value || typeof value !== 'object') return null;
  const verdict = String(value.verdict || '');
  if (!['clean', 'suspect', 'ban'].includes(verdict)) return null;
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return {
    verdict,
    confidence,
    reason: String(value.reason || ''),
    quote: String(value.quote || ''),
    modelId: value.modelId == null ? null : String(value.modelId),
  };
}

/**
 * Validate the provider-neutral safety result before any Telegram action is
 * planned. The provider may classify meaning, but it never selects a platform
 * action or an Assistant disposition.
 */
export function normalizeSafetyClassification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safetyRoute = String(value.safetyRoute ?? value.safety_route ?? '');
  if (!['clean', 'abuse', 'threat'].includes(safetyRoute)) return null;
  const abuseLevel = value.abuseLevel ?? value.abuse_level ?? null;
  if (safetyRoute === 'abuse' && !['weak', 'strong'].includes(abuseLevel)) return null;
  if (safetyRoute !== 'abuse' && abuseLevel != null) return null;
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return {
    safetyRoute,
    abuseLevel: abuseLevel == null ? null : String(abuseLevel),
    confidence,
    reason: String(value.reason || ''),
    quote: String(value.quote || ''),
    modelId: value.modelId == null ? null : String(value.modelId),
  };
}

/** Deterministic policy copied as behavior, not as a provider prompt. */
export function planTelegramSafetyAction(classification, currentWeakStrikes = 0) {
  const decision = normalizeSafetyClassification(classification);
  if (!decision) throw new Error('invalid_safety_classification');
  const strikeBefore = Math.max(0, Number.parseInt(currentWeakStrikes, 10) || 0);
  const common = {
    safetyRoute: decision.safetyRoute,
    abuseLevel: decision.abuseLevel,
    strikeBefore,
    strikeAfter: strikeBefore,
    policyVersion: TELEGRAM_SAFETY_POLICY_VERSION,
  };
  if (decision.safetyRoute === 'clean') {
    return { ...common, verdict: 'clean', action: 'none', warning: null };
  }
  if (decision.safetyRoute === 'threat' || decision.abuseLevel === 'strong') {
    return { ...common, verdict: 'ban', action: 'ban_purge', warning: null };
  }
  const strikeAfter = strikeBefore + 1;
  if (strikeAfter === 1) {
    return { ...common, verdict: 'suspect', action: 'delete_warn_1', warning: WARNING_FIRST, strikeAfter };
  }
  if (strikeAfter === 2) {
    return { ...common, verdict: 'suspect', action: 'delete_warn_2', warning: WARNING_FINAL, strikeAfter };
  }
  return { ...common, verdict: 'ban', action: 'ban_purge', warning: null, strikeAfter };
}

export function assistantDispositionForSafety(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('safety_plan_required');
  if (plan.verdict === 'clean') return { status: 'allowed', verdict: 'clean' };
  if (plan.verdict === 'suspect' || plan.verdict === 'ban') {
    return { status: 'blocked', verdict: plan.verdict };
  }
  throw new Error('safety_plan_verdict_invalid');
}

export function normalizeAssistantDisposition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = String(value.status || '');
  if (!ASSISTANT_DISPOSITION_SET.has(status)) return null;
  const verdict = value.verdict == null ? null : String(value.verdict);
  if (status === 'allowed' && !['clean', 'exempt'].includes(verdict)) return null;
  if (status === 'blocked' && !['suspect', 'ban'].includes(verdict)) return null;
  return {
    status,
    verdict,
    reason: value.reason == null ? null : String(value.reason),
    moderationMessageId: value.moderationMessageId == null ? null : String(value.moderationMessageId),
    moderationEventId: value.moderationEventId == null ? null : String(value.moderationEventId),
  };
}

/**
 * A closed routing contract keeps course operations separate from course content.
 * Redirect intentionally has no source package and can never unlock a knowledge
 * snapshot by accident.
 */
export function normalizeAssistantRoleRoute(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = String(value.action || '');
  if (!ASSISTANT_ROLE_ACTION_SET.has(action)) return null;
  const sourceId = value.sourceId ?? value.source_id ?? null;
  const requiredSource = action === ASSISTANT_ROLE_ACTIONS.SUPPORT
    ? ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS
    : action === ASSISTANT_ROLE_ACTIONS.ADVISE
      ? ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE
      : action === ASSISTANT_ROLE_ACTIONS.TEACH || action === ASSISTANT_ROLE_ACTIONS.NAVIGATE
        ? ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT
        : null;
  if (requiredSource == null) return sourceId == null ? { action, sourceId: null } : null;
  return sourceId === requiredSource ? { action, sourceId: requiredSource } : null;
}

/**
 * Кириллица не покрывается `\b` — он ASCII-only, поэтому `/\bооо\b/` не находит
 * «ООО» и правило тихо мертво. Границы слова задаются явно, иначе подстроки
 * ловят чужие слова: «почем» в «почему», «списан» в «расписаны», «договор» в
 * «договорились» — ровно так рождаются ложные срабатывания.
 */
const OPS_LETTER = '[a-zа-я0-9]';
const OPS_BEFORE = `(?<!${OPS_LETTER})`;
const OPS_AFTER = `(?!${OPS_LETTER})`;
const opsRx = (body) => new RegExp(body, 'u');

// Собственный биллинг и документы: этих слов не бывает в вопросе про материал.
const OPS_BILLING = opsRx(`(?:юрлиц|юр\\.? ?лиц|${OPS_BEFORE}ооо${OPS_AFTER}|${OPS_BEFORE}ип${OPS_AFTER}|бухгалтер|счет-фактур|${OPS_BEFORE}счет[а-я]*(?: |$)|выставить счет|${OPS_BEFORE}акт(?:ом|а|ы)?${OPS_AFTER}|${OPS_BEFORE}договор(?:а|у|ом|е|ы|ов)?${OPS_AFTER}|инвойс|реквизит|безнал|оферт|промокод|рассрочк|автопродлен|автоплатеж|трибьют|tribute|${OPS_BEFORE}списал[а-я]*${OPS_AFTER}|${OPS_BEFORE}списан[а-я]*${OPS_AFTER}|вернуть деньг|возврат[а-я]*${OPS_AFTER}|рефанд|${OPS_BEFORE}чек(?:а|и|ом)?${OPS_AFTER}(?=[^.!?]{0,40}(?:оплат|платеж|курс|покупк|заказ|подписк))|(?:оплат|платеж|покупк|заказ|подписк)[а-я]{0,20}[^.!?]{0,20}${OPS_BEFORE}чек(?:а|и|ом)?${OPS_AFTER})`);
const OPS_SUBSCRIPTION = opsRx('(?:подписк|тариф|на сколько (?:даетс|дают|выдаетс).{0,25}доступ|надолго ли доступ|доступ навсегда|автопродлен|продлен|отмен(?:ить|а|у) (?:подписк|автоплат)|на паузу|паузу|приостанов|заморозить|срок доступ|пожизненн)');
const OPS_ACCOUNT = opsRx(`(?:личн(?:ый|ом|ого) кабинет|${OPS_BEFORE}кабинет[а-я]*${OPS_AFTER}|мои курсы|мой аккаунт|аккаунт|логин|пароль|залогин|перелогин|мой email|каким email|каком email)`);
const OPS_ACCESS = opsRx('(?:пропал доступ|нет доступа|потерял доступ|доступ (?:закрыт|заблокирован|не открыл|не появил)|не могу (?:войти|зайти|попасть)|не пускает|заблокирован|оплатил.{0,40}(?:курса нет|нет курса|не открыл|не появил|не пришл|не дали))');
const OPS_HUMAN = opsRx(`(?:живо(?:го|му|й) (?:человек|агент|оператор|специалист|поддержк)|переключит[ье]|соединит[ье]|связаться с поддержк|написать в поддержк|контакт[ыа]? поддержк|техподдержк|саппорт|служб[аыу] поддержк|${OPS_BEFORE}поддержк[аиуе]${OPS_AFTER})`);
const OPS_CERTIFICATE = opsRx('(?:сертификат|диплом|удостоверен|отметк[аи] о прохожден|проверя(?:ет|ют).{0,25}(?:домашн|задан)|куратор)');
const OPS_POST_PURCHASE = opsRx('(?:оплатил|оплатила|купил|купила|приобрел).{0,40}(?:куда|где|как|что дальше|не |нет )|на какой email (?:покупал|регистрир)|каким email (?:покупал|регистрир)|где (?:открывается|открыть) (?:купленн|оплаченн)|куда теперь (?:заходить|идти)');
// Сбой самой платформы обучения. «Тормозит» требует названного объекта: без него
// это чаще про чужую сессию или инструмент, а не про наш плеер.
const OPS_PLATFORM_FAULT = opsRx(`(?:ошибка 404|${OPS_BEFORE}404${OPS_AFTER}|не открывается|не открывает|не грузит|не загружает|не играет|не воспроизвод|не работает (?:плеер|видео|урок|ссылк|кнопк|сайт)|(?:видео|плеер|урок|сайт|страница).{0,20}тормозит|битая ссылк|битые ссылк|нет звука|буферизу|${OPS_BEFORE}плеер|не срабатывает отметк|прогресс не сохран|не сохраняется прогресс)`);
const OPS_COMMUNITY = opsRx('(?:чат участник|есть чат|где чат|общий чат|телеграм-канал|телеграм канал|дискорд|discord|сообществ|(?:где|как).{0,20}(?:скачать|взять|найти|лежат).{0,20}материал|материал[ыа]? к уроку|блюпринт|запис[ьи].{0,15}(?:вебинар|эфир|стрим)|когда появится запись|рассылк|письмо не приход|не приходит письм|попадает в спам|на каком языке)');
const OPS_PRICE = opsRx(`(?:сколько сто|скольк[оа].{0,25}по деньгам|по деньгам|как(?:ая|ие|ой|ую) цен|${OPS_BEFORE}цен[аыу]${OPS_AFTER}|стоимост|${OPS_BEFORE}прайс|расценк|сколько платить|сколько это будет|во сколько обойдет|${OPS_BEFORE}оплат[аиуеы]${OPS_AFTER}|оплатить|заплатить|${OPS_BEFORE}платеж|скидк|предоплат|доплат)`);
const OPS_DURATION = opsRx('(?:сколько (?:по )?времени|как долго|сколько (?:длит|занимает|идет|часов|недел|месяц)|за какой срок|срок обучен)');
const OPS_VENDOR_ADDRESSED = opsRx(`(?:${OPS_BEFORE}у вас${OPS_AFTER}|${OPS_BEFORE}у тебя${OPS_AFTER}|${OPS_BEFORE}ваш[а-я]*${OPS_AFTER}|${OPS_BEFORE}вам${OPS_AFTER})`);
// Названный чужой сервис снимает вопрос с нашей операционки: «сколько стоит
// Claude Code» — учебная тема, а не наш прайс.
const OPS_THIRD_PARTY = opsRx(`(?:chatgpt|chat ?gpt|джипити|${OPS_BEFORE}gpt${OPS_AFTER}|клод|claude|grok|грок|sora|midjourney|ollama|${OPS_BEFORE}make${OPS_AFTER}|мейк|мэйк|n8n|н8н|airtable|zapier|openai|антропик|anthropic|${OPS_BEFORE}api${OPS_AFTER}|paypal|github|гитхаб|reddit|сабреддит|perplexity|gemini|джемини|deepseek|яндекс|алис[аеу]|copilot|cursor|vercel|netlify|supabase|firebase|нейросет|локальн[а-я]* модел|витамин|двигател|масло|выложить (?:первый )?сайт)`);
const OPS_CONTENT_INTENT = opsRx('(?:что такое|чем отличается|в чем разница|как работает|как устроен|объясни|расскажи про|зачем нужен|что лучше|как настроить|как сделать|как собрать|как написать|посоветуй|где (?:в курсе|в уроке|разбирается|показыв|рассказыв|скачивать|найти)|в каком (?:уроке|модуле|порядке)|как понять|почему)');
const OPS_IN_COURSE = opsRx('(?:(?:^|[^а-я])(?:в|на) курсе|(?:^|[^а-я])в курс[а-я]*(?![а-я]))');
const OPS_COURSE_MECHANICS = opsRx('(?:как (?:перейти|переходить|открыть|открывать)|следующ(?:ий|ему) урок|между урок|какие кнопки|куда нажать|куда нажимать|интерфейс|с чего начать|как проходить|как фиксируется прогресс|где чат|чат участник|сообществ|как пользоваться сайтом)');
const OPS_COURSE_MECHANICS_BARE = opsRx('(?:как проходить курс|как (?:мне )?проходить(?: этот)? курс|переходить между урок|перейти между урок|не могу понять интерфейс|не понимаю интерфейс|как проходить обучение)');

/**
 * Разделяет вопрос об эксплуатации курса (деньги, доступ, аккаунт, подписка,
 * документы, сбой платформы, просьба о человеке) и вопрос об учебном материале.
 * Критерии взяты из проверенного в бою орг-реестра (7 тем), а не выдуманы;
 * порог настроен по факту: восемь боевых операционных вопросов распознаются,
 * на голд-сете из 190 содержательных — ноль ложных срабатываний.
 * Это граница безопасности: неоднозначная фраза остаётся у маршрутизатора
 * провайдера и не получает доступ к содержанию курса молча.
 */
export function isCourseOperationsSupportQuestion(text) {
  const normalized = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  // A requested order for studying named modules is a methodological/content
  // question, not a support request about operating the course interface.
  if (/в каком порядке.{0,80}(?:изуч|проход).{0,80}модул/u.test(normalized)) return false;

  const ourBusiness = OPS_BILLING.test(normalized) || OPS_ACCOUNT.test(normalized)
    || OPS_ACCESS.test(normalized) || OPS_HUMAN.test(normalized)
    || OPS_CERTIFICATE.test(normalized) || OPS_POST_PURCHASE.test(normalized)
    || OPS_PLATFORM_FAULT.test(normalized);
  const mechanics = (OPS_IN_COURSE.test(normalized) && OPS_COURSE_MECHANICS.test(normalized))
    || OPS_COURSE_MECHANICS_BARE.test(normalized);
  const community = OPS_COMMUNITY.test(normalized);
  const subscription = OPS_SUBSCRIPTION.test(normalized);
  const money = OPS_PRICE.test(normalized);
  const duration = OPS_DURATION.test(normalized) && OPS_VENDOR_ADDRESSED.test(normalized);

  if (!ourBusiness && !mechanics && !community && !subscription && !money && !duration) return false;
  if (OPS_THIRD_PARTY.test(normalized)) return false;
  if (mechanics || ourBusiness) return true;
  // Вопрос одновременно о цене и о содержании остаётся операционным по денежной
  // части — это ровно та поломка, из-за которой оргвопрос уезжал в смежный урок.
  if (money) return true;
  // Ссылка на чат, материалы и рассылку лежит в самих материалах курса, поэтому
  // такой вопрос отдаётся содержанию, кроме явной механики «в курсе где чат».
  if (community) return OPS_IN_COURSE.test(normalized) && !OPS_CONTENT_INTENT.test(normalized);
  if (OPS_CONTENT_INTENT.test(normalized)) return false;
  return true;
}

// Пригодность вопрошающему лично: «подойдёт ли МНЕ», не «подойдёт ли GitHub» —
// без себя-референции это содержательный вопрос об инструменте (голд-сет).
const VALUE_SUITABILITY = opsRx(`(?:подойдет ли (?:мне|нам|для меня)|(?:мне|для меня) (?:это |такое |он |она )?подойдет|для меня ли|потяну ли|справлюсь ли|осилю ли|смогу ли я (?:освоить|пройти|потянуть|справиться|осилить)|мне \\d{2,3} (?:лет|год(?:а|ов)?)|в моем возрасте|не поздно ли (?:мне )?(?:начинать|учиться|осваивать))`);
const VALUE_BENEFIT = opsRx('(?:зачем (?:это |оно |все это )?мне|что я (?:получу|буду уметь)|что (?:мне|это мне|мне это) (?:даст|дает)|что даст (?:мне|этот курс мне)|что (?:я )?получу на выходе|в чем (?:смысл|польза) (?:этого )?для меня|какая (?:мне|для меня) (?:от этого )?польза)');
// Выбор курса и старт обучения. «Курсы», не «модули»: порядок модулей внутри
// курса закреплён как содержательный вопрос, и сюда он попадать не должен.
const VALUE_CHOICE = opsRx('(?:какой курс (?:мне |нам |лучше |из них )?(?:выбрать|подойдет|подходит|взять|брать|нужен)|с какого курса (?:мне |нам )?начать|в каком порядке (?:мне |нам )?(?:проходить|изучать|брать) (?:ваши )?курсы|с чего (?:мне |нам )?начать (?:обучение|учиться|учебу))');
// Вера в волшебную пилюлю: «учиться некогда, но хочу понимать». Ловится сама
// формула отказа от учёбы при желании контролировать — ядро value-диалога.
const VALUE_NO_TIME = opsRx('(?:(?:мне |сам(?:ому|ой) |совсем |вообще )*некогда (?:мне )?учиться|учиться (?:мне |сам(?:ому|ой) |совсем |вообще )*некогда|нет времени (?:на )?(?:курс|обучение|учебу|учиться)|(?:нет|ноль) времени[^.!?]{0,25}(?:учит|курс|обучен)|не хочу (?:сам[аи]? )?(?:учиться|разбираться|проходить курс)[^.!?]{0,40}(?:но|а) (?:хочу|надо|нужно)|понимать[^.!?]{0,40}лучше (?:своих|моих)|лапшу не вешали|не вешали лапшу|не (?:вешал[аи]?|навешал[аи]?) (?:мне )?лапшу)');
// Делегирование обучения в команде: «кто у нас должен это тянуть, кому
// поручить, нанимать ли отдельного человека». Вопрос о том, КОМУ учиться и
// внедрять, — та же пригодность, только про сотрудника, а не про себя.
// Найдено живым прогоном ent-01 ход 4: детектор без этой группы молчал.
const VALUE_DELEGATION = opsRx('(?:кто[^.!?]{0,40}долж(?:ен|на|ны)[^.!?]{0,25}(?:тянуть|занимать|осваивать|внедрять|этим занимать)|кому[^.!?]{0,15}(?:поручить|доверить)[^.!?]{0,35}(?:это|агент|автоматизаци|курс|обучени|внедрени)|кому (?:это |такое )?поручить|нанимать[^.!?]{0,25}отдельн|отдельного (?:человека|специалиста)[^.!?]{0,15}нанимать|справится ли (?:с этим )?(?:мой |наш |у нас )?(?:админ|сотрудник|менеджер|маркетолог|помощник)|кто из (?:команды|сотрудников|моих людей)[^.!?]{0,35}(?:долж|смож|потян|учит|проход|осво))');

/**
 * Третий домен: продукт и польза для роли. Отделяет вопрос о ПРИГОДНОСТИ И
 * ПОЛЬЗЕ («зачем мне», «потяну ли», «какой курс выбрать», «некогда учиться, но
 * хочу понимать») от учебного материала. Контракт порядка: операционный
 * детектор сильнее (деньги/доступ/документы), поэтому маршрутизатор обязан
 * спросить `isCourseOperationsSupportQuestion` первым; этот детектор — вторым;
 * содержание — по умолчанию. Порог настроен по факту: на голд-сете из 190
 * содержательных вопросов — ноль ложных срабатываний.
 */
export function isCourseValueQuestion(text) {
  const normalized = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return VALUE_SUITABILITY.test(normalized) || VALUE_BENEFIT.test(normalized)
    || VALUE_CHOICE.test(normalized) || VALUE_NO_TIME.test(normalized)
    || VALUE_DELEGATION.test(normalized);
}

// «Не хочу разбираться/вникать» без продолжения «но хочу» — VALUE_NO_TIME такое
// не ловит намеренно (для маршрутизации нужна полная формула отказа+желания),
// а для метки в журнале дефицитов достаточно самой посылки.
const PILL_REFUSAL = opsRx('(?:не хочу (?:сам[аи]? |ничего |в это )?(?:учиться|разбираться|вникать)|без (?:учебы|обучения|курсов)[^.!?]{0,30}(?:хочу|можно|обойтись))');

/**
 * Узкий сигнал «пилюли» (некогда/не хочу учиться, но хочу результат) для метки
 * Л3 в журнале дефицитов. Это НЕ маршрутизатор: value-детектор выше перехватит
 * такие вопросы раньше; сюда доходят только непойманные формулировки.
 */
export function isNoTimeToLearnSignal(text) {
  const normalized = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return VALUE_NO_TIME.test(normalized) || PILL_REFUSAL.test(normalized);
}
