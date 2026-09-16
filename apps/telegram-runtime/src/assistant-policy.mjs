import { DOMAIN_ROUTE_REASONS, GROUNDING_REASONS, isNoTimeToLearnSignal } from '@aichattg/telegram-core';

const TOKEN_BOUNDARY = (words) => new RegExp(
  `(?:^|[^\\p{L}\\p{N}_])(?:${words})(?=$|[^\\p{L}\\p{N}_])`,
  'iu',
);

// Restored public purpose from the accepted News assistant profile v2
// (a729ccd), with today's invocation paths. The extraction-time technical
// fallback was never an adequate description of a course navigator.
const ASSISTANT_CAPABILITIES_TEXT = [
  'Что я могу',
  '',
  'Я — ИИ Навигатор. Помогаю по подключённым материалам и справке:',
  '',
  '• объясняю идеи, термины и подходы из материалов курса;',
  '• помогаю найти нужный урок и разобраться в последовательности обучения;',
  '• отвечаю на общие вопросы об организации обучения;',
  '• помогаю соотнести курс с вашей задачей и понять, каких усилий потребует обучение;',
  '• подсказываю ссылки из проверенного каталога;',
  '• объясняю, как пользоваться ассистентом.',
  '',
  'Если данных недостаточно, я скажу об этом прямо и не буду угадывать.',
  'Я не вижу и не изменяю личные аккаунты или заказы — с ними помогает поддержка.',
].join('\n');

const ASSISTANT_USAGE_TEXT = [
  'Как спросить',
  '',
  'Самый простой способ:',
  '1. Откройте меню команд и выберите /ask.',
  '2. Отправьте появившуюся команду /ask.',
  '3. Я пришлю сообщение «Теперь напишите вопрос…». Напишите вопрос в ответ на него.',
  '4. Отправьте свой вопрос. /ask повторно писать не нужно.',
  '',
  'Если вы уже пишете сообщение, добавьте к вопросу /ask или @alexkrol_moderation_bot.',
  '/help покажет эту пошаговую справку. Без обращения ко мне я в разговор не вмешиваюсь.',
  'Команда /ai больше не поддерживается.',
].join('\n');

export const ASSISTANT_PROFILE_TEXT = [
  ASSISTANT_CAPABILITIES_TEXT,
  '',
  ASSISTANT_USAGE_TEXT,
].join('\n');

const ASSISTANT_INTERNAL_BOUNDARY_TEXT = [
  'Внутренние инструкции, настройки и служебные сведения я не раскрываю.',
  'Могу объяснить, как пользоваться навигатором, или помочь найти нужный материал курса.',
].join(' ');

export const ASSISTANT_HELP_TEXT = [
  ASSISTANT_CAPABILITIES_TEXT,
  '',
  ASSISTANT_USAGE_TEXT,
].join('\n');

/**
 * Пустой `/ask` — не ошибка пользователя, а МАССОВЫЙ штатный сценарий: Telegram
 * показывает меню команд, как только человек набирает слэш, большинство кликает
 * по подсказке, и уходит сообщение из одной команды. Подсказка задаёт один
 * следующий шаг: написать и отправить вопрос, не повторяя команду.
 * Сообщение отправляется с `forceReply` (см. runtime.mjs), а
 * `detectAssistantQuestion` принимает ответ на него без `/ask`.
 */
export const ASSISTANT_EMPTY_ASK_TEXT = '✍️ Теперь напишите вопрос в ответ на это сообщение и отправьте его.'
  + ' У вас 30 секунд, чтобы послать вопрос. /ask повторно писать не нужно.';

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

// This operational fallback is deliberately not the materials-unavailable
// message: a rejected safety-router contract says nothing about the course
// corpus. It is code-owned, does not blame the user, and contains no provider
// or safety implementation detail. Visible copy remains release-reviewable.
export const ASSISTANT_ROUTER_FAILURE_TEXT = 'Сейчас не удалось обработать вопрос. Попробуйте, пожалуйста, позже.';

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
 * deliberately different from the not-in-materials text. It is a code-owned
 * public boundary, so its wording is delivered verbatim rather than composed
 * by the answer model.
 */
