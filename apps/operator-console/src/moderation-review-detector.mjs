import { createHash } from 'node:crypto';

export const PROMOTION_REVIEW_VERSION = 'promotion-review-v2';

// A deliberately narrow, review-only seed detector. These are lexical signals,
// not evidence of common account ownership, automation, AI authorship or abuse.
const OBJECT = /(?:книг[а-яё]*|курс[а-яё]*|продукт[а-яё]*|сервис[а-яё]*|тренинг[а-яё]*|марафон[а-яё]*|\b(?:book|course|product|service|training)\b)/iu;
const PERSONAL = /(?:\bI\s+(?:read|tried|bought|used|completed)\b|(?:^|[^\p{L}])я\s+(?:прочитал[аи]?|прош[её]л|прошла|купил[аи]?|попробовал[аи]?|использовал[аи]?)|мне\s+помог[а-яё]*|на\s+(?:личном|сво[её]м)\s+опыте)/iu;
const BUY = /(?:купите|покупайте|закажите|заказывайте|запишитесь|записывайтесь|оформите\s+(?:заказ|подписку)|\b(?:buy\s+(?:now|this|the|my)|order\s+(?:now|this|the|my)|enroll|sign\s+up)\b)/iu;
const COMMERCIAL = /(?:промокод|скидк[а-яё]*|стоимост[а-яё]*|цена|цене|ценой|\b(?:discount|coupon|price|sale)\b)/iu;
const GAIN = /(?:заработ[а-яё]*|доход[а-яё]*|прибыл[а-яё]*|\b(?:earn|income|profit)\b)/iu;
const DM = /(?:(?:напишите|пишите|обращайтесь|стучитесь)[^.!?\n]{0,48}(?:мне|личк[а-яё]*|личны[а-яё]*|директ|лс)|\b(?:dm|message|contact)\s+me\b)/iu;
const PRAISE = /(?:спасибо\s+за\s+(?:пост|статью|разбор)|отличн[а-яё]*\s+(?:пост|статья|разбор)|\b(?:great\s+(?:post|article)|thanks\s+for\s+(?:the\s+)?(?:post|article))\b)/iu;
const QUOTED_EXAMPLE = /^(?:цитата(?:\s+из\s+[^:\n]{1,120})?\s*:|пример\s+рекламного\s+текста\s*:|quote\s*:|advertising\s+example\s*:)/iu;
const EXPLICIT_EXERCISE = /(?:учебн[а-яё]*\s+задани[а-яё]*|задани[а-яё]*\s*:\s*(?:процитируйте|повторите|напишите\s+по\s+шаблону)|(?:разбор|анализ)\s+реклам[а-яё]*|\b(?:classroom\s+exercise|quote\s+this\s+advertisement)\b)/iu;
// Observable discourse cues, not a semantic verdict. A genuine unsolicited
// endorsement can have this shape too: only the owner can label the case.
const EXPERIENCE = /(?:попал(?:ась|ся|ось)|наткнул(?:ся|ась)|наш[её]л|нашла|прочитал[аи]?|прочл[а]?|дочитал[аи]?|послушал[аи]?|прош[её]л|прошла|открыл[аи]?|взял[аи]?\s+почитать|\bI\s+(?:(?:have|recently|just|accidentally)\s+)*(?:read|tried|bought|used|completed|found|stumbled\s+upon)\b)/iu;
const BENEFIT = /(?:помог[а-яё]*|научил[а-яё]*|объясня[а-яё]*|стало\s+(?:легче|проще)|мне\s+(?:легче|проще)|теперь\s+(?:легче|проще)|перестал[аи]?|понятный\s+(?:способ|подход)|\b(?:helped|helps|learned|learnt|easier|explains)\b)/iu;
const EXPECTATION = /(?:думал[аи]?|ожидал[аи]?|ждал[аи]?|считал[аи]?|настраивал[а-яё]*|\b(?:expected|thought)\b)/iu;
const REVERSAL = /(?:на\s+(?:деле|самом\s+деле)|однако|(?:^|[^\p{L}])(?:но|а)(?:$|[^\p{L}])|\b(?:but|instead|actually|however)\b)/iu;
const LIFE = /(?:^|[^\p{L}])(?:жизн[а-яё]*|дома|повседневн[а-яё]*|обыденност[а-яё]*|личн[а-яё]*|life|home)(?=$|[^\p{L}])/iu;
const WORK = /(?:^|[^\p{L}])(?:работ[а-яё]*|делах|делами|дела|work)(?=$|[^\p{L}])/iu;
const AUDIO_ACCESS = /(?:(?:есть|доступн[а-яё]*|имеется|можно\s+(?:по)?слушать)[^.!?\n]{0,48}(?:аудио[а-яё]*|озвученн[а-яё]*\s+верси[а-яё]*)|(?:аудио[а-яё]*|озвученн[а-яё]*\s+верси[а-яё]*)[^.!?\n]{0,32}(?:есть|доступн[а-яё]*)|\b(?:there\s+is\s+(?:an?\s+)?audio(?:book|\s+edition|\s+version)|an?\s+audiobook\s+is\s+available)\b)/iu;
const SOFT_RECOMMENDATION = /(?:советую|рекомендую|могу\s+порекомендовать|стоит\s+(?:по)?читать|стоит\s+познакомиться|присмотритесь|может\s+оказаться\s+полезн[а-яё]*|\b(?:worth\s+a\s+look|would\s+recommend|recommend\s+exploring)\b)/iu;
const REQUESTED_RECOMMENDATION = /(?:посоветуй(?:те)?|порекомендуй(?:те)?|(?:можете|можешь|могли\s+бы)(?:\s+(?:ли|вы|ты)){0,2}\s+(?:посоветовать|порекомендовать)|(?:какую|какой|какие|какая|какое|каких)[^.!?\n]{0,80}(?:посоветуете|порекомендуете)|\b(?:recommend\s+(?:me\s+)?(?:a|some|any)|which[^.!?\n]{0,80}(?:recommend|suggest))\b)/iu;
const REPORTING = /^(?:(?:здравствуйте|добрый\s+день|привет|hello|hi)[,\s:!—-]+)?(?:спам\s*:|модератор[а-яё]*[,\s:!—-]*(?:проверьте|посмотрите|обратите\s+внимание)|(?:это|снова|опять)\s+(?:похоже\s+на\s+)?(?:спам|реклам[а-яё]*)|(?:сообщаю|жалуюсь)\s+о\s+спаме|\b(?:reporting\s+(?:spam|an?\s+advertisement)|moderators?[,\s:!—-]*please\s+(?:check|review))\b)/iu;
const NEGATED_BENEFIT = /(?:не\s+(?:(?:очень|особо|слишком|действительно|реально)\s+){0,2}(?:помог[а-яё]*|советую|рекомендую)|не\s+могу\s+(?:порекомендовать|рекомендовать|посоветовать|советовать)|советую\s+не\s+(?:читать|покупать)|(?:рекомендовать|советовать)[^.!?\n]{0,20}не\s+могу|\b(?:did\s+not|didn't|does\s+not|doesn't|do\s+not|don't|(?:has|have|had)\s+not|hasn't|haven't|hadn't|never|not)\s+(?:(?:really|actually|particularly|very\s+much)\s+){0,2}help(?:ed|s)?\b|\b(?:do\s+not|don't|cannot|can't)\s+recommend\b|\brecommend\s+(?:avoiding|against)\b)/iu;
const HYPOTHETICAL = /^(?:(?:представим|допустим)[,\s:]+)?(?:если\s+бы|(?:я\s+)?(?:прочитал|порекомендовал)[аи]?\s+бы|if\s+I\s+(?:had|were\s+to)\s+read\b)/iu;
const SPECIFIC_ANSWER = /(?:в\s+(?:третьей|первой|второй|\d+)[-\s]*главе|в\s+главе\s+[«"“]|на\s+странице\s+\d+|\bchapter\s+on\b)/iu;
const ANSWER_REFERENCE = /(?:ваш[а-яё]*\s+(?:вопрос|построени[а-яё]*|задач[а-яё]*)|спросили|упражнени[а-яё]*|доказательств[а-яё]*|алгоритм[а-яё]*|\b(?:your\s+question|this\s+exercise|the\s+denominator)\b)/iu;

function hasTestimonialExperience(text) {
  for (const match of text.matchAll(new RegExp(EXPERIENCE.source, 'giu'))) {
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    if (!/(?:^|[^\p{L}])не\s*$/iu.test(before)) return true;
  }
  return false;
}

function testimonialCues(observation) {
  // Remove invisible separators only in cue recognition. Full-text hashes and
  // grouping preserve them, product names and URL identity unchanged.
  const text = normalizedText(observation.text).replace(/[\u200b-\u200d\u2060\ufeff]/gu, '');
  // Apply the same recognition-only normalization to an explicit request in
  // the supplied parent. Invisible separators must not turn a requested book
  // recommendation into an unsolicited testimonial. Fingerprints stay exact.
  const context = typeof observation.context?.text === 'string'
    ? normalizedText(observation.context.text).replace(/[\u200b-\u200d\u2060\ufeff]/gu, '') : '';
  if (!OBJECT.test(text) || !hasTestimonialExperience(text) || !BENEFIT.test(text)
    || REPORTING.test(text) || NEGATED_BENEFIT.test(text) || HYPOTHETICAL.test(text)
    || (OBJECT.test(context) && REQUESTED_RECOMMENDATION.test(context))
    || (SPECIFIC_ANSWER.test(text) && ANSWER_REFERENCE.test(text))) return [];
  const supports = [
    [EXPECTATION.test(text) && REVERSAL.test(text), 'expectation_reversal'],
    [LIFE.test(text) && WORK.test(text), 'broad_life_work_benefit'],
    [AUDIO_ACCESS.test(text), 'audio_format_available'],
    [SOFT_RECOMMENDATION.test(text), 'soft_recommendation'],
  ].filter(([present]) => present).map(([, reason]) => reason);
  return supports.length >= 2 ? ['personal_testimonial_with_benefit', ...supports] : [];
}
// Local-only synthetic seed thresholds, not measured precision or an approved
// production policy. A future activation requires evaluation of this seed.
const STANDARD_REPLY_MIN_CHARS = 120;
const STANDARD_REPLY_MIN_MESSAGES = 3;

function normalizedText(text) {
  // Keep product names, punctuation, numbers and complete URL identities. A
  // placeholder for links/products would silently merge unrelated promotions.
  // URL paths and queries may be case-sensitive: lowercase only prose, not
  // URL tokens, and do not compatibility-normalize a URL's actual characters.
  return text.split(/((?:https?:\/\/|www\.|t\.me\/)\S+)/giu)
    .map((part, index) => index % 2 ? part : part.normalize('NFKC').toLowerCase())
    .join('').trim().replace(/\s+/gu, ' ');
}

function validObservation(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.chatId === 'string' && value.chatId.trim().length > 0
    && typeof value.messageId === 'string' && value.messageId.trim().length > 0
    && typeof value.text === 'string'
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt));
}

