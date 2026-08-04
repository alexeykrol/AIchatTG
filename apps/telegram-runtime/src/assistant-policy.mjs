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

export function assistantDeterministicReply(text) {
  const value = String(text || '').trim();
  if (presencePing.test(value)) return { route: 'public:presence', text: 'Я здесь 🙂 Задайте вопрос одним сообщением: /ask ваш вопрос.' };
  if (isAssistantSelfQuestion(value)) return { route: 'profile:self', text: ASSISTANT_PROFILE_TEXT };
  return {
    route: courseTerms.test(value) ? 'boundary:course_unavailable' : 'boundary:public_redirect',
    text: ASSISTANT_UNAVAILABLE_TEXT,
  };
}