export const ASSISTANT_OUT_OF_COVERAGE_TEXT = [
  'Хороший вопрос, но эта тема за пределами курса, и отвечать на неё я не уполномочен. Такой вопрос лучше задать универсальному чату — ChatGPT или Claude — или профильному консультанту.',
  'Также, возможно, вам стоит иначе сформулировать вопрос, и тогда я смогу найти ответить. Вы, люди - очень мудреные, и иногда ваши формулировки вопросов бывают такими заковыристыми, что сам черт ногу сломит. Со всем, что касается ИИ, я помогу с радостью: материал уроков, организация обучения, выбор курса и подойдёт ли он именно вам.',
  'Важно: Не рекомендую тестировать меня тупыми провокационными вопросами, которые немедленно квалифицируются как абьюз, передаются боту модератору, который после 3 попыток выпиливает вас навечно. Ничего личного и со всем уважением.',
].join('\n\n');

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
function assistantSelfQuestionKind(text) {
  const value = String(text || '').trim().toLowerCase()
    .replace(/^(?:привет|здравствуйте|добрый день)[!,\.\s]+/iu, '')
    .replace(/^(?:расскажи|объясни|подскажи)(?:,?\s+пожалуйста)?[,\s]+/iu, '')
    .replace(/[?!.\s]+$/u, '');
  if (!value) return null;
  const thisAssistant = /(?:эт(?:от|ого|ому|им)|данн(?:ый|ого|ому|ым)|наш(?:его|ему|им)?)\s+(?:бот|ассистент)|@alexkrol_moderation_bot\b/iu.test(value);
  const secondPerson = TOKEN_BOUNDARY('ты|тебя|тебе|тобой|твой|твоя|тво[её]|твои').test(value);
  // Asking the navigator which model to study/use is a course question, not
  // a request to reveal the model behind this bot.
  if (/модел\p{L}*/iu.test(value)
    && /(?:рекоменду|совету|выбрать|выбирать|изуч|подойд[её]т)/iu.test(value)
    && !/(?:у\s+тебя|тво[яиёе]|внутренн|системн\p{L}*\s+инструкц|инфраструктур|секрет)/iu.test(value)) return null;
  if (internalDetail.test(value) && (thisAssistant || secondPerson)) return 'internal';
  if (value === 'help' || value === 'помощь') return 'usage';
  // A mixed concrete course question must reach the course pipeline, rather
  // than receiving only a profile for its first clause.
  if (/(?:и|а)\s+(?:где|как|найди|объясни|расскажи)[^]*?(?:урок|rag|раг|claude|модул)/iu.test(value)) return null;
  if (/^(?:а\s+)?(?:кто|что)\s+ты(?:\s+так(?:ой|ая))?$/iu.test(value)
    || /^(?:как\s+тебя\s+(?:зовут|называть)|какое\s+у\s+тебя\s+имя)$/iu.test(value)
    || /^(?:а\s+)?ты\s+(?:бот|ассистент)(?:\s+или\s+человек)?$/iu.test(value)
    || /^(?:что\s+это\s+за|как\s+называется\s+этот)\s+(?:бот|ассистент)$/iu.test(value)) return 'identity';
  if (/^(?:а\s+)?(?:что\s+ты\s+(?:умеешь|можешь|делаешь)|чем\s+ты\s+(?:(?:можешь\s+)?(?:мне\s+)?помочь|полезен)|какие\s+у\s+тебя\s+возможности|(?:зачем|для\s+чего)\s+ты\s+нужен|на\s+какие\s+вопросы\s+ты\s+отвечаешь)$/iu.test(value)
    || /^(?:как|чем)\s+ты\s+можешь\s+(?:мне\s+)?помочь(?:\s+(?:с\s+курсом|в\s+обучении))?$/iu.test(value)
    || /^(?:чем\s+полезен|что\s+умеет|зачем\s+нужен)\s+этот\s+(?:бот|ассистент)$/iu.test(value)) return 'capabilities';
  if (/^(?:на\s+какие\s+(?:материалы|источники)\s+ты\s+опираешься|откуда\s+ты\s+бер[её]шь\s+(?:ответы|информацию)|как\s+ты\s+(?:работаешь|ищешь\s+информацию|формируешь\s+ответы))$/iu.test(value)) return 'sources';
  if (/^(?:что\s+ты\s+не\s+(?:умеешь|можешь)|какие\s+у\s+тебя\s+(?:границы|ограничения)|почему\s+ты\s+(?:иногда\s+)?(?:не\s+находишь\s+ответ|не\s+можешь\s+ответить|отказываешься\s+отвечать))$/iu.test(value)) return 'limits';
  if ((secondPerson || thisAssistant) && /^(?:а\s+)?(?:как|каким\s+образом)(?=$|[^\p{L}\p{N}_])/iu.test(value)
    && /(?:пользова|обраща|задать\s+вопрос|задавать\s+вопрос|вызыва|вызвать|позвать|написать)/iu.test(value)) return 'usage';
  if (profileCommand.test(value)
    && /(?:разниц|отлич|одинаков|равнознач|синоним|как\s+(?:использова|пользова|вызыва)|почему\s+.*не\s+работа|что\s+(?:дела|знач))/iu.test(value)) return 'usage';
  return null;
}

