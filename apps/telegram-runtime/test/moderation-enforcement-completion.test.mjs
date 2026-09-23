import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntimeStore, openRuntimeDatabase } from '../src/database.mjs';
import { createGuardAdapter } from '../src/guard-adapter.mjs';
import { createTelegramRuntime } from '../src/runtime.mjs';
import { safetyVerdict } from './safety-fixture.mjs';

// Exercise the real runtime, Guard and durable store. Only the provider and
// Telegram transport are offline fixtures; no policy or enforcement logic is
// reimplemented here.
function harness(t, {
  missingAuthor = false, unsupportedSenderChat = false, skipBanRights = false,
  skipDeleteRights = false, banUncertain = false, deleteUncertain = false,
} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-enforcement-completion-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  const store = createRuntimeStore(db);
  const actions = [];
  let skipNextGuardProof = false;
  let modelCalls = 0;
  const moderatorTelegram = {
    async getChatMember({ userId }) {
      if (userId !== '123') return { ok: true, data: { status: 'member' } };
      const restrict = !skipNextGuardProof;
      skipNextGuardProof = false;
      return { ok: true, data: {
        status: 'administrator', can_delete_messages: true, can_restrict_members: restrict,
      } };
    },
    async banMember(input) {
      actions.push(['ban', input]);
      skipNextGuardProof = skipDeleteRights;
      return banUncertain ? { ok: false, error: 'telegram_transport_unknown' } : { ok: true };
    },
    async deleteMessage(input) {
      actions.push(['delete', input]);
      return deleteUncertain ? { ok: false, error: 'telegram_transport_unknown' } : { ok: true };
    },
  };
  if (!unsupportedSenderChat) moderatorTelegram.banSenderChat = async (input) => {
    actions.push(['ban_sender_chat', input]);
    return { ok: true };
  };
  const guard = createGuardAdapter({ telegram: moderatorTelegram, guardBotId: '123', guardChatIds: ['-100'] });
  const createRuntime = () => createTelegramRuntime({
    config: {
      ingressEnabled: false, moderationMode: 'live', assistantModerationWaitMs: 0,
      moderator: { chatIds: ['-100'], botToken: '123:fixture', botUsername: '', exemptBotIds: [] },
      assistant: { chatIds: ['-100'], botToken: '456:fixture', botUsername: 'assistant_bot', exemptBotIds: [] },
    },
    store, guard, moderatorTelegram,
    provider: {
      async moderate({ text, currentWeakStrikes, warningStage }) {
        modelCalls++;
        return safetyVerdict({ message: text, safetyRoute: 'threat',
          context: { currentWeakStrikes, warningStage } });
      },
    },
    notifier: { async notify() { return { delivered: true }; } },
    testHooks: { afterEnforcementPlanned() { skipNextGuardProof = skipBanRights; } },
  });
  const event = { update_id: 101, message: {
    message_id: 202, chat: { id: -100 }, text: 'Offline sanction contract fixture.',
    ...(missingAuthor ? {} : { from: { id: 7, first_name: 'Fixture', is_bot: false } }),
    ...(unsupportedSenderChat ? { sender_chat: { id: -200 } } : {}),
  } };
  return { db, store, actions, event, createRuntime, runtime: createRuntime(), modelCalls: () => modelCalls };
}

function assertPersisted(h, result, { status, errorCode }) {
  const row = h.store.getModerationEnforcement(result.eventId);
  assert.equal(row.status, status);
  assert.equal(row.error_code, errorCode);
  assert.deepEqual(JSON.parse(row.receipt_json), result.enforcement);
}

async function assertNoResanction(h, first) {
  const actions = structuredClone(h.actions);
  assert.deepEqual(await h.runtime.handleUpdate('moderator', h.event), first);
  const restarted = h.createRuntime();
  assert.deepEqual(await restarted.handleUpdate('moderator', h.event), first);
  await restarted.recoverModeratorJudgements({ startup: true });
  assert.deepEqual(h.actions, actions, 'redelivery and restart recovery never repeat a terminal sanction');
  assert.equal(h.modelCalls(), 1);
}