function latestHistory(observation, history) {
  const latest = new Map();
  const collisions = new Set();
  const at = Date.parse(observation.observedAt);
  for (const prior of history) {
    if (!validObservation(prior) || prior.chatId !== observation.chatId
      || prior.messageId === observation.messageId || Date.parse(prior.observedAt) > at) continue;
    const previous = latest.get(prior.messageId);
    if (previous?.revision === prior.revision && previous.text !== prior.text) {
      collisions.add(prior.messageId);
    }
    if (!previous || prior.revision > previous.revision) latest.set(prior.messageId, prior);
  }
  return [...latest.values()].filter((value) => !collisions.has(value.messageId));
}

function explicitlyQuotedOrExercise(observation) {
  return QUOTED_EXAMPLE.test(observation.text.trim())
    || EXPLICIT_EXERCISE.test(observation.text)
    || (typeof observation.context?.text === 'string' && EXPLICIT_EXERCISE.test(observation.context.text));
}

/**
 * Caller supplies only its bounded, latest retained history. This function has
 * no clock, storage, model, transport or sanctions. No guessed retention or
 * temporal window is applied. Absence of history/context is absence of proof.
 * The testimonial branch is a bounded lexical review heuristic, not a model
 * classifier or proof of advertising. It recognizes multiple rhetorical cues
 * but never groups paraphrases, infers account ownership or enforces sanctions.
 */
