import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuardAdapter } from '../src/guard-adapter.mjs';

function transport({ guardMember, authorMember, calls }) {
  return {
    async getChatMember({ userId }) {
      calls.push(['get_member', userId]);
      const answer = userId === 'guard' ? guardMember : authorMember;
      // Telegram names the member it answers about; fixtures opt out via `user: null`.
      if (answer?.ok === true && answer.data && typeof answer.data === 'object' && !('user' in answer.data)) {
        return { ...answer, data: { user: { id: userId }, ...answer.data } };
      }
      return answer;
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

test('Guard never issues a success receipt for a positive flag without the method result', async () => {
  for (const reply of [{ ok: true }, { ok: true, data: false }, { ok: true, data: { ok: true } }]) {
    const calls = [];
    const telegram = transport({
      guardMember: { ok: true, data: { status: 'administrator', can_delete_messages: true, can_restrict_members: true } },
      authorMember: { ok: true, data: { status: 'member' } }, calls,
    });
    telegram.deleteMessage = async (input) => { calls.push(['delete', input]); return reply; };
    telegram.banMember = async (input) => { calls.push(['ban_member', input]); return reply; };
    telegram.sendMessage = async (input) => { calls.push(['warning', input]); return reply; };
    const guard = createGuardAdapter({ telegram, guardBotId: 'guard', guardChatIds: ['chat-a'] });
    for (const result of [
      await guard.deleteMessage({ chatId: 'chat-a', messageId: 'm' }),
      await guard.banAuthor({ chatId: 'chat-a', userId: 'author' }),
      await guard.sendWarning({ chatId: 'chat-a', messageId: 'm', text: 'w' }),
    ]) {
      assert.equal(result.ok, false, JSON.stringify(reply));
      assert.equal(result.uncertain, true, 'unconfirmed receipt goes to reconciliation');
    }
    assert.equal(calls.filter(([kind]) => kind === 'delete').length, 1, 'no repeated mutation');
    assert.equal(calls.filter(([kind]) => kind === 'ban_member').length, 1, 'no repeated mutation');
  }
});

test('Guard does not accept membership about another user or with an unknown status', async () => {
  for (const authorMember of [
    { ok: true, data: { user: { id: 'someone-else' }, status: 'administrator' } },
    { ok: true, data: { user: null, status: 'administrator' } },
    { ok: true, data: { status: 'superadmin' } },
  ]) {
    const calls = [];
    const telegram = transport({
      guardMember: { ok: true, data: { status: 'administrator', can_delete_messages: true, can_restrict_members: true } },
      authorMember, calls,
    });
    const guard = createGuardAdapter({ telegram, guardBotId: 'guard', guardChatIds: ['chat-a'] });
    assert.deepEqual(await guard.senderDisposition({ chatId: 'chat-a', userId: 'author' }), {
      proven: false, exempt: false, reason: 'telegram_membership_unconfirmed',
    }, JSON.stringify(authorMember));
  }
  const calls = [];
  const telegram = transport({
    guardMember: { ok: true, data: { user: { id: 'impostor' }, status: 'creator' } },
    authorMember: { ok: true, data: { status: 'member' } }, calls,
  });
  const guard = createGuardAdapter({ telegram, guardBotId: 'guard', guardChatIds: ['chat-a'] });
  assert.equal((await guard.deleteMessage({ chatId: 'chat-a', messageId: 'm' })).skipped, 'telegram_membership_unconfirmed');
  assert.equal(calls.some(([kind]) => kind === 'delete'), false);
});