for (const scenario of [
  { name: 'missing author', options: { missingAuthor: true }, reason: 'author_identity_missing' },
  { name: 'unsupported sender chat', options: { unsupportedSenderChat: true }, reason: 'ban_sender_chat_unsupported' },
  { name: 'ban rights definitively skipped', options: { skipBanRights: true }, reason: 'guard_rights_unproven' },
]) {
  test(`${scenario.name}: confirmed deletion cannot complete a skipped ban`, async (t) => {
    const h = harness(t, scenario.options);
    const result = await h.runtime.handleUpdate('moderator', h.event);
    assert.equal(result.verdict, 'ban');
    assert.equal(result.enforcement.status, 'guard_unproven');
    assert.equal(result.action, 'ban_unconfirmed');
    assert.deepEqual(result.enforcement.steps.ban, {
      status: 'skipped', ok: false, error: scenario.reason, uncertain: false,
    });
    assert.deepEqual(h.actions, [['delete', { chatId: '-100', messageId: '202' }]],
      'existing permitted deletion still executes once after a definitive ban skip');
    assert.equal(result.enforcement.purge.deleted, 1);
    assert.equal(result.enforcement.purge.failed, 0);
    assertPersisted(h, result, { status: 'skipped', errorCode: scenario.reason });
    await assertNoResanction(h, result);
  });
}

test('an uncertain ban stays uncertain and never starts a purge or automatic retry', async (t) => {
  const h = harness(t, { banUncertain: true });
  const result = await h.runtime.handleUpdate('moderator', h.event);
  assert.equal(result.action, 'ban_unconfirmed');
  assert.equal(result.enforcement.status, 'uncertain');
  assert.equal(result.enforcement.steps.ban.status, 'uncertain');
  assert.equal(result.enforcement.purge.attempted, false);
  assert.deepEqual(h.actions, [['ban', { chatId: '-100', userId: '7' }]]);
  assertPersisted(h, result, { status: 'uncertain', errorCode: 'telegram_transport_unknown' });
  await assertNoResanction(h, result);
});

test('confirmed ban and all required deletions complete once', async (t) => {
  const h = harness(t);
  const result = await h.runtime.handleUpdate('moderator', h.event);
  assert.equal(result.action, 'ban_purge');
  assert.equal(result.enforcement.status, 'completed');
  assert.equal(result.enforcement.steps.ban.status, 'completed');
  assert.equal(result.enforcement.purge.deleted, 1);
  assert.equal(result.enforcement.purge.failed, 0);
  assert.deepEqual(h.actions.map(([kind]) => kind), ['ban', 'delete']);
  assertPersisted(h, result, { status: 'completed', errorCode: null });
  await assertNoResanction(h, result);
});

test('confirmed ban with a definitively skipped required deletion is not completed', async (t) => {
  const h = harness(t, { skipDeleteRights: true });
  const result = await h.runtime.handleUpdate('moderator', h.event);
  assert.equal(result.action, 'purge_unconfirmed');
  assert.equal(result.enforcement.status, 'guard_unproven');
  assert.equal(result.enforcement.steps.ban.status, 'completed');
  assert.equal(result.enforcement.purge.failed, 1);
  assert.equal(result.enforcement.purge.items[0].uncertain, false);
  assert.deepEqual(h.actions.map(([kind]) => kind), ['ban']);
  assertPersisted(h, result, { status: 'skipped', errorCode: 'purge_unconfirmed' });
  await assertNoResanction(h, result);
});

for (const skipBanRights of [false, true]) {
  test(`an uncertain purge stays uncertain after a ${skipBanRights ? 'skipped' : 'confirmed'} ban`, async (t) => {
    const h = harness(t, { skipBanRights, deleteUncertain: true });
    const result = await h.runtime.handleUpdate('moderator', h.event);
    assert.equal(result.action, 'purge_unconfirmed');
    assert.equal(result.enforcement.status, 'uncertain');
    assert.equal(result.enforcement.steps.ban.status, skipBanRights ? 'skipped' : 'completed');
    assert.equal(result.enforcement.purge.items[0].uncertain, true);
    assert.equal(result.enforcement.purge.failed, 1);
    assertPersisted(h, result, { status: 'uncertain', errorCode: 'purge_uncertain' });
    await assertNoResanction(h, result);
  });
}
