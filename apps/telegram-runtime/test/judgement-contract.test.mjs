import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openRuntimeDatabase, createRuntimeStore } from '../src/database.mjs';
import { buildJudgementEnvelope } from '../src/judgement-envelope.mjs';
import { validateJudgementSemantic } from '../src/safety-v3.mjs';

const config = {
  moderationMode: 'live', moderationBanLinks: false,
  assistant: { chatIds: ['-100'], botUsername: 'assistant_bot', botToken: '900:fixture' },
  moderator: { chatIds: ['-100'], botUsername: 'moderator_bot', botToken: '901:fixture', exemptBotIds: [] },
};

function update({ updateId = 1, messageId = 10, text = 'Ты идиот', userId = 7, editDate = null } = {}) {
  return { update_id: updateId, [editDate == null ? 'message' : 'edited_message']: {
    message_id: messageId, chat: { id: -100, type: 'supergroup' },
    from: { id: userId, is_bot: false }, text,
    ...(editDate == null ? {} : { edit_date: editDate }),
  } };
}

function tracedClean() {
  return { safetyRoute: 'clean', abuseLevel: null, confidence: 0.99, modelId: 'fixture', safetyTrace: {
    router: {
      threat: { match: false, types: [], confidence: 0.99, evidence: [] },
      abuse: { match: false, types: [], confidence: 0.99, evidence: [] },
      target: 'none', context_used: false,
    },
    abuseClassifier: null,
  } };
}
const weak = () => ({ safetyRoute: 'abuse', abuseLevel: 'weak', confidence: 0.99, modelId: 'fixture', quote: 'идиот' });

function tracedWeak(evidence = 'идиот') {
  return { ...weak(), safetyTrace: {
    router: {
      threat: { match: false, types: [], confidence: 0.99, evidence: [] },
      abuse: { match: true, types: ['targeted_insult'], confidence: 0.99, evidence: [evidence] },
      target: 'participant', context_used: false,
    },
    abuseClassifier: { severity: 'weak', confidence: 0.99, basis: 'isolated_disrespect' },
  } };
}

function harness(t) {
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-judgement-contract-'));
  const db = openRuntimeDatabase(join(folder, 'runtime.db'));
  const store = createRuntimeStore(db, { now: () => 100 });
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  let delivery = 0;
  function observe(raw = update(), overrideConfig = config, role = 'moderator') {
    const envelope = buildJudgementEnvelope(overrideConfig, raw);
    assert.ok(envelope);
    const eventId = `${role}:${++delivery}`;
    const receiptId = eventId;
    assert.equal(store.claimEvent({ eventId, role, updateId: delivery }).claimed, true);
    assert.equal(store.claimInboundDelivery({
      receiptId, role, updateId: delivery,
      revisionIdentity: envelope.revisionIdentity, payloadFingerprint: envelope.sourceHash,
    }).claimed, true);
    const observed = store.observeJudgementEnvelope({ envelope, eventId, receiptId });
    return { ...observed, eventId, receiptId, envelope };
  }
  function calling(observed = observe()) {
    const { claim, claimed } = store.claimModeratorJudgement({ eventId: observed.row.event_id });
    assert.equal(claimed, true);
    assert.equal(store.markModeratorProviderCalling({ claim }).marked, true);
    const opaque = store.issueJudgementSubmissionClaim(claim);
    assert.ok(opaque);
    return { ...observed, claim, opaque };
  }
  return { db, store, observe, calling };
}

test('judgement coordinate uses native edit timestamp, never bot-specific update ID', () => {
  const first = buildJudgementEnvelope(config, update({ editDate: 500, updateId: 1 }));
  const second = buildJudgementEnvelope(config, update({ editDate: 500, updateId: 999 }));
  assert.deepEqual(first, second);
  assert.equal(first.revisionIdentity, '-100:10:edit:500');
  assert.equal(buildJudgementEnvelope(config, update()).revisionIdentity, '-100:10:original');
  assert.notEqual(buildJudgementEnvelope(config, update({ editDate: 501 })).revisionIdentity, first.revisionIdentity);
  for (const editDate of [0, -1, 1.5, '500', Number.NaN]) {
    assert.equal(buildJudgementEnvelope(config, update({ editDate })), null);
  }
});

