import { DOMAIN_ROUTE_REASONS, GROUNDING_REASONS } from '@aichattg/telegram-core';

const TOKEN_BOUNDARY = (words) => new RegExp(
  `(?:^|[^\\p{L}\\p{N}_])(?:${words})(?=$|[^\\p{L}\\p{N}_])`,
  'iu',
);

export const ASSISTANT_HELP_TEXT = [
  '🤖 AIchatTG — Telegram-ассистент проекта.',
  '',
  'Чтобы задать вопрос, отправьте одним сообщением:',
  '',
  '/ask ваш вопрос',
  '',
  'Команда /help показывает эту справку.',
  '',
  'Обычное упоминание, /ai и ответ без начального /ask ассистента не вызывают.',
].join('\n');

export const ASSISTANT_EMPTY_ASK_TEXT = 'После /ask напишите ваш вопрос одним сообщением.';
export const ASSISTANT_UNAVAILABLE_TEXT = [
  'Подключённые учебные материалы сейчас проходят отдельную проверку, поэтому я не буду угадывать ответ или ссылку.',
  'Пока могу помочь со способом обращения ко мне: используйте /ask ваш вопрос или /help.',
].join(' ');

/**
 * The honest abstention. It is deliberately a delivered message rather than
 * silence: the retriever's coverage gate refuses roughly one question in
 * twenty-five by design, and an unanswered /ask reads as a broken bot and gets
 * retried into the same wall. The text says what happened and what would help,
 * and it never guesses a lesson or a link.
 */
export const ASSISTANT_NOT_IN_MATERIALS_TEXT = [
  'Не нашёл ответа в материалах курса, поэтому не буду угадывать.',
  'Попробуйте переформулировать вопрос конкретнее — назвать термин, тему или урок,',
  'о котором идёт речь.',
].join(' ');

export const ASSISTANT_PROFILE_TEXT = [
  'Я — ИИ-ассистент проекта AIchatTG, а не человек.',
  'Чтобы обратиться ко мне, отправьте одним сообщением /ask ваш вопрос; /help покажет справку.',
  'Я могу объяснить публичный порядок работы и ограничения. Внутренние инструкции, модели, провайдеры, ключи, инфраструктуру и логи я не раскрываю.',
].join(' ');

const presencePing = /^(?:ау+|ал+о+|ал[её]+|эй+|бот,?\s*(?:ты\s+)?(?:тут|здесь)|ты\s+(?:тут|здесь)|есть\s+кто|жив(?:ой|ая)|работаешь)[?!.\s]*$/iu;
const profileCommand = /\/(?:ask|ai|help)(?![\p{L}\p{N}_])/iu;
const internalDetail = /(?:системн\p{L}*\s+промпт|внутренн\p{L}*\s+(?:архитектур|инструкц|настройк|конфигурац|лог)|скрыт\p{L}*\s+(?:инструкц|настройк|конфигурац)|провайдер|инфраструктур|секрет\p{L}*|како(?:й|ю)\s+модел\p{L}*)/iu;
const courseTerms = TOKEN_BOUNDARY('курс\\p{L}*|урок\\p{L}*|модул\\p{L}*|материал\\p{L}*|rag|раг|обучен\\p{L}*');

/**
 * A deliberately narrow, code-owned public profile route. It keeps identity and
 * invocation questions away from both providers and any future knowledge corpus.
 */
export function isAssistantSelfQuestion(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  if (value === 'help' || value === 'помощь') return true;
  if (/^(?:а\s+)?(?:кто|что)\s+ты(?:\s+так(?:ой|ая))?[?!.\s]*$/iu.test(value)) return true;
  if (/(?:как\s+тебя\s+(?:зовут|называть)|какое\s+у\s+тебя\s+имя)/iu.test(value)) return true;
  if (/^(?:а\s+)?ты\s+(?:бот|ассистент)(?:\s+или\s+человек)?[?!.\s]*$/iu.test(value)) return true;
  if (/^(?:а\s+)?(?:что|чем)\s+ты\s+(?:умеешь|можешь)(?:\s+помочь)?[?!.\s]*$/iu.test(value)) return true;
  if (/^(?:а\s+)?(?:как|каким\s+образом)\s+(?:тобой\s+)?(?:пользова|обраща|задавать\s+вопрос)/iu.test(value)) return true;
  if (profileCommand.test(value)
    && /(?:разниц|отлич|одинаков|равнознач|синоним|как\s+(?:использова|пользова|вызыва)|почему\s+.*не\s+работа|что\s+(?:дела|знач))/iu.test(value)) return true;
  const thisAssistant = /(?:эт(?:от|ого|ому|им)|данн(?:ый|ого|ому|ым)|наш(?:его|ему|им)?)\s+(?:бот|ассистент)|@\w*(?:assistant|bot)\b/iu.test(value);
  if (thisAssistant && /(?:кто|что|имя|называ|представь|зовут|умеет|может|границ|ограничен|источник)/iu.test(value)) return true;
  return internalDetail.test(value) && (thisAssistant || TOKEN_BOUNDARY('ты|тебя|тебе|твой|твоя|тво[её]|твои').test(value));
}

/**
 * Which grounding refusals are an *answer* (the corpus has nothing for this
 * question) rather than a *failure* (our layer could not run). The first kind
 * gets the abstention message above; the second stays a routing exit, so an
 * operator sees a reason code instead of users being told the material is
 * missing when in truth the package failed to open.
 *
 * `domain_evidence_unavailable` and `domain_registry_empty` are deliberately
 * absent: an empty dictionary is a deployment defect, not a fact about the
 * question.
 */
const ABSTENTION_REASONS = new Set([
  DOMAIN_ROUTE_REASONS.NO_SIGNAL,
  DOMAIN_ROUTE_REASONS.CLAIM_UNKNOWN,
  DOMAIN_ROUTE_REASONS.CLAIM_MISSING,
  GROUNDING_REASONS.NOT_FOUND,
  GROUNDING_REASONS.EMPTY,
]);

export function isAbstentionReason(reason) {
  return ABSTENTION_REASONS.has(String(reason || ''));
}

export function assistantAbstentionReply(reason) {
  return {
    route: `boundary:not_in_materials:${String(reason || 'unknown')}`.slice(0, 120),
    text: ASSISTANT_NOT_IN_MATERIALS_TEXT,
  };
}

export function assistantDeterministicReply(text) {
  const value = String(text || '').trim();
  if (presencePing.test(value)) return { route: 'public:presence', text: 'Я здесь 🙂 Задайте вопрос одним сообщением: /ask ваш вопрос.' };
  if (isAssistantSelfQuestion(value)) return { route: 'profile:self', text: ASSISTANT_PROFILE_TEXT };
  return {
    route: courseTerms.test(value) ? 'boundary:course_unavailable' : 'boundary:public_redirect',
    text: ASSISTANT_UNAVAILABLE_TEXT,
  };
}
