import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeText } from './text.mjs';

export const DEFAULT_SCENARIO_PATH = fileURLToPath(new URL('../JOIN_SCENARIO.json', import.meta.url));
export const CALLBACK_PREFIX = 'jg';
export const REQUIRED_MESSAGES = [
  'greeting', 'approved', 'manual_review',
  // contract v2
  'token_welcome', 'token_already_verified', 'token_invalid', 'probation_intro', 'probation_passed',
  'probation_removed', 'start_info',
  // texts v3 (2026-11-18)
  'token_approved', 'probation_lift_unconfirmed', 'probation_expired', 'button_open_group',
];
// Questionnaire v2 (A0-bis): every decline carries exactly one of these codes,
// and each code has its own user-facing message (scenario `reasons` map).
export const REASON_CODES = Object.freeze([
  'R_PROFILE_AD', 'R_STOPWORD', 'R_READER', 'R_RULES', 'R_TOPIC_AD', 'R_TIMEOUT', 'R_RATE', 'R_SCAM',
]);
export const PRECHECK_REASONS = Object.freeze(['R_SCAM', 'R_PROFILE_AD', 'R_STOPWORD']);
export const ANSWER_REASONS = Object.freeze(['R_READER', 'R_RULES', 'R_TOPIC_AD']);

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'status', 'note', 'messages', 'reasons', 'questions', 'screening', 'limits']);
const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
// Room for the "✅ " selection mark on multi-choice buttons.
const MAX_LABEL = 60;
const LIMITS = {
  answerTimeoutSeconds: [60, 24 * 60 * 60],
  dmWindowSeconds: [30, 300],
  maxApplicationsPerUserPerDay: [1, 20],
  retentionDays: [1, 365],
  probationDays: [1, 60],
};
const LIMIT_DEFAULTS = { probationDays: 7 };