test('raw envelope preserves addressed source and binds actor while projections choose one owner', () => {
  const addressed = buildJudgementEnvelope(config, update({ text: '/ask Ты идиот' }));
  assert.equal(addressed.owner, 'assistant');
  assert.equal(addressed.comment.text, '/ask Ты идиот');
  assert.equal(addressed.question.text, 'Ты идиот');
  const otherActor = buildJudgementEnvelope(config, update({ text: '/ask Ты идиот', userId: 8 }));
  assert.equal(otherActor.revisionIdentity, addressed.revisionIdentity);
  assert.notEqual(otherActor.sourceHash, addressed.sourceHash);
  assert.equal(buildJudgementEnvelope(config, update()).owner, 'moderator');
});

test('both authenticated streams attach to one original owner and one judge job', (t) => {
  const h = harness(t);
  const raw = update({ text: '/ask Ты идиот' });
  const first = h.observe(raw, config, 'moderator');
  const second = h.observe(raw, config, 'assistant');
  assert.equal(first.row.owner, 'assistant');
  assert.equal(second.row.event_id, first.eventId);
  assert.equal(second.current, true);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_moderator_judgement_jobs').get().n, 1);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_judgement_stream_receipts').get().n, 2);
});

test('submission rejects fabricated, cloned and cross-store opaque claims', (t) => {
  const h = harness(t);
  const active = h.calling();
  for (const fake of [{}, { ...active.opaque }, active.claim, null, 'nonce']) {
    assert.deepEqual(h.store.submitJudgementVerdict(fake, tracedClean()), {
      ready: false, reason: 'untrusted_judgement_claim',
    });
  }
  const recoveredStore = createRuntimeStore(h.db, { now: () => 100 });
  assert.deepEqual(recoveredStore.submitJudgementVerdict(active.opaque, tracedClean()), {
    ready: false, reason: 'untrusted_judgement_claim',
  });
  assert.equal(h.store.getModeratorJudgement(active.eventId).state, 'calling');
});

test('opaque submission claims require exact live provider lease and generation', (t) => {
  const h = harness(t);
  const observed = h.observe();
  const provider = h.store.claimModeratorJudgement({ eventId: observed.eventId });
  assert.equal(h.store.issueJudgementSubmissionClaim(provider.claim), null, 'preflight is not calling');
  assert.equal(h.store.markModeratorProviderCalling({ claim: provider.claim }).marked, true);
  assert.equal(h.store.issueJudgementSubmissionClaim({ ...provider.claim, leaseId: 'forged' }), null);
  assert.equal(h.store.issueJudgementSubmissionClaim({ ...provider.claim, claimGeneration: provider.claim.claimGeneration + 1 }), null);
  assert.ok(h.store.issueJudgementSubmissionClaim(provider.claim));
  h.observe(update({ editDate: 500 }));
  assert.equal(h.store.issueJudgementSubmissionClaim(provider.claim), null, 'superseded revisions cannot acquire submission authority');
});

test('same semantic submission returns original receipt and reserves one native weak strike', (t) => {
  const h = harness(t);
  const active = h.calling();
  const first = h.store.submitJudgementVerdict(active.opaque, tracedWeak());
  assert.equal(first.ready, true);
  const second = h.store.submitJudgementVerdict(active.opaque, tracedWeak());
  assert.deepEqual(second, { ...JSON.parse(JSON.stringify(first)), duplicate: true });
  assert.equal(h.store.getWeakStrikeState({ chatId: '-100', userId: '7' }).weakStrikes, 1);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_moderation_enforcement_receipts').get().n, 1);
  assert.equal(first.enforcement.policy.action, 'delete_warn_1');
});

test('different semantic submission conflicts and fences an already accepted action callback', (t) => {
  const h = harness(t);
  const active = h.calling();
  assert.equal(h.store.submitJudgementVerdict(active.opaque, tracedClean()).ready, true);
  const beforeAction = () => h.store.isCurrentJudgement(active.eventId);
  assert.equal(beforeAction(), true);
  assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, tracedWeak()), {
    ready: false, reason: 'judgement_resubmission_conflict',
  });
  assert.equal(beforeAction(), false);
  assert.equal(h.store.getModeratorJudgement(active.eventId).state, 'manual_review');
});

