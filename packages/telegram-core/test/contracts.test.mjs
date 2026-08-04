import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOT_ROLES,
  classifyTelegramUpdate,
  detectAssistantQuestion,
  incomingEventId,
} from '../src/index.mjs';

const message = (text, extra = {}) => ({
  message_id: 8,
  chat: { id: -1001 },
  from: { id: 44, first_name: 'User', is_bot: false },
  text,
  ...extra,
});

test('assistant command recognition keeps the legacy leading-command contract', () => {
  assert.deepEqual(detectAssistantQuestion(message('/ask@assistant_bot  explain'), 'assistant_bot'), {
    isQuestion: true, reason: 'command', text: 'explain',
  });
  assert.equal(detectAssistantQuestion(message('/ask@other_bot explain'), 'assistant_bot').isQuestion, false);
  assert.equal(detectAssistantQuestion(message('before /ask explain'), 'assistant_bot').isQuestion, false);
  assert.equal(detectAssistantQuestion(message('/ask copied', { forward_origin: {} }), 'assistant_bot').isQuestion, false);
});

test('roles remain structurally isolated and message identities stay chat-scoped', () => {
  const update = { update_id: 5, message: message('/ask question') };
  const assistant = classifyTelegramUpdate({
    role: BOT_ROLES.ASSISTANT, update, acceptedChatIds: [-1001], botUsername: 'assistant_bot',
  });
  const moderator = classifyTelegramUpdate({ role: BOT_ROLES.MODERATOR, update, acceptedChatIds: [-1001] });
  assert.equal(assistant.kind, 'question');
  assert.equal(moderator.kind, 'comment');
  assert.equal(classifyTelegramUpdate({
    role: BOT_ROLES.ASSISTANT, update: { update_id: 6, message: message('plain') }, acceptedChatIds: [-1001],
  }).kind, 'skip');
  assert.equal(incomingEventId(BOT_ROLES.MODERATOR, update), 'moderator:5');
  assert.throws(() => incomingEventId(BOT_ROLES.MODERATOR, { update_id: -1 }), /update_id/);
});
