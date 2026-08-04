import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import {
  checkScenarioTexts,
  parseScenarioTexts,
  runScenarioTextsCommand,
  synchronizeScenarioTexts,
} from '../src/scenario-texts.mjs';
import {
  parseScenarioMarkdown,
  SCENARIO_BEGIN,
  SCENARIO_END,
} from '../src/scenario.mjs';

const textsMarkdown = fs.readFileSync(new URL('../SCENARIO_TEXTS.md', import.meta.url), 'utf8');
const scenarioMarkdown = fs.readFileSync(new URL('../ONBOARDING_SCENARIO.md', import.meta.url), 'utf8');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function entryBounds(source, id) {
  const start = source.indexOf(`### \`${id}\``);
  assert.notEqual(start, -1, id);
  const nextMessage = source.indexOf('\n### `', start + 1);
  const nextSection = source.indexOf('\n## ', start + 1);
  const candidates = [nextMessage, nextSection].filter((index) => index >= 0);
  return { start, end: candidates.length ? Math.min(...candidates) : source.length };
}

function setHumanValue(source, id, label, value) {
  const { start, end } = entryBounds(source, id);
  const section = source.slice(start, end);
  const nextLabel = '(?:Реплика|Кнопка|Ссылка `[^`]+`|Подпись ссылки `[^`]+`)';
  const expression = new RegExp(
    `(${escapeRegExp(label)}:[\\t ]*\\n\\n)([\\s\\S]*?)(?=\\n\\n${nextLabel}:[\\t ]*\\n|$)`,
    'u',
  );
  assert.match(section, expression, `${id}.${label}`);
  const updated = section.replace(expression, `$1${value}`);
  return `${source.slice(0, start)}${updated}${source.slice(end)}`;
}

function removeHumanEntry(source, id) {
  const { start, end } = entryBounds(source, id);
  return `${source.slice(0, start)}${source.slice(end)}`;
}

function parseRawScenario(source) {
  const begin = source.indexOf(SCENARIO_BEGIN);
  const end = source.indexOf(SCENARIO_END);
  const section = source.slice(begin + SCENARIO_BEGIN.length, end).trim();
  const match = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/u.exec(section);
  assert.ok(match);
  return JSON.parse(match[1]);
}

