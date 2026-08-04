import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SCENARIO_PATH,
  parseScenarioMarkdown,
  SCENARIO_BEGIN,
  SCENARIO_END,
} from './scenario.mjs';

export const DEFAULT_SCENARIO_TEXTS_PATH = fileURLToPath(
  new URL('../SCENARIO_TEXTS.md', import.meta.url),
);

const ACTIVE = 'active';
const PLANNED = 'planned';
const USER = 'user';
const ADMIN = 'admin';

function field(target, humanId, label = 'reply') {
  return Object.freeze({ target, humanId, label });
}

function message(status, audience, fields, links = undefined) {
  return Object.freeze({ status, audience, fields: Object.freeze(fields), links });
}

const SIMPLE_ACTIVE_TEXT_IDS = [
  'start_missing_token',
  'start_invalid_token',
  'start_payment_not_confirmed',
  'start_expired_token',
  'start_already_completed',
  'email_invalid',
  'site_invalid_link',
  'site_completion_success',
  'site_completion_already_completed',
];

const CALLBACK_ACTIVE_IDS = [
  'completion_invalid_user',
  'completion_before_start',
  'completion_before_email',
  'completion_already_completed',
];

const PLANNED_AUDIENCES = Object.freeze({
  illegitimate_removal_notice: USER,
  activation_reminder: USER,
  activation_escalation_admin: ADMIN,
  non_tribute_private_instruction: USER,
  tribute_confirmation_retry: USER,
  other_confirmation_retry: USER,
  confirmation_escalation_admin: ADMIN,
  post_confirmation_check: USER,
  support_handoff: USER,
  question_router_clarification: USER,
  local_dialog_boundary: USER,
});

const TWO_PRODUCT_LINKS = Object.freeze({
  humanId: 'private_instruction',
  ids: Object.freeze(['community_rules_url', 'newcomer_material_url']),
});

const TWO_SITE_LINKS = Object.freeze({
  humanId: 'site_instruction',
  ids: Object.freeze(['community_rules_url', 'newcomer_material_url']),
});

const MESSAGE_SPECS = {
  group_invitation: message(ACTIVE, USER, [
    field('text', 'group_invitation'),
    field('button_text', 'group_invitation', 'button'),
  ]),
  private_instruction: message(
    ACTIVE,
    USER,
    [field('text', 'private_instruction')],
    TWO_PRODUCT_LINKS,
  ),
  email_accepted: message(ACTIVE, USER, [
    field('text', 'email_accepted'),
    field('completion_button_text', 'email_accepted', 'button'),
  ]),
  completion_success: message(ACTIVE, USER, [
    field('callback_text', 'completion_success_callback'),
    field('dm_text', 'completion_success_dm'),
  ]),
  site_email_instruction: message(ACTIVE, USER, [
    field('subject', 'site_email_subject'),
    field('text', 'site_email_instruction'),
    field('button_text', 'site_email_instruction', 'button'),
  ]),
  site_instruction: message(
    ACTIVE,
    USER,
    [
      field('text', 'site_instruction'),
      field('completion_button_text', 'site_instruction', 'button'),
    ],
    TWO_SITE_LINKS,
  ),
};

for (const id of SIMPLE_ACTIVE_TEXT_IDS) {
  MESSAGE_SPECS[id] = message(ACTIVE, USER, [field('text', id)]);
}
for (const id of CALLBACK_ACTIVE_IDS) {
  MESSAGE_SPECS[id] = message(ACTIVE, USER, [field('callback_text', id)]);
}
for (const [id, audience] of Object.entries(PLANNED_AUDIENCES)) {
  MESSAGE_SPECS[id] = message(PLANNED, audience, [field('text', id)]);
}
Object.freeze(MESSAGE_SPECS);

const SERVICE_NOTE_IDS = Object.freeze([
  'site_registration_received',
  'zapier_onboarding_completed',
]);

function syncError(message) {
  return new Error(`Scenario texts sync failed: ${message}`);
}

function labelKey(kind, linkId = undefined) {
  return linkId ? `${kind}:${linkId}` : kind;
}