test('a judged edit of the same native message cannot reserve a second weak strike', (t) => {
  const h = harness(t);
  const original = h.calling();
  assert.equal(h.store.submitJudgementVerdict(original.opaque, tracedWeak()).ready, true);
  const edit = h.calling(h.observe(update({ editDate: 500 })));
  const accepted = h.store.submitJudgementVerdict(edit.opaque, tracedWeak());
  assert.equal(accepted.ready, true);
  assert.equal(accepted.enforcement.duplicateNative, true);
  assert.equal(h.store.getWeakStrikeState({ chatId: '-100', userId: '7' }).weakStrikes, 1);
});

for (const [name, raw, changedConfig] of [
  ['source text', update({ text: 'Different message' }), config],
  ['actor', update({ userId: 8 }), config],
  ['owner', update({ text: '/ask Ты идиот' }), config],
  ['policy hash', update(), { ...config, moderationBanLinks: true }],
]) {
  test(`same coordinate with divergent ${name} conflicts without scheduling another judgement`, (t) => {
    const h = harness(t);
    const active = h.calling();
    const conflicting = h.observe(raw, changedConfig, 'assistant');
    assert.equal(conflicting.current, false);
    assert.equal(conflicting.row.state, 'conflict');
    assert.equal(h.store.isCurrentJudgement(active.eventId), false);
    assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, tracedClean()), {
      ready: false, reason: 'stale_judgement_claim',
    });
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_moderator_judgement_jobs').get().n, 1);
  });
}

test('newer edit fences accepted original callbacks; older delivery cannot replace current head', (t) => {
  const h = harness(t);
  const active = h.calling();
  assert.equal(h.store.submitJudgementVerdict(active.opaque, tracedClean()).ready, true);
  const beforeAction = () => h.store.isCurrentJudgement(active.eventId);
  assert.equal(beforeAction(), true);
  const edit = h.observe(update({ editDate: 502 }));
  assert.equal(edit.current, true);
  assert.equal(beforeAction(), false);
  const older = h.observe(update({ editDate: 501 }));
  assert.equal(older.current, false);
  assert.equal(older.row.state, 'stale');
  assert.equal(h.store.isCurrentJudgement(edit.eventId), true);
  assert.equal(h.store.getModeratorJudgement(older.eventId), null);
  assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, tracedClean()), {
    ready: false, reason: 'stale_judgement_claim',
  });
});

test('submission revalidates raw verbatim evidence and rejects invented spans', (t) => {
  assert.equal(validateJudgementSemantic(tracedWeak(), 'Ты идиот'), true);
  assert.equal(validateJudgementSemantic(tracedWeak('invented'), 'Ты идиот'), false);
  assert.equal(validateJudgementSemantic({ ...tracedWeak(), quote: 'invented' }, 'Ты идиот'), false);
  const h = harness(t);
  const active = h.calling();
  assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, tracedWeak('invented')), {
    ready: false, reason: 'invalid_judgement_submission',
  });
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_moderation_enforcement_receipts').get().n, 0);
});

for (const field of ['action', 'actions', 'target', 'targets', 'userId', 'actor', 'chatId', 'messageId', 'weakStrikes', 'policy', 'warning']) {
  test(`caller-controlled ${field} cannot enter semantic submission`, (t) => {
    const h = harness(t);
    const active = h.calling();
    const semantic = { ...tracedClean(), [field]: 'forged' };
    assert.equal(validateJudgementSemantic(semantic, 'Ты идиот'), false);
    assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, semantic), {
      ready: false, reason: 'invalid_judgement_submission',
    });
    assert.equal(h.store.getJudgementEnvelope(active.eventId).state, 'active');
    assert.equal(h.store.getModeratorJudgement(active.eventId).state, 'manual_review');
    assert.equal(h.store.getModeratorJudgement(active.eventId).error_code, 'invalid_judgement_submission');
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_moderation_enforcement_receipts').get().n, 0);
  });
}