function fail(message) {
  throw new Error(`invalid join scenario: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value, where, max = 4096) {
  if (typeof value !== 'string' || !value.trim()) fail(`${where} must be a non-empty string`);
  if (value.length > max) fail(`${where} must be at most ${max} characters`);
  return value;
}

function integerIn(value, where, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${where} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function stringList(value, where, { allowEmpty = false, max = 200 } = {}) {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  if (!allowEmpty && value.length === 0) fail(`${where} must not be empty`);
  if (value.length > max) fail(`${where} must have at most ${max} entries`);
  return value.map((item, index) => nonEmptyString(item, `${where}[${index}]`, 200));
}

function onlyKeys(object, allowed, where) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(`${where}.${key} is not supported`);
}

function messageRef(value, messages, where) {
  if (typeof value !== 'string' || !Object.hasOwn(messages, value)) fail(`${where} must reference an existing message`);
  return value;
}

function reasonRef(value, reasons, allowed, where) {
  if (!allowed.includes(value) || !Object.hasOwn(reasons, value)) {
    fail(`${where} must be one of ${allowed.join(', ')}`);
  }
  return value;
}

export function callbackData(questionId, optionId) {
  return `${CALLBACK_PREFIX}:${questionId}:${optionId}`;
}

export function parseCallbackData(data) {
  const match = /^jg:([a-z][a-z0-9_]{0,31}):([a-z][a-z0-9_]{0,31})$/.exec(String(data ?? ''));
  return match ? { questionId: match[1], optionId: match[2] } : null;
}

function button(questionId, raw, where, optionIds, extraKeys = []) {
  if (!isPlainObject(raw)) fail(`${where} must be an object`);
  onlyKeys(raw, ['id', 'label', ...extraKeys], where);
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) fail(`${where}.id is invalid`);
  if (optionIds.has(raw.id)) fail(`${where}.id is duplicated`);
  optionIds.add(raw.id);
  const data = callbackData(questionId, raw.id);
  if (Buffer.byteLength(data) > 64) fail(`${where} callback data exceeds 64 bytes`);
  return { id: raw.id, label: nonEmptyString(raw.label, `${where}.label`, MAX_LABEL), callbackData: data };
}

function validateQuestion(question, index, messages, reasons) {
  const where = `questions[${index}]`;
  if (!isPlainObject(question)) fail(`${where} must be an object`);
  if (typeof question.id !== 'string' || !ID_RE.test(question.id)) fail(`${where}.id is invalid`);
  if (!['choice', 'multi_choice'].includes(question.type)) fail(`${where}.type must be choice or multi_choice`);
  const prompt = messageRef(question.prompt, messages, `${where}.prompt`);
  const base = { id: question.id, type: question.type, prompt, promptText: messages[prompt] };
  const optionIds = new Set();

  if (question.type === 'choice') {
    onlyKeys(question, ['id', 'type', 'prompt', 'options'], where);
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 10) {
      fail(`${where}.options must have 2-10 entries`);
    }
    const options = question.options.map((option, optionIndex) => {
      const ow = `${where}.options[${optionIndex}]`;
      const b = button(question.id, option, ow, optionIds, ['aliases', 'reject']);
      const reject = option.reject === undefined ? null : reasonRef(option.reject, reasons, ANSWER_REASONS, `${ow}.reject`);
      return Object.freeze({
        ...b,
        aliases: Object.freeze(stringList(option.aliases ?? [], `${ow}.aliases`, { allowEmpty: true, max: 20 })),
        reject,
      });
    });
    const accepted = options.filter((o) => o.reject === null).map((o) => o.id);
    if (accepted.length === 0) fail(`${where} must have at least one option without reject`);
    if (accepted.length === options.length) fail(`${where} must have at least one option with reject`);
    return Object.freeze({ ...base, options: Object.freeze(options), accepted: Object.freeze(accepted) });
  }

  // multi_choice: topic toggles + "add your own" + "done".
  onlyKeys(question, ['id', 'type', 'prompt', 'options', 'minSelected', 'custom', 'done'], where);
  if (!Array.isArray(question.options) || question.options.length < 1 || question.options.length > 10) {
    fail(`${where}.options must have 1-10 entries`);
  }
  const options = question.options.map((option, optionIndex) => (
    Object.freeze(button(question.id, option, `${where}.options[${optionIndex}]`, optionIds))
  ));
  const minSelected = integerIn(question.minSelected, `${where}.minSelected`, 1, options.length);
  if (!isPlainObject(question.custom)) fail(`${where}.custom must be an object`);
  const custom = Object.freeze({
    ...button(question.id, question.custom, `${where}.custom`, optionIds, ['prompt', 'reject']),
    prompt: messageRef(question.custom.prompt, messages, `${where}.custom.prompt`),
    reject: reasonRef(question.custom.reject, reasons, ['R_TOPIC_AD'], `${where}.custom.reject`),
  });
  if (!isPlainObject(question.done)) fail(`${where}.done must be an object`);
  const done = Object.freeze({
    ...button(question.id, question.done, `${where}.done`, optionIds, ['emptyNotice']),
    emptyNotice: messageRef(question.done.emptyNotice, messages, `${where}.done.emptyNotice`),
  });
  if (messages[done.emptyNotice].length > 200) fail(`${where}.done.emptyNotice must fit a callback notice (200 characters)`);
  return Object.freeze({ ...base, options: Object.freeze(options), minSelected, custom, done });
}

export function validateScenario(raw) {
  if (!isPlainObject(raw)) fail('root must be an object');
  for (const key of Object.keys(raw)) if (!TOP_LEVEL_KEYS.has(key)) fail(`unknown top-level key ${key}`);
  if (raw.schemaVersion !== 2) fail('schemaVersion must be 2');
  if (!['draft', 'ready'].includes(raw.status)) fail('status must be draft or ready');
  if (raw.note !== undefined && typeof raw.note !== 'string') fail('note must be a string');

  if (!isPlainObject(raw.messages)) fail('messages must be an object');
  const messages = {};
  for (const [key, value] of Object.entries(raw.messages)) {
    if (!ID_RE.test(key)) fail(`messages key ${key} is invalid`);
    messages[key] = nonEmptyString(value, `messages.${key}`);
  }
  for (const key of REQUIRED_MESSAGES) if (!Object.hasOwn(messages, key)) fail(`messages.${key} is required`);

  if (!isPlainObject(raw.reasons)) fail('reasons must be an object');
  const reasons = {};
  for (const [code, key] of Object.entries(raw.reasons)) {
    if (!REASON_CODES.includes(code)) fail(`reasons.${code} is not a known reason code`);
    reasons[code] = messageRef(key, messages, `reasons.${code}`);
  }
  for (const code of REASON_CODES) if (!Object.hasOwn(reasons, code)) fail(`reasons.${code} is required`);

  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 5) {
    fail('questions must have 1-5 entries');
  }
  const questions = raw.questions.map((question, index) => validateQuestion(question, index, messages, reasons));
  const ids = questions.map((q) => q.id);
  if (new Set(ids).size !== ids.length) fail('question ids must be unique');
  const multi = questions.filter((q) => q.type === 'multi_choice');
  if (multi.length > 1 || (multi.length === 1 && questions.at(-1).type !== 'multi_choice')) {
    fail('at most one multi_choice question, and it must be the last one');
  }

  if (!isPlainObject(raw.screening)) fail('screening must be an object');
  const spamKeywords = stringList(raw.screening.spamKeywords, 'screening.spamKeywords').map(normalizeText);
  if (spamKeywords.some((kw) => !kw)) fail('screening.spamKeywords entries must not normalize to empty');
  const linkPatterns = stringList(raw.screening.linkPatterns, 'screening.linkPatterns');
  const compiledLinkPatterns = linkPatterns.map((pattern, index) => {
    try {
      return new RegExp(pattern, 'iu');
    } catch (error) {
      return fail(`screening.linkPatterns[${index}] is not a valid regular expression: ${error.message}`);
    }
  });

  if (!isPlainObject(raw.limits)) fail('limits must be an object');
  const limits = {};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = raw.limits[key] === undefined && Object.hasOwn(LIMIT_DEFAULTS, key) ? LIMIT_DEFAULTS[key] : raw.limits[key];
    limits[key] = integerIn(value, `limits.${key}`, min, max);
  }
  for (const key of Object.keys(raw.limits)) if (!Object.hasOwn(LIMITS, key)) fail(`limits.${key} is not supported`);

  return Object.freeze({
    schemaVersion: 2,
    status: raw.status,
    messages: Object.freeze(messages),
    reasons: Object.freeze(reasons),
    questions: Object.freeze(questions),
    screening: Object.freeze({
      spamKeywords: Object.freeze(spamKeywords),
      linkPatterns: Object.freeze(linkPatterns),
      compiledLinkPatterns: Object.freeze(compiledLinkPatterns),
    }),
    limits: Object.freeze(limits),
  });
}

// User-facing text for a reason code.
export function reasonText(scenario, code) {
  const key = scenario.reasons[code];
  if (!key) throw new Error(`unknown reason code ${code}`);
  return scenario.messages[key];
}

export function loadScenario(scenarioPath = DEFAULT_SCENARIO_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  } catch (error) {
    throw new Error(`invalid join scenario: cannot read ${scenarioPath}: ${error.message}`);
  }
  return validateScenario(raw);
}

export function scenarioSummary(scenario) {
  return {
    ok: true,
    status: scenario.status,
    questions: scenario.questions.map((q) => ({ id: q.id, type: q.type })),
    reasons: Object.keys(scenario.reasons),
    messages: Object.keys(scenario.messages).length,
    spamKeywords: scenario.screening.spamKeywords.length,
    linkPatterns: scenario.screening.linkPatterns.length,
    limits: scenario.limits,
  };
}
