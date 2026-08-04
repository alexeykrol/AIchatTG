import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ASSISTANT_SOURCE_PACKAGES,
  admitKnowledgeSnapshot,
  BOT_ROLES,
  assistantDispositionForSafety,
  classifyTelegramUpdate,
  detectAssistantQuestion,
  incomingEventId,
  isCourseOperationsSupportQuestion,
  knowledgeManifestDigest,
  loadKnowledgeSnapshot,
  normalizeAssistantRoleRoute,
  normalizeSafetyClassification,
  planTelegramSafetyAction,
  validateKnowledgeManifest,
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

test('closed safety policy owns actions and Assistant access dispositions', () => {
  const weak = normalizeSafetyClassification({ safety_route: 'abuse', abuse_level: 'weak', confidence: 0.9, reason: 'fixture' });
  assert.deepEqual(planTelegramSafetyAction(weak, 0), {
    safetyRoute: 'abuse', abuseLevel: 'weak', strikeBefore: 0, strikeAfter: 1,
    verdict: 'suspect', action: 'delete_warn_1', warning: 'warning_first',
  });
  const strong = planTelegramSafetyAction({ safetyRoute: 'abuse', abuseLevel: 'strong', confidence: 1 }, 2);
  assert.equal(strong.action, 'ban_purge');
  assert.deepEqual(assistantDispositionForSafety(strong), { status: 'blocked', verdict: 'ban' });
  assert.deepEqual(assistantDispositionForSafety(planTelegramSafetyAction({ safetyRoute: 'clean', confidence: 1 }, 2)), {
    status: 'allowed', verdict: 'clean',
  });
  assert.equal(normalizeSafetyClassification({ safetyRoute: 'clean', abuseLevel: 'weak', confidence: 1 }), null);
});

test('course operations and course content use disjoint closed routing packages', () => {
  assert.deepEqual(normalizeAssistantRoleRoute({ action: 'support', sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS }), {
    action: 'support', sourceId: 'course-operations-v1',
  });
  assert.equal(normalizeAssistantRoleRoute({ action: 'support', sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_CONTENT }), null);
  assert.deepEqual(normalizeAssistantRoleRoute({ action: 'redirect', sourceId: null }), { action: 'redirect', sourceId: null });
  assert.equal(isCourseOperationsSupportQuestion('В курсе как перейти к следующему уроку?'), true);
  assert.equal(isCourseOperationsSupportQuestion('В курсе какая цена?'), true);
  assert.equal(isCourseOperationsSupportQuestion('В курсе где чат участников?'), true);
  assert.equal(isCourseOperationsSupportQuestion('В курсе с чего начать?'), true);
  assert.equal(isCourseOperationsSupportQuestion('В курсе в каком порядке изучать модули по агентам?'), false);
});

test('knowledge snapshots reject path escapes and accept only matching local digests', () => {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-knowledge-'));
  try {
    const content = 'offline knowledge fixture';
    writeFileSync(join(folder, 'slice.md'), content);
    const manifest = {
      format: 'aichattg-knowledge-manifest-v1', sourceId: 'course-operations-v1', entries: [{
        id: 'operations', path: 'slice.md',
        sha256: createHash('sha256').update(content).digest('hex'),
        title: 'Fixture', canonicalUrl: 'https://example.test/fixture',
      }],
    };
    assert.deepEqual(validateKnowledgeManifest(manifest)?.entries.map(({ content: ignored, ...entry }) => entry), manifest.entries);
    assert.equal(loadKnowledgeSnapshot(manifest, folder)?.entries[0].content, content);
    const identity = {
      sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS,
      manifestDigest: knowledgeManifestDigest(manifest),
    };
    assert.equal(admitKnowledgeSnapshot({ manifest, root: folder, expectedIdentity: identity }).available, true);
    assert.equal(admitKnowledgeSnapshot({ manifest, root: folder, expectedIdentity: { ...identity, manifestDigest: '0'.repeat(64) } }).reason, 'knowledge_identity_mismatch');
    assert.equal(admitKnowledgeSnapshot({ manifest, root: folder, expectedIdentity: { sourceId: 'unreviewed-source', manifestDigest: identity.manifestDigest } }).reason, 'knowledge_identity_invalid');
    assert.equal(admitKnowledgeSnapshot({ manifest, root: folder }).reason, 'knowledge_identity_missing');
    assert.equal(validateKnowledgeManifest({ ...manifest, entries: [{ ...manifest.entries[0], path: '../News.db' }] }), null);
    assert.equal(validateKnowledgeManifest({ ...manifest, sourceId: 'unreviewed-source' }), null);
    assert.equal(loadKnowledgeSnapshot({ ...manifest, entries: [{ ...manifest.entries[0], sha256: '0'.repeat(64) }] }, folder), null);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