test('strict semantic submission requires v3 evidence and preserves threat priority', () => {
  const { safetyTrace: _trace, ...noTrace } = tracedClean();
  assert.equal(validateJudgementSemantic(noTrace, 'Ты идиот'), false);
  assert.equal(validateJudgementSemantic(weak(), 'Ты идиот'), false);
  const semantic = tracedWeak();
  semantic.safetyTrace.router.threat = {
    match: true, types: ['interpersonal_threat'], confidence: 0.99, evidence: ['идиот'],
  };
  assert.equal(validateJudgementSemantic(semantic, 'Ты идиот'), false, 'trace priority must not permit abuse over threat');
});

test('strict semantic confidence equals the value derived from the validated trace', () => {
  for (const semantic of [tracedClean(), tracedWeak()]) {
    assert.equal(validateJudgementSemantic(semantic, 'Ты идиот'), true);
    assert.equal(validateJudgementSemantic({ ...semantic, confidence: 0.98 }, 'Ты идиот'), false);
    assert.equal(validateJudgementSemantic({ ...semantic, confidence: 1 }, 'Ты идиот'), false);
  }
  const semantic = tracedWeak();
  semantic.safetyTrace.abuseClassifier.confidence = 0.8;
  assert.equal(validateJudgementSemantic(semantic, 'Ты идиот'), false);
  semantic.confidence = 0.8;
  assert.equal(validateJudgementSemantic(semantic, 'Ты идиот'), true);
});

for (const acceptedBeforeEdit of [false, true]) {
  test(`ignored edit tombstone fences old judgement without a new job (already accepted=${acceptedBeforeEdit})`, (t) => {
    const h = harness(t);
    const active = h.calling();
    if (acceptedBeforeEdit) assert.equal(h.store.submitJudgementVerdict(active.opaque, tracedClean()).ready, true);
    const beforeAction = () => h.store.isCurrentJudgement(active.eventId);
    assert.equal(beforeAction(), true);
    const tombstone = h.observe(update({ editDate: 502, text: '' }));
    assert.equal(tombstone.envelope.judgeEligible, false);
    assert.equal(tombstone.current, true);
    assert.equal(beforeAction(), false);
    assert.equal(h.store.getModeratorJudgement(tombstone.eventId), null);
    assert.equal(h.store.claimModeratorJudgement({ eventId: tombstone.eventId }).claimed, false);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_moderator_judgement_jobs').get().n, 1);
    assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, tracedClean()), {
      ready: false, reason: 'stale_judgement_claim',
    });
    const older = h.observe(update({ editDate: 501 }));
    assert.equal(older.current, false);
    assert.equal(h.store.getModeratorJudgement(older.eventId), null);
    assert.equal(h.store.isCurrentJudgement(tombstone.eventId), true);
  });
}

test('accepted receipt does not retain raw source, provider quote or rationale', (t) => {
  const h = harness(t);
  const rawText = 'Private source sentinel Ты идиот';
  const active = h.calling(h.observe(update({ text: rawText })));
  const semantic = { ...tracedWeak(), reason: 'Private provider rationale sentinel' };
  const receipt = h.store.submitJudgementVerdict(active.opaque, semantic);
  assert.equal(receipt.ready, true);
  const persisted = h.store.getJudgementEnvelope(active.eventId).accepted_json;
  assert.equal(persisted.includes(rawText), false);
  assert.equal(persisted.includes(semantic.reason), false);
  assert.equal(persisted.includes(semantic.quote), false);
  function checkKeys(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(['snapshot_json', 'text', 'quote', 'reason', 'safetyTrace'].includes(key), false, key);
      checkKeys(child);
    }
  }
  checkKeys(JSON.parse(persisted));
  assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, semantic), {
    ...JSON.parse(persisted), duplicate: true,
  });
});

test('canonical semantic fingerprint ignores key ordering at every object depth', (t) => {
  const h = harness(t);
  const active = h.calling();
  const semantic = tracedWeak();
  const accepted = h.store.submitJudgementVerdict(active.opaque, semantic);
  assert.equal(accepted.ready, true);
  const reverseKeys = (value) => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;
  const reordered = reverseKeys(semantic);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(semantic));
  assert.deepEqual(reordered, semantic);
  assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, reordered), {
    ...JSON.parse(JSON.stringify(accepted)), duplicate: true,
  });
  assert.equal(h.store.getJudgementEnvelope(active.eventId).state, 'active');
  assert.equal(h.store.getWeakStrikeState({ chatId: '-100', userId: '7' }).weakStrikes, 1);
});

