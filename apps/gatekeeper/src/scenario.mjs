import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertNoDuplicateJsonKeys, DuplicateJsonKeyError } from './strict-json.mjs';

const SCENARIO_BEGIN = '<!-- GATEKEEPER_SCENARIO_JSON_BEGIN -->';
const SCENARIO_END = '<!-- GATEKEEPER_SCENARIO_JSON_END -->';
const SCENARIO_ID = 'telegram-gatekeeper-onboarding';
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const TEMPLATE_TOKEN = /\{\{([a-z][a-z0-9_]*)\}\}/gu;
const DRAFT_MARKER = /\[(?:ЗАГЛУШКА|PLACEHOLDER)(?::[^\]]*)?\]/iu;
const ACTIVE_MESSAGE_IDS = Object.freeze([
  'group_invitation',
  'start_missing_token',
  'start_invalid_token',
  'start_payment_not_confirmed',
  'start_expired_token',
  'start_already_completed',
  'private_instruction',
  'email_invalid',
  'email_accepted',
  'completion_invalid_user',
  'completion_before_start',
  'completion_before_email',
  'completion_already_completed',
  'completion_success',
  'site_email_instruction',
  'site_instruction',
  'site_invalid_link',
  'site_completion_success',
  'site_completion_already_completed',
]);
const PLANNED_MESSAGE_AUDIENCES = Object.freeze({
  illegitimate_removal_notice: 'user',
  activation_reminder: 'user',
  activation_escalation_admin: 'admin',
  non_tribute_private_instruction: 'user',
  tribute_confirmation_retry: 'user',
  other_confirmation_retry: 'user',
  confirmation_escalation_admin: 'admin',
  post_confirmation_check: 'user',
  support_handoff: 'user',
  question_router_clarification: 'user',
  local_dialog_boundary: 'user',
});
const PLANNED_MESSAGE_IDS = Object.freeze(Object.keys(PLANNED_MESSAGE_AUDIENCES));

export const DEFAULT_SCENARIO_PATH = fileURLToPath(
  new URL('../ONBOARDING_SCENARIO.md', import.meta.url),
);

function scenarioError(message) {
  return new Error(`Gatekeeper scenario is invalid: ${message}`);
}

function assertPlainObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw scenarioError(`${path} must be an object`);
  }
  return value;
}

function assertKnownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && !key.startsWith('_comment')) {
      throw scenarioError(`${path}.${key} is not supported`);
    }
  }
}

function messageObject(value, path, contentKeys, { status, audience }) {
  const object = assertPlainObject(value, path);
  assertKnownKeys(object, new Set(['status', 'audience', ...contentKeys]), path);
  if (object.status !== status) throw scenarioError(`${path}.status must be ${status}`);
  if (object.audience !== audience) throw scenarioError(`${path}.audience must be ${audience}`);
  return { object, metadata: { status, audience } };
}

function textField(value, path, { max = 4_096, allowedTemplates = [] } = {}) {
  if (typeof value !== 'string') throw scenarioError(`${path} must be a string`);
  const text = value.trim();
  if (!text || text.length > max) {
    throw scenarioError(`${path} must contain 1-${max} characters`);
  }
  if (CONTROL_CHARACTERS.test(text)) throw scenarioError(`${path} contains unsupported control characters`);

  const allowed = new Set(allowedTemplates);
  const found = new Set();
  for (const match of text.matchAll(TEMPLATE_TOKEN)) {
    found.add(match[1]);
    if (!allowed.has(match[1])) throw scenarioError(`${path} contains unsupported template {{${match[1]}}}`);
  }
  const withoutKnownTemplates = text.replace(TEMPLATE_TOKEN, '');
  if (withoutKnownTemplates.includes('{{') || withoutKnownTemplates.includes('}}')) {
    throw scenarioError(`${path} contains a malformed template`);
  }
  if (allowedTemplates.includes('user_mention') && !found.has('user_mention')) {
    throw scenarioError(`${path} must contain {{user_mention}}`);
  }
  if (allowedTemplates.includes('user_mention')) {
    const occurrences = [...text.matchAll(/\{\{user_mention\}\}/gu)].length;
    if (occurrences !== 1) throw scenarioError(`${path} must contain {{user_mention}} exactly once`);
  }
  return text;
}

