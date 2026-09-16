import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJudgementEnvelope, judgementDigest, judgementPolicy } from '../src/judgement-envelope.mjs';

const config = {
  moderationMode: 'live',
  assistant: { chatIds: ['-100'], botUsername: 'assistant_bot', botToken: '900:fixture', exemptBotIds: ['999'] },
  moderator: { chatIds: ['-100'], botUsername: 'moderator_bot', botToken: '901:fixture', exemptBotIds: ['999'] },
};

function raw({ text = '', edited = true, chatId = -100, from = { id: 7, is_bot: false }, extra = {} } = {}) {
  return { update_id: 1, [edited ? 'edited_message' : 'message']: {
    message_id: 10, chat: { id: chatId, type: 'supergroup' }, from, text,
    ...(edited ? { edit_date: 500 } : {}), ...extra,
  } };
}

test('scoped empty edit is a tombstone without a question or eligible provider work', () => {
  const envelope = buildJudgementEnvelope(config, raw());
  assert.equal(envelope.judgeEligible, false);
  assert.equal(envelope.question, null);
  assert.equal(envelope.revision, 500);
  assert.equal(envelope.revisionIdentity, '-100:10:edit:500');
  assert.equal(envelope.comment.text, '');
  assert.equal(buildJudgementEnvelope(config, raw({ edited: false })), null);
});

test('ignored exempt-bot edit still establishes a tombstone for the native coordinate', () => {
  const from = { id: 999, is_bot: true };
  const edited = buildJudgementEnvelope(config, raw({ text: 'ignored bot text', from }));
  assert.equal(edited.judgeEligible, false);
  assert.equal(edited.comment.userId, '999');
  assert.equal(edited.comment.isBot, true);
  assert.equal(buildJudgementEnvelope(config, raw({ text: 'ignored bot text', from, edited: false })), null);
});

test('tombstones never widen chat scope and require a valid native edit timestamp', () => {
  assert.equal(buildJudgementEnvelope(config, raw({ chatId: -200 })), null);
  assert.equal(buildJudgementEnvelope(config, raw({ text: '/ask question', chatId: -200 })), null);
  for (const edit_date of [undefined, null, 0, -1, 1.5, '500', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(buildJudgementEnvelope(config, raw({ extra: { edit_date } })), null);
  }
});

test('caption edits remain eligible and preserve the raw evidence projection', () => {
  const envelope = buildJudgementEnvelope(config, raw({ extra: { caption: 'Raw caption' } }));
  assert.equal(envelope.judgeEligible, true);
  assert.equal(envelope.owner, 'moderator');
  assert.equal(envelope.comment.text, 'Raw caption');
});

test('tombstone eligibility participates in source hashing at the same native coordinate', () => {
  const empty = buildJudgementEnvelope(config, raw());
  const content = buildJudgementEnvelope(config, raw({ text: 'Raw message' }));
  assert.equal(empty.revisionIdentity, content.revisionIdentity);
  assert.notEqual(empty.sourceHash, content.sourceHash);
  assert.equal(empty.policyHash, content.policyHash);
});

test('source hash binds native sender, entities, reply and forwarding metadata', () => {
  const base = buildJudgementEnvelope(config, raw({ text: 'Raw message' }));
  for (const extra of [
    { sender_chat: { id: -200 } },
    { entities: [{ type: 'text_link', offset: 0, length: 3, url: 'https://example.invalid' }] },
    { reply_to_message: { message_id: 11, from: { id: 900 } } },
    { forward_origin: { type: 'user' } },
  ]) {
    const changed = buildJudgementEnvelope(config, raw({ text: 'Raw message', extra }));
    assert.equal(changed.revisionIdentity, base.revisionIdentity);
    assert.notEqual(changed.sourceHash, base.sourceHash);
  }
});

test('policy replay digest changes when either role removes the original chat scope', () => {
  const original = judgementDigest(judgementPolicy(config));
  for (const role of ['assistant', 'moderator']) {
    const changed = { ...config, [role]: { ...config[role], chatIds: [] } };
    assert.notEqual(judgementDigest(judgementPolicy(changed)), original, `${role} scope removal must fence old work`);
  }
  const bothRemoved = {
    ...config, assistant: { ...config.assistant, chatIds: [] }, moderator: { ...config.moderator, chatIds: [] },
  };
  assert.notEqual(judgementDigest(judgementPolicy(bothRemoved)), original);
});

test('policy scope hashes are stable across ordering and native ID representations', () => {
  const left = {
    ...config, assistant: { ...config.assistant, chatIds: ['-100', '-200'] },
    moderator: { ...config.moderator, chatIds: [-300, -100] },
  };
  const right = {
    ...config, assistant: { ...config.assistant, chatIds: [-200, -100] },
    moderator: { ...config.moderator, chatIds: ['-100', '-300'] },
  };
  assert.equal(judgementDigest(judgementPolicy(left)), judgementDigest(judgementPolicy(right)));
  assert.equal(buildJudgementEnvelope(left, raw({ text: 'Raw message' })).policyHash,
    judgementDigest(judgementPolicy(left)));
});
