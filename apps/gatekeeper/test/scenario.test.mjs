import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import {
  createScenarioProvider,
  DEFAULT_SCENARIO_PATH,
  parseScenarioMarkdown,
  SCENARIO_BEGIN,
  SCENARIO_END,
} from '../src/scenario.mjs';

const markdown = fs.readFileSync(DEFAULT_SCENARIO_PATH, 'utf8');
const ACTIVE_IDS = [
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
];
const PLANNED_AUDIENCES = {
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
};

function editScenario(source, edit) {
  const begin = source.indexOf(SCENARIO_BEGIN);
  const end = source.indexOf(SCENARIO_END);
  assert.notEqual(begin, -1);
  assert.notEqual(end, -1);
  const section = source.slice(begin + SCENARIO_BEGIN.length, end).trim();
  const match = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/u.exec(section);
  assert.ok(match);
  const value = JSON.parse(match[1]);
  edit(value);
  const replacement = `${SCENARIO_BEGIN}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n${SCENARIO_END}`;
  return `${source.slice(0, begin)}${replacement}${source.slice(end + SCENARIO_END.length)}`;
}

function editRawScenarioJson(source, editRaw) {
  const begin = source.indexOf(SCENARIO_BEGIN);
  const end = source.indexOf(SCENARIO_END);
  assert.notEqual(begin, -1);
  assert.notEqual(end, -1);
  const section = source.slice(begin + SCENARIO_BEGIN.length, end).trim();
  const match = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/u.exec(section);
  assert.ok(match);
  const replacement = `${SCENARIO_BEGIN}\n\`\`\`json\n${editRaw(match[1])}\n\`\`\`\n${SCENARIO_END}`;
  return `${source.slice(0, begin)}${replacement}${source.slice(end + SCENARIO_END.length)}`;
}

function makeActiveCopyReady(value) {
  value.status = 'ready';
  value.messages.private_instruction.links[0].url = 'https://community.test/rules';
  value.messages.private_instruction.links[1].url = 'https://community.test/getting-started';
  value.messages.site_email_instruction.subject = 'Инструкция по онбордингу';
  value.messages.site_email_instruction.text = 'Откройте персональную ссылку из письма.';
  value.messages.site_instruction.text = 'Прочитайте материалы и подтвердите завершение.';
  value.messages.site_instruction.links[0].url = 'https://community.test/rules';
  value.messages.site_instruction.links[1].url = 'https://community.test/getting-started';
  value.messages.site_invalid_link.text = 'Ссылка недействительна. Обратитесь к администратору.';
  value.messages.site_completion_success.text = 'Онбординг завершён.';
  value.messages.site_completion_already_completed.text = 'Онбординг уже завершён.';
}