describe('human-only scenario text synchronization', () => {
  test('checked-in human file is complete, marker-free, and synchronized', () => {
    assert.doesNotMatch(textsMarkdown, /GATEKEEPER_SCENARIO_JSON_(?:BEGIN|END)/u);
    assert.doesNotMatch(textsMarkdown, /^```json[\t ]*$/imu);
    const entries = parseScenarioTexts(textsMarkdown);
    assert.equal(entries.size, 34);
    const result = checkScenarioTexts({ textsMarkdown, scenarioMarkdown });
    assert.equal(result.messageCount, 30);
    assert.deepEqual(result.differences, []);
  });

  test('maps split composites and both Telegram/site link catalogs mechanically', () => {
    let edited = setHumanValue(
      textsMarkdown,
      'completion_success_callback',
      'Реплика',
      'Callback copy from the human file.',
    );
    edited = setHumanValue(
      edited,
      'completion_success_dm',
      'Реплика',
      'Final DM copy from the human file.',
    );
    edited = setHumanValue(edited, 'site_email_subject', 'Реплика', 'Email subject');
    edited = setHumanValue(edited, 'site_email_instruction', 'Реплика', 'Email body');
    edited = setHumanValue(edited, 'site_email_instruction', 'Кнопка', 'Open onboarding');
    edited = setHumanValue(edited, 'site_instruction', 'Реплика', 'Site body');
    edited = setHumanValue(
      edited,
      'site_instruction',
      'Ссылка `community_rules_url`',
      'https://docs.test/rules',
    );
    edited = setHumanValue(
      edited,
      'site_instruction',
      'Подпись ссылки `community_rules_url`',
      'Site rules',
    );
    edited = setHumanValue(
      edited,
      'private_instruction',
      'Ссылка `newcomer_material_url`',
      'https://docs.test/newcomer',
    );
    edited = setHumanValue(
      edited,
      'private_instruction',
      'Подпись ссылки `newcomer_material_url`',
      'Telegram newcomer material',
    );
    edited = setHumanValue(
      edited,
      'non_tribute_private_instruction',
      'Реплика',
      'Planned non-Tribute copy.',
    );

    const result = synchronizeScenarioTexts({ textsMarkdown: edited, scenarioMarkdown });
    const scenario = parseScenarioMarkdown(result.markdown, { allowDraftScenario: true });
    assert.equal(scenario.messages.completion_success.callback_text, 'Callback copy from the human file.');
    assert.equal(scenario.messages.completion_success.dm_text, 'Final DM copy from the human file.');
    assert.equal(scenario.messages.site_email_instruction.subject, 'Email subject');
    assert.equal(scenario.messages.site_email_instruction.text, 'Email body');
    assert.equal(scenario.messages.site_email_instruction.button_text, 'Open onboarding');
    assert.equal(scenario.messages.site_instruction.text, 'Site body');
    assert.deepEqual(scenario.messages.site_instruction.links[0], {
      label: 'Site rules', url: 'https://docs.test/rules',
    });
    assert.deepEqual(scenario.messages.private_instruction.links[1], {
      label: 'Telegram newcomer material', url: 'https://docs.test/newcomer',
    });
    assert.equal(scenario.messages.non_tribute_private_instruction.text, 'Planned non-Tribute copy.');
    assert.doesNotThrow(() => checkScenarioTexts({
      textsMarkdown: edited,
      scenarioMarkdown: result.markdown,
    }));
  });

  test('normalizes editor placeholders into runtime-recognized draft values', () => {
    const result = synchronizeScenarioTexts({ textsMarkdown, scenarioMarkdown });
    const scenario = parseScenarioMarkdown(result.markdown, { allowDraftScenario: true });
    assert.equal(
      scenario.messages.site_email_instruction.subject,
      '[ЗАГЛУШКА: ТЕМУ ПИСЬМА С ИНСТРУКЦИЕЙ]',
    );
    assert.equal(
      scenario.messages.site_instruction.links[0].url,
      'https://placeholder.invalid/community_rules_url',
    );
    assert.equal(scenario.status, 'draft');
  });

  test('mutates only copy and the fail-safe root status', () => {
    const edited = setHumanValue(
      textsMarkdown,
      'group_invitation',
      'Кнопка',
      'Updated button',
    );
    const before = parseRawScenario(scenarioMarkdown);
    const result = synchronizeScenarioTexts({ textsMarkdown: edited, scenarioMarkdown });
    const after = parseRawScenario(result.markdown);
    assert.equal(after.messages.group_invitation.button_text, 'Updated button');
    assert.equal(after.schema_version, before.schema_version);
    assert.equal(after.scenario_id, before.scenario_id);
    assert.equal(after.messages.group_invitation.status, before.messages.group_invitation.status);
    assert.equal(after.messages.group_invitation.audience, before.messages.group_invitation.audience);
    assert.equal(after.messages.group_invitation._comment, before.messages.group_invitation._comment);
    assert.deepEqual(after.messages.private_instruction, before.messages.private_instruction);
  });

  test('demotes ready to draft for active placeholders but ignores planned placeholders', () => {
    const realTexts = textsMarkdown
      .replace(/\[НАПИШИТЕ[^\]\n]*\]/gu, 'Готовый текст')
      .replaceAll('[ВСТАВЬТЕ HTTPS-ССЫЛКУ]', 'https://docs.test/value');
    const realResult = synchronizeScenarioTexts({
      textsMarkdown: realTexts,
      scenarioMarkdown,
    });
    const readyScenario = realResult.markdown.replace('"status": "draft"', '"status": "ready"');
    assert.equal(parseScenarioMarkdown(readyScenario).status, 'ready');

    const demoted = synchronizeScenarioTexts({ textsMarkdown, scenarioMarkdown: readyScenario });
    assert.equal(parseRawScenario(demoted.markdown).status, 'draft');
    assert.ok(demoted.differences.includes('root.status'));

    const plannedPlaceholder = setHumanValue(
      realTexts,
      'support_handoff',
      'Реплика',
      '[НАПИШИТЕ ТЕКСТ: planned copy]',
    );
    const stillReady = synchronizeScenarioTexts({
      textsMarkdown: plannedPlaceholder,
      scenarioMarkdown: readyScenario,
    });
    assert.equal(parseRawScenario(stillReady.markdown).status, 'ready');
    assert.equal(parseScenarioMarkdown(stillReady.markdown).status, 'ready');
  });

  test('check reports every mismatched machine field without writing', () => {
    const edited = setHumanValue(textsMarkdown, 'email_invalid', 'Реплика', 'Changed email copy');
    assert.throws(
      () => checkScenarioTexts({ textsMarkdown: edited, scenarioMarkdown }),
      /root\.messages\.email_invalid\.text.*scenario:sync/u,
    );
  });

  test('fails closed instead of repairing machine-owned status or IDs', () => {
    const wrongStatus = scenarioMarkdown.replace(
      '"group_invitation": {\n      "_comment":',
      '"group_invitation": {\n      "status": "planned",\n      "_comment":',
    ).replace(
      '      "status": "active",\n      "audience": "user",\n      "text": "👋',
      '      "audience": "user",\n      "text": "👋',
    );
    assert.throws(
      () => synchronizeScenarioTexts({ textsMarkdown, scenarioMarkdown: wrongStatus }),
      /group_invitation\.status must be active/u,
    );

    const unknownId = scenarioMarkdown.replace(
      '    "group_invitation": {',
      '    "unknown_runtime_message": {"status":"active","audience":"user","text":"x"},\n    "group_invitation": {',
    );
    assert.throws(
      () => synchronizeScenarioTexts({ textsMarkdown, scenarioMarkdown: unknownId }),
      /unknown_runtime_message is not supported/u,
    );
  });

  test('fails closed on duplicate IDs and labels', () => {
    const duplicateId = `${textsMarkdown}\n\n### \`group_invitation\` — duplicate\n\nРеплика:\n\nduplicate\n\nКнопка:\n\nduplicate\n`;
    assert.throws(() => parseScenarioTexts(duplicateId), /duplicate message ID group_invitation/u);

    const duplicateLabel = setHumanValue(
      textsMarkdown,
      'start_missing_token',
      'Реплика',
      'first\n\nРеплика:\n\nsecond',
    );
    assert.throws(() => parseScenarioTexts(duplicateLabel), /duplicate label reply/u);
  });

  test('fails closed on missing entries or labels and unknown IDs', () => {
    assert.throws(
      () => parseScenarioTexts(removeHumanEntry(textsMarkdown, 'support_handoff')),
      /missing support_handoff/u,
    );
    const unknownId = textsMarkdown.replace(
      '### `support_handoff`',
      '### `unknown_handoff`',
    );
    assert.throws(() => parseScenarioTexts(unknownId), /unknown message ID unknown_handoff/u);

    const missingLabel = setHumanValue(
      textsMarkdown,
      'email_accepted',
      'Кнопка',
      'temporary',
    ).replace(/\n\nКнопка:\n\ntemporary/u, '');
    assert.throws(() => parseScenarioTexts(missingLabel), /email_accepted.*missing button/u);
  });

  test('fails closed on duplicate, missing, or unknown named link labels', () => {
    const duplicateLink = setHumanValue(
      textsMarkdown,
      'private_instruction',
      'Ссылка `community_rules_url`',
      '[ВСТАВЬТЕ HTTPS-ССЫЛКУ]\n\nСсылка `community_rules_url`:\n\nhttps://docs.test/duplicate',
    );
    assert.throws(() => parseScenarioTexts(duplicateLink), /duplicate label url:community_rules_url/u);

    const unknownLink = textsMarkdown.replace(
      'Ссылка `newcomer_material_url`:',
      'Ссылка `unknown_url`:',
    );
    assert.throws(
      () => parseScenarioTexts(unknownLink),
      /private_instruction.*missing url:newcomer_material_url.*unknown url:unknown_url/u,
    );
  });

  test('rejects machine markers and JSON blocks in the human file', () => {
    assert.throws(
      () => parseScenarioTexts(`${SCENARIO_BEGIN}\n${textsMarkdown}`),
      /must not contain scenario service markers/u,
    );
    assert.throws(
      () => parseScenarioTexts(`\`\`\`json\n{}\n\`\`\`\n${textsMarkdown}`),
      /must not contain a fenced JSON block/u,
    );
  });

  test('command layer writes only on sync and then passes check', () => {
    const edited = setHumanValue(textsMarkdown, 'email_invalid', 'Реплика', 'CLI copy');
    let written = null;
    const paths = { textsPath: '/virtual/SCENARIO_TEXTS.md', scenarioPath: '/virtual/ONBOARDING_SCENARIO.md' };
    const readFile = (filePath) => (filePath === paths.textsPath ? edited : (written || scenarioMarkdown));
    const writeFile = (filePath, content) => {
      assert.equal(filePath, paths.scenarioPath);
      written = content;
    };
    const result = runScenarioTextsCommand('sync', { ...paths, readFile, writeFile });
    assert.ok(result.differences.includes('root.messages.email_invalid.text'));
    assert.ok(written);
    assert.doesNotThrow(() => runScenarioTextsCommand('check', {
      ...paths, readFile, writeFile,
    }));
  });
});