function textMessage(value, path, options) {
  const { object, metadata } = messageObject(value, path, ['text'], {
    status: 'active', audience: 'user',
  });
  return { ...metadata, text: textField(object.text, `${path}.text`, options) };
}

function callbackMessage(value, path) {
  const { object, metadata } = messageObject(value, path, ['callback_text'], {
    status: 'active', audience: 'user',
  });
  return {
    ...metadata,
    callback_text: textField(object.callback_text, `${path}.callback_text`, { max: 200 }),
  };
}

function validateLink(value, index, path) {
  const itemPath = `${path}[${index}]`;
  const object = assertPlainObject(value, itemPath);
  assertKnownKeys(object, new Set(['label', 'url']), itemPath);
  const label = textField(object.label, `${itemPath}.label`, { max: 64 });
  const rawUrl = textField(object.url, `${itemPath}.url`, { max: 2_048 });
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw scenarioError(`${itemPath}.url must be a valid URL`);
  }
  if (url.protocol !== 'https:') throw scenarioError(`${itemPath}.url must use HTTPS`);
  if (url.username || url.password) throw scenarioError(`${itemPath}.url must not contain credentials`);
  return { label, url: url.toString() };
}

function validateGroupInvitation(value, path) {
  const { object, metadata } = messageObject(value, path, ['text', 'button_text'], {
    status: 'active', audience: 'user',
  });
  return {
    ...metadata,
    text: textField(object.text, `${path}.text`, {
      max: 3_500,
      allowedTemplates: ['user_mention'],
    }),
    button_text: textField(object.button_text, `${path}.button_text`, { max: 64 }),
  };
}

function validatePrivateInstruction(value, path) {
  const { object, metadata } = messageObject(value, path, ['text', 'links'], {
    status: 'active', audience: 'user',
  });
  const links = object.links;
  if (!Array.isArray(links) || links.length < 1 || links.length > 6) {
    throw scenarioError(`${path}.links must contain 1-6 links`);
  }
  return {
    ...metadata,
    text: textField(object.text, `${path}.text`, { max: 3_500 }),
    links: links.map((link, index) => validateLink(link, index, `${path}.links`)),
  };
}

function validateCompletionPrompt(value, path) {
  const { object, metadata } = messageObject(value, path, ['text', 'completion_button_text'], {
    status: 'active', audience: 'user',
  });
  return {
    ...metadata,
    text: textField(object.text, `${path}.text`),
    completion_button_text: textField(
      object.completion_button_text,
      `${path}.completion_button_text`,
      { max: 64 },
    ),
  };
}

function validateCompletionSuccess(value, path) {
  const { object, metadata } = messageObject(value, path, ['callback_text', 'dm_text'], {
    status: 'active', audience: 'user',
  });
  return {
    ...metadata,
    callback_text: textField(object.callback_text, `${path}.callback_text`, { max: 200 }),
    dm_text: textField(object.dm_text, `${path}.dm_text`),
  };
}

function validateSiteEmailInstruction(value, path) {
  const { object, metadata } = messageObject(value, path, ['subject', 'text', 'button_text'], {
    status: 'active', audience: 'user',
  });
  return {
    ...metadata,
    subject: textField(object.subject, `${path}.subject`, { max: 200 }),
    text: textField(object.text, `${path}.text`, { max: 8_000 }),
    button_text: textField(object.button_text, `${path}.button_text`, { max: 64 }),
  };
}