function expectedHumanShapes() {
  const shapes = new Map();
  const add = (id, key) => {
    if (!shapes.has(id)) shapes.set(id, new Set());
    shapes.get(id).add(key);
  };

  for (const spec of Object.values(MESSAGE_SPECS)) {
    for (const item of spec.fields) add(item.humanId, item.label);
    if (spec.links) {
      for (const id of spec.links.ids) {
        add(spec.links.humanId, labelKey('url', id));
        add(spec.links.humanId, labelKey('link_label', id));
      }
    }
  }
  for (const id of SERVICE_NOTE_IDS) add(id, 'reply');
  return shapes;
}

const HUMAN_SHAPES = expectedHumanShapes();

function assertExactKeys(actual, expected, pathName) {
  const actualKeys = [...actual].sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    const missing = expectedKeys.filter((key) => !actual.has(key));
    const unknown = actualKeys.filter((key) => !expected.has(key));
    const details = [];
    if (missing.length) details.push(`missing ${missing.join(', ')}`);
    if (unknown.length) details.push(`unknown ${unknown.join(', ')}`);
    throw syncError(`${pathName} has the wrong labels (${details.join('; ')})`);
  }
}

export function parseScenarioTexts(markdown) {
  if (typeof markdown !== 'string') throw syncError('SCENARIO_TEXTS.md must be text');
  if (markdown.includes(SCENARIO_BEGIN) || markdown.includes(SCENARIO_END)) {
    throw syncError('SCENARIO_TEXTS.md must not contain scenario service markers');
  }
  if (/^```json[\t ]*$/imu.test(markdown)) {
    throw syncError('SCENARIO_TEXTS.md must not contain a fenced JSON block');
  }

  const entries = new Map();
  let currentEntry = null;
  let currentLabel = null;
  let valueLines = [];

  function finishLabel() {
    if (!currentLabel) return;
    const value = valueLines.join('\n').trim();
    if (!value) {
      throw syncError(`${currentEntry.id}.${currentLabel} must not be empty`);
    }
    currentEntry.values.set(currentLabel, value);
    currentLabel = null;
    valueLines = [];
  }

  function beginLabel(key) {
    if (!currentEntry) throw syncError(`${key} appears before a message heading`);
    finishLabel();
    if (currentEntry.values.has(key)) {
      throw syncError(`duplicate label ${key} in ${currentEntry.id}`);
    }
    currentLabel = key;
  }

  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    if (line.startsWith('### ')) {
      finishLabel();
      const match = /^### `([a-z][a-z0-9_]*)`(?:[\t ]+—[^\n]*)?[\t ]*$/u.exec(line);
      if (!match) throw syncError(`invalid message heading at line ${lineNumber}`);
      const id = match[1];
      if (!HUMAN_SHAPES.has(id)) throw syncError(`unknown message ID ${id}`);
      if (entries.has(id)) throw syncError(`duplicate message ID ${id}`);
      currentEntry = { id, values: new Map() };
      entries.set(id, currentEntry);
      continue;
    }
    if (line.startsWith('## ')) {
      finishLabel();
      currentEntry = null;
      continue;
    }

    if (/^Реплика:[\t ]*$/u.test(line)) {
      beginLabel('reply');
      continue;
    }
    if (/^Кнопка:[\t ]*$/u.test(line)) {
      beginLabel('button');
      continue;
    }
    let match = /^Ссылка `([a-z][a-z0-9_]*)`:[\t ]*$/u.exec(line);
    if (match) {
      beginLabel(labelKey('url', match[1]));
      continue;
    }
    match = /^Подпись ссылки `([a-z][a-z0-9_]*)`:[\t ]*$/u.exec(line);
    if (match) {
      beginLabel(labelKey('link_label', match[1]));
      continue;
    }

    if (currentLabel) {
      valueLines.push(line);
    } else if (currentEntry && line.trim()) {
      throw syncError(`content outside a labeled value in ${currentEntry.id} at line ${lineNumber}`);
    }
  }
  finishLabel();

  assertExactKeys(new Set(entries.keys()), new Set(HUMAN_SHAPES.keys()), 'SCENARIO_TEXTS.md');
  for (const [id, expected] of HUMAN_SHAPES) {
    assertExactKeys(new Set(entries.get(id).values.keys()), expected, id);
  }
  for (const id of SERVICE_NOTE_IDS) {
    if (!entries.get(id).values.get('reply').startsWith('Нет.')) {
      throw syncError(`${id}.reply must explicitly begin with "Нет."`);
    }
  }

  return entries;
}

function normalizeHumanCopy(value) {
  if (!value.startsWith('[НАПИШИТЕ') || !value.endsWith(']')) return value;
  let instruction = value.slice('[НАПИШИТЕ'.length, -1).trim();
  const colon = instruction.indexOf(':');
  if (colon >= 0) {
    const directive = instruction.slice(0, colon).trim();
    if (/^ТЕКСТ(?: ПИСЬМА| АДМИНИСТРАТОРУ)?$/u.test(directive)) {
      instruction = instruction.slice(colon + 1).trim();
    }
  }
  if (!instruction) throw syncError('an editor placeholder must describe the missing copy');
  return `[ЗАГЛУШКА: ${instruction}]`;
}

function normalizeHumanUrl(value, linkId) {
  if (value === '[ВСТАВЬТЕ HTTPS-ССЫЛКУ]') {
    return `https://placeholder.invalid/${linkId}`;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw syncError(`${linkId} must be an HTTPS URL or [ВСТАВЬТЕ HTTPS-ССЫЛКУ]`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw syncError(`${linkId} must be an HTTPS URL without credentials`);
  }
  return value;
}