export function detectPromotionReview(observation, { history = [] } = {}) {
  if (!validObservation(observation) || !Array.isArray(history)) {
    throw new TypeError('moderation_review_observation_invalid');
  }
  const text = normalizedText(observation.text);
  const result = {
    version: PROMOTION_REVIEW_VERSION,
    fingerprint: createHash('sha256').update(JSON.stringify([
      PROMOTION_REVIEW_VERSION, observation.chatId, text,
    ])).digest('hex'),
    patternIds: [], reasons: [], relatedMessageIds: [], reviewOnly: true,
  };
  if (!text || explicitlyQuotedOrExercise(observation)) return result;

  const personal = PERSONAL.test(text);
  const dm = DM.test(text);
  const object = OBJECT.test(text);
  const directPurchase = BUY.test(text);
  const commercial = COMMERCIAL.test(text);
  // A URL, book, fluent style, generic praise, recommendation or offer of
  // private help is insufficient on its own, even when repeated.
  const promotion = (object && (directPurchase || (commercial && dm)))
    || (personal && dm && GAIN.test(text));
  const testimonial = testimonialCues(observation);
  const matches = latestHistory(observation, history).filter((prior) => (
    normalizedText(prior.text) === text && !explicitlyQuotedOrExercise(prior)
  ));
  const nonUrlText = text.replace(/(?:https?:\/\/|www\.|t\.me\/)\S+/gu, '').trim();
  const standardReply = matches.length + 1 >= STANDARD_REPLY_MIN_MESSAGES
    && nonUrlText.length >= STANDARD_REPLY_MIN_CHARS;
  if (!promotion && !standardReply && testimonial.length === 0) return result;
  const patterns = new Set();
  const reasons = new Set();
  if (testimonial.length) {
    patterns.add('covert-testimonial-bait');
    testimonial.forEach((reason) => reasons.add(reason));
  }
  if (standardReply) {
    patterns.add('repeated-standard-reply');
    reasons.add('repeated_long_standard_reply');
  }
  if (promotion && personal) {
    patterns.add('personal-experience-promotion');
    reasons.add('personal_experience_with_commercial_cues');
  }
  if (promotion && dm) {
    patterns.add('dm-funnel');
    reasons.add('private_message_funnel_with_commercial_cues');
  }
  if (promotion && PRAISE.test(text)) {
    patterns.add('generic-comment-promotion');
    reasons.add('generic_praise_with_commercial_cues');
  }
  if (promotion && matches.length > 0) {
    patterns.add('repeated-product-seeding');
    reasons.add('repeated_promotional_text');
    if (personal) patterns.add('templated-testimonial');
  }
  if (!patterns.size) return result;
  if (directPurchase) reasons.add('commercial_call_to_action');
  if (!observation.context || typeof observation.context.text !== 'string'
    || !observation.context.text.trim()) reasons.add('original_context_missing');
  const contextIds = new Set([observation, ...matches]
    .map((item) => item.context?.messageId)
    .filter((id) => typeof id === 'string' && id.length > 0));
  if (contextIds.size > 1) reasons.add('observed_in_multiple_contexts');
  return {
    ...result,
    patternIds: [...patterns].sort(),
    reasons: [...reasons].sort(),
    relatedMessageIds: [observation.messageId, ...matches.map((item) => item.messageId)].sort(),
  };
}