test('revoked generation cannot poison a newer accepted decision with invalid or different semantics', (t) => {
  const h = harness(t);
  const first = h.calling();
  // This models an explicitly proved not-started provider boundary; no real
  // provider is called. The sanctioned safe retry revokes generation one.
  assert.equal(h.store.deferModeratorJudgement({
    claim: first.claim, nextAttemptAt: 100, errorCode: 'provider_disabled',
  }).deferred, true);
  const second = h.calling(first);
  assert.equal(second.claim.claimGeneration, first.claim.claimGeneration + 1);
  const accepted = h.store.submitJudgementVerdict(second.opaque, tracedClean());
  assert.equal(accepted.ready, true);
  const jobBefore = h.store.getModeratorJudgement(first.eventId);
  const envelopeBefore = h.store.getJudgementEnvelope(first.eventId);
  const dispositionBefore = h.db.prepare('SELECT * FROM runtime_assistant_moderation_dispositions WHERE chat_id = ? AND message_id = ?').get('-100', '10');
  for (const oldVerdict of [{ ...tracedClean(), action: 'forged' }, tracedWeak(), tracedClean()]) {
    assert.deepEqual(h.store.submitJudgementVerdict(first.opaque, oldVerdict), {
      ready: false, reason: 'provider_claim_fenced',
    });
    assert.deepEqual(h.store.getModeratorJudgement(first.eventId), jobBefore);
    assert.deepEqual(h.store.getJudgementEnvelope(first.eventId), envelopeBefore);
    assert.deepEqual(h.db.prepare('SELECT * FROM runtime_assistant_moderation_dispositions WHERE chat_id = ? AND message_id = ?').get('-100', '10'), dispositionBefore);
    assert.equal(h.store.isCurrentJudgement(first.eventId), true);
  }
  assert.equal(h.store.getWeakStrikeState({ chatId: '-100', userId: '7' }).weakStrikes, 0);
  assert.deepEqual(h.store.submitJudgementVerdict(second.opaque, tracedClean()), {
    ...JSON.parse(JSON.stringify(accepted)), duplicate: true,
  });
});

test('revoked same-generation lease is fenced before invalid verdict can mutate job state', (t) => {
  const h = harness(t);
  const active = h.calling();
  assert.equal(h.store.deferModeratorJudgement({
    claim: active.claim, nextAttemptAt: 100, errorCode: 'provider_disabled',
  }).deferred, true);
  const before = h.store.getModeratorJudgement(active.eventId);
  assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, { ...tracedClean(), action: 'forged' }), {
    ready: false, reason: 'provider_claim_fenced',
  });
  assert.deepEqual(h.store.getModeratorJudgement(active.eventId), before);
  assert.equal(h.store.getJudgementEnvelope(active.eventId).state, 'active');
});

test('usage persistence allowlists token accounting and never retains arbitrary provider metadata', (t) => {
  const h = harness(t);
  const active = h.calling();
  const semantic = tracedClean();
  const sentinel = 'PRIVATE_USAGE_TEXT_SENTINEL';
  semantic.safetyTrace.usage = {
    modelId: 'fixture', inputTokens: 11, outputTokens: 3, totalTokens: 14,
    privateText: sentinel, nested: { privateText: sentinel },
  };
  const accepted = h.store.submitJudgementVerdict(active.opaque, semantic);
  assert.equal(accepted.ready, true);
  const decisionJson = h.store.getModeratorJudgement(active.eventId).decision_json;
  const acceptedJson = h.store.getJudgementEnvelope(active.eventId).accepted_json;
  assert.equal(decisionJson.includes(sentinel), false);
  assert.equal(acceptedJson.includes(sentinel), false);
  assert.equal(decisionJson.includes('privateText'), false);
  assert.equal(acceptedJson.includes('privateText'), false);
  assert.deepEqual(JSON.parse(decisionJson).usage, {
    modelId: 'fixture', inputTokens: 11, outputTokens: 3, totalTokens: 14,
  });
});

