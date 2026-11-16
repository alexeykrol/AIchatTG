// Deterministic answer evaluation (contract §6). Pure function.
//
// input: { text } for a typed message, or { optionId } for a pressed button.
// Returns { pass, reason, retryable, optionId? }.
//   retryable=true  — the answer did not count yet; one retry prompt is allowed.
//   retryable=false — a definite choice that is not accepted; no retry.
import {
  comparable,
  compileLinkPatterns,
  containsLink,
  countEmoji,
  countLettersOrDigits,
  normalizeText,
  words,
} from './text.mjs';

const DEFAULT_LINK_PATTERNS = compileLinkPatterns([
  'https?://',
  '\\bwww\\.',
  '\\bt\\.me/',
  '\\btg://',
  '\\b[a-z0-9-]+\\.(?:com|ru|net|org|io|me|xyz|top|link|click|site|online|shop)\\b',
]);

export function nonsenseReason(text, promptText = '') {
  const normalized = normalizeText(text);
  if (!normalized) return 'empty';
  const letters = countLettersOrDigits(normalized);
  if (letters === 0) {
    return countEmoji(normalized) > 0 ? 'only_emoji' : 'only_punctuation';
  }
  const compact = normalized.replace(/[^\p{L}\p{N}]/gu, '');
  if (compact.length >= 2 && new Set(compact).size === 1) return 'repeated_char';
  const answerCmp = comparable(normalized);
  const promptCmp = comparable(promptText);
  if (promptCmp && answerCmp && (answerCmp === promptCmp || (answerCmp.length >= 15 && promptCmp.includes(answerCmp)))) {
    return 'copy_of_question';
  }
  return null;
}

function evaluateChoice(question, input) {
  if (typeof input.optionId === 'string') {
    const option = question.options.find((o) => o.id === input.optionId);
    if (!option) return { pass: false, reason: 'unknown_option', retryable: true };
    if (question.accepted.includes(option.id)) return { pass: true, reason: 'accepted_option', retryable: false, optionId: option.id };
    return { pass: false, reason: 'option_not_accepted', retryable: false, optionId: option.id };
  }
  const typed = comparable(input.text);
  if (!typed) return { pass: false, reason: 'no_matching_option', retryable: true };
  const option = question.options.find((o) => (
    comparable(o.label) === typed || o.aliases.some((alias) => comparable(alias) === typed)
  ));
  if (!option) return { pass: false, reason: 'no_matching_option', retryable: true };
  if (question.accepted.includes(option.id)) return { pass: true, reason: 'accepted_option', retryable: false, optionId: option.id };
  return { pass: false, reason: 'option_not_accepted', retryable: false, optionId: option.id };
}

function evaluateFreeText(question, input, linkPatterns) {
  if (typeof input.text !== 'string') return { pass: false, reason: 'not_text', retryable: true };
  const nonsense = nonsenseReason(input.text, question.promptText);
  if (nonsense) return { pass: false, reason: `nonsense:${nonsense}`, retryable: true };
  const { rule } = question;
  if (rule.forbidLinks && containsLink(input.text, linkPatterns)) {
    return { pass: false, reason: 'contains_link', retryable: true };
  }
  const normalized = normalizeText(input.text);
  if (normalized.length < rule.minChars) return { pass: false, reason: 'too_short', retryable: true };
  if (words(normalized).length < rule.minWords) return { pass: false, reason: 'too_few_words', retryable: true };
  if (rule.anyOf.length > 0 && !rule.anyOf.some((kw) => normalized.includes(kw))) {
    return { pass: false, reason: 'missing_keyword', retryable: true };
  }
  return { pass: true, reason: 'ok', retryable: false };
}

export function evaluateAnswer(question, input = {}, { linkPatterns = DEFAULT_LINK_PATTERNS } = {}) {
  if (question.type === 'choice') return evaluateChoice(question, input);
  if (question.type === 'free_text') return evaluateFreeText(question, input, linkPatterns);
  throw new Error(`unsupported question type: ${question.type}`);
}