function validateSiteInstruction(value, path) {
  const { object, metadata } = messageObject(
    value,
    path,
    ['text', 'links', 'completion_button_text'],
    { status: 'active', audience: 'user' },
  );
  if (!Array.isArray(object.links) || object.links.length < 1 || object.links.length > 6) {
    throw scenarioError(`${path}.links must contain 1-6 links`);
  }
  return {
    ...metadata,
    text: textField(object.text, `${path}.text`, { max: 8_000 }),
    links: object.links.map((link, index) => validateLink(link, index, `${path}.links`)),
    completion_button_text: textField(
      object.completion_button_text,
      `${path}.completion_button_text`,
      { max: 64 },
    ),
  };
}

function validatePlannedMessage(value, id) {
  const path = `root.messages.${id}`;
  const { object, metadata } = messageObject(value, path, ['text', 'button_text'], {
    status: 'planned', audience: PLANNED_MESSAGE_AUDIENCES[id],
  });
  const message = {
    ...metadata,
    text: textField(object.text, `${path}.text`),
  };
  if ('button_text' in object) {
    message.button_text = textField(object.button_text, `${path}.button_text`, { max: 64 });
  }
  return message;
}

function containsDraftContent(value) {
  if (typeof value === 'string') {
    if (DRAFT_MARKER.test(value)) return true;
    try {
      const url = new URL(value);
      return url.hostname === 'example.com'
        || url.hostname.endsWith('.example.com')
        || url.hostname === 'placeholder.invalid'
        || url.hostname.endsWith('.placeholder.invalid');
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(containsDraftContent);
  if (value && typeof value === 'object') return Object.values(value).some(containsDraftContent);
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function extractJson(markdown) {
  if (typeof markdown !== 'string') throw scenarioError('file content must be text');
  const begin = markdown.indexOf(SCENARIO_BEGIN);
  const end = markdown.indexOf(SCENARIO_END);
  if (begin < 0 || end < 0 || end <= begin) {
    throw scenarioError('the JSON begin/end markers are missing or out of order');
  }
  if (markdown.indexOf(SCENARIO_BEGIN, begin + SCENARIO_BEGIN.length) >= 0
    || markdown.indexOf(SCENARIO_END, end + SCENARIO_END.length) >= 0) {
    throw scenarioError('the JSON begin/end markers must appear exactly once');
  }
  const section = markdown.slice(begin + SCENARIO_BEGIN.length, end).trim();
  const match = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/u.exec(section);
  if (!match) throw scenarioError('the marked section must contain exactly one fenced json block');
  return match[1];
}

export function parseScenarioMarkdown(markdown, { allowDraftScenario = false } = {}) {
  let parsed;
  try {
    const rawJson = extractJson(markdown);
    assertNoDuplicateJsonKeys(rawJson);
    parsed = JSON.parse(rawJson);
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) throw scenarioError(error.message);
    if (error.message.startsWith('Gatekeeper scenario is invalid:')) throw error;
    if (error.message.startsWith('raw JSON duplicate-key scan failed closed:')) {
      throw scenarioError(error.message);
    }
    throw scenarioError(`JSON cannot be parsed: ${error.message}`);
  }

  const root = assertPlainObject(parsed, 'root');
  assertKnownKeys(root, new Set(['schema_version', 'scenario_id', 'status', 'messages']), 'root');
  if (root.schema_version !== 2) throw scenarioError('schema_version must be 2');
  if (root.scenario_id !== SCENARIO_ID) throw scenarioError(`scenario_id must be ${SCENARIO_ID}`);
  if (!['draft', 'ready'].includes(root.status)) throw scenarioError('status must be draft or ready');

  const sourceMessages = assertPlainObject(root.messages, 'root.messages');
  const messageKeys = new Set([...ACTIVE_MESSAGE_IDS, ...PLANNED_MESSAGE_IDS]);
  assertKnownKeys(sourceMessages, messageKeys, 'root.messages');
  for (const key of messageKeys) {
    if (!(key in sourceMessages)) throw scenarioError(`root.messages.${key} is required`);
  }

  const messages = {
    group_invitation: validateGroupInvitation(sourceMessages.group_invitation, 'root.messages.group_invitation'),
    start_missing_token: textMessage(sourceMessages.start_missing_token, 'root.messages.start_missing_token'),
    start_invalid_token: textMessage(sourceMessages.start_invalid_token, 'root.messages.start_invalid_token'),
    start_payment_not_confirmed: textMessage(
      sourceMessages.start_payment_not_confirmed,
      'root.messages.start_payment_not_confirmed',
    ),
    start_expired_token: textMessage(sourceMessages.start_expired_token, 'root.messages.start_expired_token'),
    start_already_completed: textMessage(
      sourceMessages.start_already_completed,
      'root.messages.start_already_completed',
    ),
    private_instruction: validatePrivateInstruction(sourceMessages.private_instruction, 'root.messages.private_instruction'),
    email_invalid: textMessage(sourceMessages.email_invalid, 'root.messages.email_invalid'),
    email_accepted: validateCompletionPrompt(sourceMessages.email_accepted, 'root.messages.email_accepted'),
    completion_invalid_user: callbackMessage(
      sourceMessages.completion_invalid_user,
      'root.messages.completion_invalid_user',
    ),
    completion_before_start: callbackMessage(
      sourceMessages.completion_before_start,
      'root.messages.completion_before_start',
    ),
    completion_before_email: callbackMessage(
      sourceMessages.completion_before_email,
      'root.messages.completion_before_email',
    ),
    completion_already_completed: callbackMessage(
      sourceMessages.completion_already_completed,
      'root.messages.completion_already_completed',
    ),
    completion_success: validateCompletionSuccess(
      sourceMessages.completion_success,
      'root.messages.completion_success',
    ),
    site_email_instruction: validateSiteEmailInstruction(
      sourceMessages.site_email_instruction,
      'root.messages.site_email_instruction',
    ),
    site_instruction: validateSiteInstruction(
      sourceMessages.site_instruction,
      'root.messages.site_instruction',
    ),
    site_invalid_link: textMessage(sourceMessages.site_invalid_link, 'root.messages.site_invalid_link'),
    site_completion_success: textMessage(
      sourceMessages.site_completion_success,
      'root.messages.site_completion_success',
    ),
    site_completion_already_completed: textMessage(
      sourceMessages.site_completion_already_completed,
      'root.messages.site_completion_already_completed',
    ),
  };
  for (const id of PLANNED_MESSAGE_IDS) messages[id] = validatePlannedMessage(sourceMessages[id], id);

  const scenario = {
    schema_version: 2,
    scenario_id: SCENARIO_ID,
    status: root.status,
    messages,
  };

  const activeRuntimeMessages = Object.fromEntries(
    ACTIVE_MESSAGE_IDS.map((id) => [id, scenario.messages[id]]),
  );
  const hasDraftContent = containsDraftContent(activeRuntimeMessages);
  if (scenario.status === 'ready' && hasDraftContent) {
    throw scenarioError('ready scenarios must not contain placeholder markers or placeholder/example links');
  }
  if (scenario.status === 'draft' && !allowDraftScenario) {
    throw scenarioError('draft status is allowed only by the direct offline simulator/test harness');
  }
  return deepFreeze(scenario);
}

export function createScenarioProvider({
  scenarioPath = DEFAULT_SCENARIO_PATH,
  allowDraftScenario = false,
  readFile = fs.readFileSync,
} = {}) {
  if (typeof scenarioPath !== 'string' || !scenarioPath.trim()) {
    throw scenarioError('scenarioPath must be a non-empty path');
  }
  return Object.freeze({
    scenarioPath,
    load() {
      let markdown;
      try {
        markdown = readFile(scenarioPath, 'utf8');
      } catch (error) {
        throw scenarioError(`cannot read ${scenarioPath}: ${error.message}`);
      }
      return parseScenarioMarkdown(markdown, { allowDraftScenario });
    },
  });
}

export { SCENARIO_BEGIN, SCENARIO_END };
