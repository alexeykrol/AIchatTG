import { createHash } from 'node:crypto';

export const PROMOTION_REVIEW_VERSION = 'promotion-review-v1';

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
 * Recall is intentionally limited to explicit commercial cues and exact
 * normalized repeats; paraphrased testimonials need later offline evaluation.
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
  const matches = latestHistory(observation, history).filter((prior) => (
    normalizedText(prior.text) === text && !explicitlyQuotedOrExercise(prior)
  ));
  const nonUrlText = text.replace(/(?:https?:\/\/|www\.|t\.me\/)\S+/gu, '').trim();
  const standardReply = matches.length + 1 >= STANDARD_REPLY_MIN_MESSAGES
    && nonUrlText.length >= STANDARD_REPLY_MIN_CHARS;
  if (!promotion && !standardReply) return result;
  const patterns = new Set();
  const reasons = new Set();
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
