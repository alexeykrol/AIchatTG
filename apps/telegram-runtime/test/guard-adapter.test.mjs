import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuardAdapter } from '../src/guard-adapter.mjs';

function transport({ guardMember, authorMember, calls }) {
  return {
    async getChatMember({ userId }) {
      calls.push(['get_member', userId]);
      if (userId === 'guard') return guardMember;
      return authorMember;
    },
    async deleteMessage(input) { calls.push(['delete', input]); return { ok: true, data: true }; },
    async unpinMessage(input) { calls.push(['unpin', input]); return { ok: true, data: true }; },
    async sendMessage(input) { calls.push(['warning', input]); return { ok: true, data: { message_id: 1 } }; },
    async banMember(input) { calls.push(['ban_member', input]); return { ok: true, data: true }; },
    async banSenderChat(input) { calls.push(['ban_sender_chat', input]); return { ok: true, data: true }; },
  };
}

test('Guard proves configured administrator delete and restrict rights before destructive calls', async () => {
  const calls = [];
  const telegram = transport({
    guardMember: { ok: true, data: { status: 'administrator', can_delete_messages: true, can_restrict_members: false } },
    authorMember: { ok: true, data: { status: 'member' } }, calls,
  });
  const guard = createGuardAdapter({ telegram, guardBotId: 'guard', guardChatIds: ['chat-a'] });

  assert.deepEqual(await guard.verifyEnforcement({ chatId: 'chat-b' }), {
    proven: false, reason: 'guard_chat_unconfigured',
  });
  assert.deepEqual(await guard.deleteMessage({ chatId: 'chat-a', messageId: 'message-a' }), {
    ok: false, skipped: 'guard_rights_unproven', uncertain: false,
  });
  assert.deepEqual(calls, [['get_member', 'guard']]);
});

test('Guard accepts creator rights and keeps administrator, anonymous and exempt-bot senders out of enforcement', async () => {
  const calls = [];
  const telegram = transport({
    guardMember: { ok: true, data: { status: 'creator' } },
    authorMember: { ok: true, data: { status: 'administrator' } }, calls,
  });
  const guard = createGuardAdapter({
    telegram, guardBotId: 'guard', guardChatIds: ['chat-a'], exemptBotIds: ['friendly-bot'],
  });
  assert.deepEqual(await guard.verifyEnforcement({ chatId: 'chat-a' }), {
    proven: true, chatId: 'chat-a', status: 'creator',
  });
  assert.deepEqual(await guard.senderDisposition({ chatId: 'chat-a', userId: 'admin-a' }), {
    proven: true, exempt: true, reason: 'chat_admin_or_creator',
  });
  assert.deepEqual(await guard.senderDisposition({
    chatId: 'chat-a', userId: 'anonymous', senderChatId: 'chat-a',
  }), { proven: true, exempt: true, reason: 'anonymous_group_sender' });
  assert.deepEqual(await guard.senderDisposition({
    chatId: 'chat-a', userId: 'friendly-bot', isBot: true,
  }), { proven: true, exempt: true, reason: 'exempt_bot' });
});

test('Guard does not sanction when author membership is unproven and routes foreign channel senders to sender-chat ban', async () => {
  const calls = [];
  const telegram = transport({
    guardMember: { ok: true, data: { status: 'administrator', can_delete_messages: true, can_restrict_members: true } },
    authorMember: { ok: false, error: 'not_found' }, calls,
  });
  const guard = createGuardAdapter({ telegram, guardBotId: 'guard', guardChatIds: ['chat-a'] });
  assert.deepEqual(await guard.senderDisposition({ chatId: 'chat-a', userId: 'unknown' }), {
    proven: false, exempt: false, reason: 'telegram_membership_unavailable',
  });
  const result = await guard.banAuthor({ chatId: 'chat-a', senderChatId: 'foreign-channel' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.at(-1), ['ban_sender_chat', { chatId: 'chat-a', senderChatId: 'foreign-channel' }]);
});

test('Guard unpins only configured chats after proving pin permission', async () => {
  const calls = [];
  const telegram = transport({
    guardMember: { ok: true, data: { status: 'administrator', can_pin_messages: true } },
    authorMember: { ok: true, data: { status: 'member' } }, calls,
  });
  const guard = createGuardAdapter({ telegram, guardBotId: 'guard', guardChatIds: ['chat-a'] });

  assert.deepEqual(await guard.verifyPinGovernance({ chatId: 'chat-a' }), {
    proven: true, chatId: 'chat-a', status: 'administrator',
  });
  assert.deepEqual(await guard.unpinMessage({ chatId: 'chat-a', messageId: 'message-a' }), { ok: true });
  assert.deepEqual(calls, [
    ['get_member', 'guard'],
    ['get_member', 'guard'],
    ['unpin', { chatId: 'chat-a', messageId: 'message-a' }],
  ]);
});

test('Guard fails closed when pin rights are absent and does not call Telegram unpin', async () => {
  const calls = [];
  const telegram = transport({
    guardMember: { ok: true, data: { status: 'administrator', can_delete_messages: true, can_restrict_members: true } },
    authorMember: { ok: true, data: { status: 'member' } }, calls,
  });
  const guard = createGuardAdapter({ telegram, guardBotId: 'guard', guardChatIds: ['chat-a'] });

  assert.deepEqual(await guard.unpinMessage({ chatId: 'chat-a', messageId: 'message-a' }), {
    ok: false, skipped: 'guard_pin_rights_unproven', uncertain: false,
  });
  assert.deepEqual(calls, [['get_member', 'guard']]);
});