test('invalid first verdict preserves current source only for error fallback, never semantic allow or enforcement', (t) => {
  const h = harness(t);
  const active = h.calling();
  h.store.upsertAssistantDisposition({ chatId: '-100', messageId: '10', status: 'pending',
    moderationMessageId: active.envelope.revisionIdentity, moderationEventId: active.eventId });
  assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, { ...tracedClean(), confidence: 0.5 }), {
    ready: false, reason: 'invalid_judgement_submission',
  });
  const envelope = h.store.getJudgementEnvelope(active.eventId);
  assert.equal(envelope.state, 'active');
  assert.equal(envelope.verdict_fingerprint, null);
  assert.equal(envelope.accepted_json, null);
  assert.equal(h.store.isCurrentJudgement(active.eventId), true);
  const job = h.store.getModeratorJudgement(active.eventId);
  assert.equal(job.state, 'manual_review');
  assert.equal(job.error_code, 'invalid_judgement_submission');
  assert.equal(job.lease_id, null);
  const disposition = h.db.prepare('SELECT status, reason FROM runtime_assistant_moderation_dispositions WHERE chat_id = ? AND message_id = ?').get('-100', '10');
  assert.deepEqual(disposition, { status: 'error', reason: 'invalid_judgement_submission' });
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_moderation_enforcement_receipts').get().n, 0);
  assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, tracedClean()), {
    ready: false, reason: 'provider_claim_fenced',
  });
});

test('semantic model identifier is a bounded scalar, not a private-data carrier', () => {
  for (const modelId of [{ privateText: 'secret' }, ['fixture'], 9, '', 'x'.repeat(121), 'private text', 'x\ny']) {
    assert.equal(validateJudgementSemantic({ ...tracedClean(), modelId }, 'Ты идиот'), false);
  }
  for (const modelId of [null, 'gpt-5.6-terra', 'vendor/model:revision', 'x'.repeat(120)]) {
    assert.equal(validateJudgementSemantic({ ...tracedClean(), modelId }, 'Ты идиот'), true);
  }
});

test('invalid replay after acceptance fences the coordinate and revokes prior allow', (t) => {
  const h = harness(t);
  const active = h.calling();
  assert.equal(h.store.submitJudgementVerdict(active.opaque, tracedClean()).ready, true);
  assert.equal(h.store.isCurrentJudgement(active.eventId), true);
  assert.deepEqual(h.store.submitJudgementVerdict(active.opaque, { ...tracedClean(), action: 'forged' }), {
    ready: false, reason: 'invalid_judgement_submission',
  });
  assert.equal(h.store.getJudgementEnvelope(active.eventId).state, 'conflict');
  assert.equal(h.store.isCurrentJudgement(active.eventId), false);
  const disposition = h.db.prepare('SELECT status, reason FROM runtime_assistant_moderation_dispositions WHERE chat_id = ? AND message_id = ?').get('-100', '10');
  assert.deepEqual(disposition, { status: 'error', reason: 'judgement_conflict' });
});

test('exemption resolution is atomically fenced by revision and provider claim generation', (t) => {
  const h = harness(t);
  const observed = h.observe();
  const first = h.store.claimModeratorJudgement({ eventId: observed.eventId }).claim;
  assert.equal(h.store.deferModeratorJudgement({ claim: first, nextAttemptAt: 100 }).deferred, true);
  const second = h.store.claimModeratorJudgement({ eventId: observed.eventId }).claim;
  assert.equal(h.store.resolveJudgementExemption({
    claim: first, comment: observed.envelope.comment, reason: 'chat_admin_or_creator',
  }).resolved, false);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM runtime_assistant_moderation_dispositions').get().n, 0);
  const fresh = h.store.resolveJudgementExemption({
    claim: second, comment: observed.envelope.comment, reason: 'chat_admin_or_creator',
  });
  assert.equal(fresh.resolved, true);
  const disposition = h.db.prepare('SELECT status, verdict FROM runtime_assistant_moderation_dispositions WHERE chat_id = ? AND message_id = ?').get('-100', '10');
  assert.deepEqual(disposition, { status: 'allowed', verdict: 'exempt' });
  const newer = h.observe(update({ editDate: 500 }));
  assert.equal(h.store.resolveJudgementExemption({
    claim: second, comment: observed.envelope.comment, reason: 'chat_admin_or_creator',
  }).resolved, false);
  assert.equal(h.store.isCurrentJudgement(newer.eventId), true);
  assert.equal(h.store.getModeratorJudgement(newer.eventId).state, 'safe_retry');
});