function extractScenarioJson(markdown) {
  parseScenarioMarkdown(markdown, { allowDraftScenario: true });
  const begin = markdown.indexOf(SCENARIO_BEGIN);
  const end = markdown.indexOf(SCENARIO_END);
  const section = markdown.slice(begin + SCENARIO_BEGIN.length, end).trim();
  const match = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/u.exec(section);
  if (!match) throw syncError('ONBOARDING_SCENARIO.md JSON block is malformed');
  return JSON.parse(match[1]);
}

function assertMachineContract(root) {
  const actualIds = new Set(Object.keys(root.messages));
  const expectedIds = new Set(Object.keys(MESSAGE_SPECS));
  assertExactKeys(actualIds, expectedIds, 'root.messages');

  for (const [id, spec] of Object.entries(MESSAGE_SPECS)) {
    const item = root.messages[id];
    if (item.status !== spec.status) {
      throw syncError(`root.messages.${id}.status must remain ${spec.status}`);
    }
    if (item.audience !== spec.audience) {
      throw syncError(`root.messages.${id}.audience must remain ${spec.audience}`);
    }
    const expectedCopyKeys = new Set(spec.fields.map((entry) => entry.target));
    if (spec.links) expectedCopyKeys.add('links');
    const actualCopyKeys = new Set(Object.keys(item).filter(
      (key) => key !== 'status' && key !== 'audience' && !key.startsWith('_comment'),
    ));
    assertExactKeys(actualCopyKeys, expectedCopyKeys, `root.messages.${id}`);
    if (spec.links && item.links.length !== spec.links.ids.length) {
      throw syncError(`root.messages.${id}.links must contain exactly ${spec.links.ids.length} links`);
    }
  }
}

function getHumanValue(entries, humanId, label) {
  return entries.get(humanId).values.get(label);
}

function copyProjection(root) {
  const projection = { status: root.status, messages: {} };
  for (const [id, spec] of Object.entries(MESSAGE_SPECS)) {
    const source = root.messages[id];
    const item = {};
    for (const entry of spec.fields) item[entry.target] = source[entry.target];
    if (spec.links) {
      item.links = source.links.map((link) => ({ label: link.label, url: link.url }));
    }
    projection.messages[id] = item;
  }
  return projection;
}

function nonCopyProjection(root) {
  const clone = JSON.parse(JSON.stringify(root));
  delete clone.status;
  for (const [id, spec] of Object.entries(MESSAGE_SPECS)) {
    const item = clone.messages[id];
    for (const entry of spec.fields) delete item[entry.target];
    if (spec.links) {
      for (const link of item.links) {
        delete link.label;
        delete link.url;
      }
    }
  }
  return clone;
}

function hasDraftContent(value) {
  if (typeof value === 'string') {
    if (/\[(?:ЗАГЛУШКА|PLACEHOLDER)(?::[^\]]*)?\]/iu.test(value)) return true;
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
  if (Array.isArray(value)) return value.some(hasDraftContent);
  if (value && typeof value === 'object') return Object.values(value).some(hasDraftContent);
  return false;
}