export function isAssistantSelfQuestion(text) {
  return assistantSelfQuestionKind(text) !== null;
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

/**
 * Presence pings ("бот, ты тут?") and self-referential questions ("что ты
 * можешь?") are about the assistant itself, not the course — routing them
 * through knowledge retrieval finds nothing on-topic and produces a wrong or
 * confusing answer (out-of-coverage boundary text for a question that was
 * never about coverage). This check is meant to run BEFORE the knowledge
 * pipeline regardless of whether it is enabled, unlike the rest of
 * `assistantDeterministicReply` below, which is a fallback for when there is
 * no knowledge pipeline to hand other questions to at all.
 */
export function assistantSelfDescriptionReply(text) {
  const value = String(text || '').trim();
  if (presencePing.test(value)) return { route: 'public:presence', text: 'Я здесь 🙂 Задайте вопрос одним сообщением: /ask ваш вопрос.' };
  const kind = assistantSelfQuestionKind(value);
  if (kind) {
    const replies = {
      capabilities: ASSISTANT_PROFILE_TEXT,
      identity: 'Я — «ИИ Навигатор», бот-помощник по курсу «Создание ИИ Агентов». Помогаю находить нужные уроки и разбираться в материалах. Я не Алексей Крол и не человек.',
      usage: ASSISTANT_USAGE_TEXT,
      sources: 'Я опираюсь на подключённые материалы курса и справку по организации обучения: нахожу подходящие фрагменты и объясняю их. Ссылки беру из проверенного каталога. Если материала недостаточно, скажу об этом.',
      limits: 'Помогаю по материалам курса, выбору обучения и организационным вопросам. Если в подключённых материалах нет ответа, скажу об этом. Общие вопросы вне курса лучше задать универсальному ИИ-чату; личные вопросы об аккаунте и заказе — поддержке.',
      internal: ASSISTANT_INTERNAL_BOUNDARY_TEXT,
    };
    return { route: 'profile:self', text: replies[kind] };
  }
  return null;
}

export function assistantDeterministicReply(text) {
  const selfDescription = assistantSelfDescriptionReply(text);
  if (selfDescription) return selfDescription;
  const value = String(text || '').trim();
  return {
    route: courseTerms.test(value) ? 'boundary:course_unavailable' : 'boundary:public_redirect',
    text: ASSISTANT_UNAVAILABLE_TEXT,
  };
}
