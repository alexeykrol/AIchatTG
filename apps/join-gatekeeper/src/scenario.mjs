import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeText } from './text.mjs';

export const DEFAULT_SCENARIO_PATH = fileURLToPath(new URL('../JOIN_SCENARIO.json', import.meta.url));
export const CALLBACK_PREFIX = 'jg';
export const REQUIRED_MESSAGES = ['greeting', 'retry', 'approved', 'declined_answers', 'manual_review', 'timeout'];

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'status', 'note', 'messages', 'questions', 'screening', 'limits']);
const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const LIMITS = {
  answerTimeoutSeconds: [60, 24 * 60 * 60],
  dmWindowSeconds: [30, 300],
  maxApplicationsPerUserPerDay: [1, 20],
  retentionDays: [1, 365],
};

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

export function callbackData(questionId, optionId) {
  return `${CALLBACK_PREFIX}:${questionId}:${optionId}`;
}

export function parseCallbackData(data) {
  const match = /^jg:([a-z][a-z0-9_]{0,31}):([a-z][a-z0-9_]{0,31})$/.exec(String(data ?? ''));
  return match ? { questionId: match[1], optionId: match[2] } : null;
}

function validateQuestion(question, index, messages) {
  const where = `questions[${index}]`;
  if (!isPlainObject(question)) fail(`${where} must be an object`);
  if (typeof question.id !== 'string' || !ID_RE.test(question.id)) fail(`${where}.id is invalid`);
  if (!['free_text', 'choice'].includes(question.type)) fail(`${where}.type must be free_text or choice`);
  if (typeof question.prompt !== 'string' || !Object.hasOwn(messages, question.prompt)) {
    fail(`${where}.prompt must reference an existing message`);
  }
  const base = { id: question.id, type: question.type, prompt: question.prompt, promptText: messages[question.prompt] };

  if (question.type === 'free_text') {
    const rule = question.rule;
    if (!isPlainObject(rule)) fail(`${where}.rule must be an object`);
    const allowed = new Set(['minWords', 'minChars', 'forbidLinks', 'anyOf']);
    for (const key of Object.keys(rule)) if (!allowed.has(key)) fail(`${where}.rule.${key} is not supported`);
    if (typeof rule.forbidLinks !== 'boolean') fail(`${where}.rule.forbidLinks must be boolean`);
    return Object.freeze({
      ...base,
      rule: Object.freeze({
        minWords: integerIn(rule.minWords, `${where}.rule.minWords`, 0, 200),
        minChars: integerIn(rule.minChars, `${where}.rule.minChars`, 0, 2000),
        forbidLinks: rule.forbidLinks,
        anyOf: Object.freeze(stringList(rule.anyOf ?? [], `${where}.rule.anyOf`, { allowEmpty: true }).map(normalizeText)),
      }),
    });
  }

  if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 10) {
    fail(`${where}.options must have 2-10 entries`);
  }
  const optionIds = new Set();
  const options = question.options.map((option, optionIndex) => {
    const ow = `${where}.options[${optionIndex}]`;
    if (!isPlainObject(option)) fail(`${ow} must be an object`);
    if (typeof option.id !== 'string' || !ID_RE.test(option.id)) fail(`${ow}.id is invalid`);
    if (optionIds.has(option.id)) fail(`${ow}.id is duplicated`);
    optionIds.add(option.id);
    const data = callbackData(question.id, option.id);
    if (Buffer.byteLength(data) > 64) fail(`${ow} callback data exceeds 64 bytes`);
    return Object.freeze({
      id: option.id,
      label: nonEmptyString(option.label, `${ow}.label`, 64),
      aliases: Object.freeze(stringList(option.aliases ?? [], `${ow}.aliases`, { allowEmpty: true, max: 20 })),
      callbackData: data,
    });
  });
  const accepted = stringList(question.accepted, `${where}.accepted`);
  for (const id of accepted) if (!optionIds.has(id)) fail(`${where}.accepted references unknown option ${id}`);
  if (new Set(accepted).size !== accepted.length) fail(`${where}.accepted has duplicates`);
  return Object.freeze({ ...base, options: Object.freeze(options), accepted: Object.freeze(accepted) });
}

export function validateScenario(raw) {
  if (!isPlainObject(raw)) fail('root must be an object');
  for (const key of Object.keys(raw)) if (!TOP_LEVEL_KEYS.has(key)) fail(`unknown top-level key ${key}`);
  if (raw.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (!['draft', 'ready'].includes(raw.status)) fail('status must be draft or ready');
  if (raw.note !== undefined && typeof raw.note !== 'string') fail('note must be a string');

  if (!isPlainObject(raw.messages)) fail('messages must be an object');
  const messages = {};
  for (const [key, value] of Object.entries(raw.messages)) {
    if (!ID_RE.test(key)) fail(`messages key ${key} is invalid`);
    messages[key] = nonEmptyString(value, `messages.${key}`);
  }
  for (const key of REQUIRED_MESSAGES) if (!Object.hasOwn(messages, key)) fail(`messages.${key} is required`);

  if (!Array.isArray(raw.questions) || raw.questions.length < 2 || raw.questions.length > 5) {
    fail('questions must have 2-5 entries');
  }
  const questions = raw.questions.map((question, index) => validateQuestion(question, index, messages));
  const ids = questions.map((q) => q.id);
  if (new Set(ids).size !== ids.length) fail('question ids must be unique');

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
    limits[key] = integerIn(raw.limits[key], `limits.${key}`, min, max);
  }
  for (const key of Object.keys(raw.limits)) if (!Object.hasOwn(LIMITS, key)) fail(`limits.${key} is not supported`);

  return Object.freeze({
    schemaVersion: 1,
    status: raw.status,
    messages: Object.freeze(messages),
    questions: Object.freeze(questions),
    screening: Object.freeze({
      spamKeywords: Object.freeze(spamKeywords),
      linkPatterns: Object.freeze(linkPatterns),
      compiledLinkPatterns: Object.freeze(compiledLinkPatterns),
    }),
    limits: Object.freeze(limits),
  });
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
    messages: Object.keys(scenario.messages).length,
    spamKeywords: scenario.screening.spamKeywords.length,
    linkPatterns: scenario.screening.linkPatterns.length,
    limits: scenario.limits,
  };
}