function applyHumanCopy(root, entries) {
  for (const [id, spec] of Object.entries(MESSAGE_SPECS)) {
    const target = root.messages[id];
    for (const entry of spec.fields) {
      target[entry.target] = normalizeHumanCopy(
        getHumanValue(entries, entry.humanId, entry.label),
      );
    }
    if (spec.links) {
      for (let index = 0; index < spec.links.ids.length; index += 1) {
        const linkId = spec.links.ids[index];
        target.links[index].url = normalizeHumanUrl(
          getHumanValue(entries, spec.links.humanId, labelKey('url', linkId)),
          linkId,
        );
        target.links[index].label = normalizeHumanCopy(
          getHumanValue(entries, spec.links.humanId, labelKey('link_label', linkId)),
        );
      }
    }
  }

  const activeCopy = {};
  const projection = copyProjection(root);
  for (const [id, spec] of Object.entries(MESSAGE_SPECS)) {
    if (spec.status === ACTIVE) activeCopy[id] = projection.messages[id];
  }
  if (hasDraftContent(activeCopy)) root.status = 'draft';
}

function renderScenarioMarkdown(original, root) {
  const begin = original.indexOf(SCENARIO_BEGIN);
  const end = original.indexOf(SCENARIO_END);
  return `${original.slice(0, begin + SCENARIO_BEGIN.length)}\n`
    + `\`\`\`json\n${JSON.stringify(root, null, 2)}\n\`\`\`\n`
    + original.slice(end);
}

function diffCopy(current, desired) {
  const currentProjection = copyProjection(current);
  const desiredProjection = copyProjection(desired);
  const differences = [];
  if (currentProjection.status !== desiredProjection.status) differences.push('root.status');
  for (const [id, spec] of Object.entries(MESSAGE_SPECS)) {
    for (const entry of spec.fields) {
      if (currentProjection.messages[id][entry.target] !== desiredProjection.messages[id][entry.target]) {
        differences.push(`root.messages.${id}.${entry.target}`);
      }
    }
    if (spec.links) {
      for (let index = 0; index < spec.links.ids.length; index += 1) {
        for (const key of ['label', 'url']) {
          if (currentProjection.messages[id].links[index][key]
            !== desiredProjection.messages[id].links[index][key]) {
            differences.push(`root.messages.${id}.links[${index}].${key}`);
          }
        }
      }
    }
  }
  return differences;
}

export function synchronizeScenarioTexts({ textsMarkdown, scenarioMarkdown }) {
  const entries = parseScenarioTexts(textsMarkdown);
  const current = extractScenarioJson(scenarioMarkdown);
  assertMachineContract(current);
  const desired = JSON.parse(JSON.stringify(current));
  const beforeNonCopy = nonCopyProjection(current);
  applyHumanCopy(desired, entries);
  if (JSON.stringify(beforeNonCopy) !== JSON.stringify(nonCopyProjection(desired))) {
    throw syncError('internal guard detected a non-copy scenario mutation');
  }
  const differences = diffCopy(current, desired);
  const markdown = differences.length ? renderScenarioMarkdown(scenarioMarkdown, desired) : scenarioMarkdown;
  parseScenarioMarkdown(markdown, { allowDraftScenario: true });
  return Object.freeze({
    markdown,
    differences: Object.freeze(differences),
    messageCount: Object.keys(MESSAGE_SPECS).length,
    humanEntryCount: entries.size,
  });
}

export function checkScenarioTexts(options) {
  const result = synchronizeScenarioTexts(options);
  if (result.differences.length) {
    throw syncError(
      `ONBOARDING_SCENARIO.md is out of sync at ${result.differences.join(', ')}; run npm run scenario:sync`,
    );
  }
  return result;
}

function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const mode = fs.statSync(filePath).mode;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode });
    fs.renameSync(temporary, filePath);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function runScenarioTextsCommand(
  command,
  {
    textsPath = DEFAULT_SCENARIO_TEXTS_PATH,
    scenarioPath = DEFAULT_SCENARIO_PATH,
    readFile = fs.readFileSync,
    writeFile = atomicWrite,
  } = {},
) {
  if (!['check', 'sync'].includes(command)) {
    throw syncError('command must be check or sync');
  }
  const textsMarkdown = readFile(textsPath, 'utf8');
  const scenarioMarkdown = readFile(scenarioPath, 'utf8');
  if (command === 'check') {
    return checkScenarioTexts({ textsMarkdown, scenarioMarkdown });
  }
  const result = synchronizeScenarioTexts({ textsMarkdown, scenarioMarkdown });
  if (result.differences.length) writeFile(scenarioPath, result.markdown);
  return result;
}
