import { DOMAIN_ROUTE_REASONS, GROUNDING_REASONS, isNoTimeToLearnSignal } from '@aichattg/telegram-core';

const TOKEN_BOUNDARY = (words) => new RegExp(
  `(?:^|[^\\p{L}\\p{N}_])(?:${words})(?=$|[^\\p{L}\\p{N}_])`,
  'iu',
);

export const ASSISTANT_HELP_TEXT = [
  '🤖 AIchatTG — Telegram-ассистент проекта.',
  '',
  'Чтобы задать вопрос, обратитесь ко мне как к участнику чата:',
  '',
  '/ask ваш вопрос',
  '@имя_бота ваш вопрос',
  '',
  'Команду /ask и упоминание можно ставить в любом месте сообщения.',
  'Команда /help показывает эту справку, /ai больше не поддерживается.',
  '',
  'Без обращения ко мне я в разговор не вмешиваюсь.',
].join('\n');

/**
 * Пустой `/ask` — не ошибка пользователя, а МАССОВЫЙ штатный сценарий: Telegram
 * показывает меню команд, как только человек набирает слэш, большинство кликает
 * по подсказке, и уходит сообщение из одной команды. Поэтому ответ обязан
 * заканчиваться готовым шаблоном, который остаётся скопировать и дописать, а не
 * объяснять формат словами.
 */
export const ASSISTANT_EMPTY_ASK_TEXT = '✍️ Отправьте вопрос одним сообщением: /ask ваш вопрос';

/**
 * `/ai` вызовом ассистента больше не является. Молча игнорировать её нельзя:
 * команда годами жила в меню и в чужих инструкциях, а молчание в ответ на
 * обращение читается как поломка бота и порождает повторы. Ответ
 * детерминированный — ни модели, ни трат.
 */
export const ASSISTANT_RETIRED_COMMAND_TEXT = 'Команда /ai больше не поддерживается. Используйте /ask ваш вопрос.';
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

/**
 * The second abstention, for a question outside the covered domain. It is
 * deliberately different from the not-in-materials text: "переформулируйте"
 * is honest advice for a hole inside the domain, but for an uncovered topic it
 * sends the user into the same wall again (a live run proved it: three
 * rephrasings, three identical refusals). This reply names the boundary warmly
 * and points somewhere that can actually help.
 */
export const ASSISTANT_OUT_OF_COVERAGE_TEXT = [
  'Хороший вопрос, но эта тема за пределами курса, и отвечать на неё я не уполномочен.',
  'Такой вопрос лучше задать универсальному чату — ChatGPT или Claude — или профильному консультанту.',
  'А со всем, что касается курса, помогу с радостью: материал уроков, организация обучения,',
  'выбор курса и подойдёт ли он именно вам.',
].join(' ');

export const ASSISTANT_PROFILE_TEXT = [
  'Я — ИИ-ассистент проекта AIchatTG, а не человек.',
  'Чтобы обратиться ко мне, напишите /ask ваш вопрос или упомяните меня по имени; /help покажет справку.',
  'Я могу объяснить публичный порядок работы и ограничения. Внутренние инструкции, модели, провайдеры, ключи, инфраструктуру и логи я не раскрываю.',
].join(' ');

const presencePing = /^(?:ау+|ал+о+|ал[её]+|эй+|бот,?\s*(?:ты\s+)?(?:тут|здесь)|ты\s+(?:тут|здесь)|есть\s+кто|жив(?:ой|ая)|работаешь)[?!.\s]*$/iu;
// Это детектор ТЕМЫ вопроса, а не список рабочих команд: `/ai` вызовом больше
// не является, но спрашивать про неё будут ещё долго («почему /ai не
// работает») — и такой вопрос обязан уйти в публичный профиль, а не к модели.
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

/**
 * Which abstentions mean "the topic is outside the covered domain" rather than
 * "the domain has a hole here". Only the domain veto's no-signal verdict
 * qualifies: the question names not a single concept of the domain dictionary,
 * so no rephrasing can find material that is not there. `CLAIM_*` stay in the
 * not-in-materials class: on the live path the claimed domain is derived from
 * the package manifest and those codes signal a routing anomaly, not a fact
 * about the question's topic.
 */
const OUT_OF_COVERAGE_REASONS = new Set([
  DOMAIN_ROUTE_REASONS.NO_SIGNAL,
]);

export function isAbstentionReason(reason) {
  return ABSTENTION_REASONS.has(String(reason || ''));
}

export function isOutOfCoverageReason(reason) {
  return OUT_OF_COVERAGE_REASONS.has(String(reason || ''));
}

export function assistantAbstentionReply(reason) {
  if (isOutOfCoverageReason(reason)) {
    return {
      route: `boundary:out_of_coverage:${String(reason)}`.slice(0, 120),
      text: ASSISTANT_OUT_OF_COVERAGE_TEXT,
    };
  }
  return {
    route: `boundary:not_in_materials:${String(reason || 'unknown')}`.slice(0, 120),
    text: ASSISTANT_NOT_IN_MATERIALS_TEXT,
  };
}

// Грубые бизнес-маркеры для метки Л2 в журнале дефицитов. Это метка очереди
// для лаборатории, не маршрутизация: ложное срабатывание стоит одну строку в
// журнале, поэтому детектор сознательно широкий.
const BUSINESS_MARKERS = TOKEN_BOUNDARY(
  'бизнес\\p{L}*|монетизир\\p{L}*|клиент\\p{L}*|продаж\\p{L}*|прибыл\\p{L}*'
  + '|стартап\\p{L}*|маркетинг\\p{L}*|выручк\\p{L}*|заработ\\p{L}*|доход\\p{L}*',
);

/**
 * A crude, code-owned label for the deficits journal: which future domain this
 * uncovered question is a candidate for. 'L2' — a business-model gap, 'L3' — a
 * worldview gap (the magic-pill premise; the value detector usually intercepts
 * these earlier, so this catches only formulations it missed), null — neither.
 */
export function coverageDeficitCandidateLevel(text) {
  const value = String(text || '').toLowerCase().replace(/ё/g, 'е');
  if (!value.trim()) return null;
  if (BUSINESS_MARKERS.test(value)) return 'L2';
  if (isNoTimeToLearnSignal(value)) return 'L3';
  return null;
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