describe('onboarding Markdown scenario', () => {
  test('parses the checked-in scenario under the gate required by its current status', () => {
    const scenario = parseScenarioMarkdown(markdown, { allowDraftScenario: true });
    assert.equal(scenario.schema_version, 2);
    assert.equal(scenario.scenario_id, 'telegram-gatekeeper-onboarding');
    assert.ok(['draft', 'ready'].includes(scenario.status));
    assert.ok(scenario.messages.private_instruction.links.length >= 1);
    assert.ok(scenario.messages.private_instruction.links.length <= 6);
    assert.equal(Object.isFrozen(scenario), true);
    assert.equal(Object.isFrozen(scenario.messages.private_instruction.links), true);
    assert.deepEqual(Object.keys(scenario.messages).sort(), [
      ...ACTIVE_IDS, ...Object.keys(PLANNED_AUDIENCES),
    ].sort());
    for (const id of ACTIVE_IDS) {
      assert.equal(scenario.messages[id].status, 'active', id);
      assert.equal(scenario.messages[id].audience, 'user', id);
      assert.equal(Object.isFrozen(scenario.messages[id]), true, id);
    }
    for (const [id, audience] of Object.entries(PLANNED_AUDIENCES)) {
      assert.equal(scenario.messages[id].status, 'planned', id);
      assert.equal(scenario.messages[id].audience, audience, id);
      assert.match(scenario.messages[id].text, /^\[ЗАГЛУШКА:/u, id);
      assert.equal(Object.isFrozen(scenario.messages[id]), true, id);
    }
    if (scenario.status === 'draft') {
      assert.throws(() => parseScenarioMarkdown(markdown), /draft status is allowed only/u);
    } else {
      assert.equal(parseScenarioMarkdown(markdown).status, 'ready');
    }
  });

  test('planned placeholders do not block ready after active placeholders are replaced', () => {
    const ready = editScenario(markdown, (value) => {
      makeActiveCopyReady(value);
    });
    const scenario = parseScenarioMarkdown(ready);
    assert.equal(scenario.status, 'ready');
    assert.equal(scenario.messages.illegitimate_removal_notice.status, 'planned');
    assert.match(scenario.messages.illegitimate_removal_notice.text, /^\[ЗАГЛУШКА:/u);
  });

  test('rejects launch-ready status while an active placeholder remains', () => {
    const falselyReady = editScenario(markdown, (value) => {
      makeActiveCopyReady(value);
      value.messages.start_missing_token.text = '[ЗАГЛУШКА: замените этот текст]';
    });
    assert.throws(() => parseScenarioMarkdown(falselyReady), /ready scenarios must not contain placeholder/u);
  });

  test('fails closed on missing, wrong-status, wrong-audience, or malformed planned entries', () => {
    const cases = [
      {
        edit(value) { delete value.messages.support_handoff; },
        error: /root\.messages\.support_handoff is required/u,
      },
      {
        edit(value) { value.messages.group_invitation.status = 'planned'; },
        error: /group_invitation\.status must be active/u,
      },
      {
        edit(value) { value.messages.group_invitation.audience = 'admin'; },
        error: /group_invitation\.audience must be user/u,
      },
      {
        edit(value) { value.messages.activation_escalation_admin.status = 'active'; },
        error: /activation_escalation_admin\.status must be planned/u,
      },
      {
        edit(value) { delete value.messages.activation_reminder.status; },
        error: /activation_reminder\.status must be planned/u,
      },
      {
        edit(value) { value.messages.activation_escalation_admin.audience = 'user'; },
        error: /activation_escalation_admin\.audience must be admin/u,
      },
      {
        edit(value) { delete value.messages.support_handoff.text; },
        error: /support_handoff\.text must be a string/u,
      },
      {
        edit(value) { value.messages.support_handoff.callback_text = 'unsupported shape'; },
        error: /support_handoff\.callback_text is not supported/u,
      },
      {
        edit(value) {
          value.messages.unregistered_future_copy = {
            status: 'planned', audience: 'user', text: '[ЗАГЛУШКА: unknown]',
          };
        },
        error: /unregistered_future_copy is not supported/u,
      },
    ];
    for (const item of cases) {
      assert.throws(
        () => parseScenarioMarkdown(editScenario(markdown, item.edit), { allowDraftScenario: true }),
        item.error,
      );
    }
  });

  test('rejects unsafe links, unknown fields, and unsupported templates', () => {
    const unsafeLink = editScenario(markdown, (value) => {
      value.messages.private_instruction.links[0].url = 'http://unsafe.test/rules';
    });
    assert.throws(
      () => parseScenarioMarkdown(unsafeLink, { allowDraftScenario: true }),
      /must use HTTPS/u,
    );

    const unknownField = editScenario(markdown, (value) => {
      value.send_to_chat_id = '-1001';
    });
    assert.throws(
      () => parseScenarioMarkdown(unknownField, { allowDraftScenario: true }),
      /send_to_chat_id is not supported/u,
    );

    const unknownTemplate = editScenario(markdown, (value) => {
      value.messages.group_invitation.text += ' {{user_first_name}}';
    });
    assert.throws(
      () => parseScenarioMarkdown(unknownTemplate, { allowDraftScenario: true }),
      /unsupported template/u,
    );

    const duplicatedMention = editScenario(markdown, (value) => {
      value.messages.group_invitation.text += ' {{user_mention}}';
    });
    assert.throws(
      () => parseScenarioMarkdown(duplicatedMention, { allowDraftScenario: true }),
      /exactly once/u,
    );
  });

  test('rejects malformed or duplicated machine-readable blocks', () => {
    assert.throws(
      () => parseScenarioMarkdown('# missing block', { allowDraftScenario: true }),
      /markers are missing/u,
    );
    const duplicated = `${markdown}\n${markdown}`;
    assert.throws(
      () => parseScenarioMarkdown(duplicated, { allowDraftScenario: true }),
      /must appear exactly once/u,
    );
  });

  test('rejects duplicate raw JSON keys at every catalog depth', () => {
    const duplicateMessageId = editRawScenarioJson(markdown, (raw) => raw.replace(
      '    "group_invitation": {',
      '    "group_invitation": {"status":"active","audience":"user","text":"duplicate","button_text":"duplicate"},\n    "group_invitation": {',
    ));
    assert.throws(
      () => parseScenarioMarkdown(duplicateMessageId, { allowDraftScenario: true }),
      /duplicate JSON key at root\.messages\.group_invitation/u,
    );

    const duplicateEscapedStatus = editRawScenarioJson(markdown, (raw) => raw.replace(
      '      "status": "active",',
      '      "status": "active",\n      "\\u0073tatus": "active",',
    ));
    assert.throws(
      () => parseScenarioMarkdown(duplicateEscapedStatus, { allowDraftScenario: true }),
      /duplicate JSON key at root\.messages\.group_invitation\.status/u,
    );

    const duplicateNestedUrl = editRawScenarioJson(markdown, (raw) => raw.replace(
      '          "url": "https://placeholder.invalid/community_rules_url"',
      '          "url": "https://placeholder.invalid/community_rules_url",\n          "url": "https://community.test/duplicate"',
    ));
    assert.throws(
      () => parseScenarioMarkdown(duplicateNestedUrl, { allowDraftScenario: true }),
      /duplicate JSON key at root\.messages\.private_instruction\.links\[0\]\.url/u,
    );
  });

  test('raw duplicate scanner accepts valid escaped string content', () => {
    const escaped = editRawScenarioJson(markdown, (raw) => raw.replace(
      '      "audience": "user",',
      '      "audience": "user",\n      "_comment_escaped": "quote: \\"ok\\"; slash: \\\\; unicode: \\u0410",',
    ));
    const scenario = parseScenarioMarkdown(escaped, { allowDraftScenario: true });
    assert.equal(scenario.messages.group_invitation.status, 'active');
  });

  test('raw duplicate scanner fails closed if nesting exhausts its call stack', () => {
    const nesting = 20_000;
    const deeplyNested = editRawScenarioJson(markdown, (raw) => raw.replace(
      '  "messages": {',
      `  "messages": {\n    "_comment_deep": ${'['.repeat(nesting)}0${']'.repeat(nesting)},`,
    ));
    assert.throws(
      () => parseScenarioMarkdown(deeplyNested, { allowDraftScenario: true }),
      /raw JSON duplicate-key scan failed closed/u,
    );
  });

  test('provider reads current file content on every load without a cache', () => {
    let version = 0;
    const provider = createScenarioProvider({
      scenarioPath: '/virtual/onboarding.md',
      allowDraftScenario: true,
      readFile() {
        version += 1;
        return editScenario(markdown, (value) => {
          value.messages.group_invitation.text = `{{user_mention}} версия ${version}!`;
        });
      },
    });
    assert.match(provider.load().messages.group_invitation.text, /версия 1!/u);
    assert.match(provider.load().messages.group_invitation.text, /версия 2!/u);
    assert.equal(version, 2);
  });
});
