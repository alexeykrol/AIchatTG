import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createModerationReviewPreview, SYNTHETIC_REVIEW_TOKEN } from '../src/moderation-review-preview.mjs';
import { createModerationReviewStore } from '../src/moderation-review-store.mjs';
import { SYNTHETIC_REVIEW_LIMITS } from '../src/moderation-review-preview.mjs';
import { MODERATION_REVIEW_PREFIX as PREFIX } from '../src/moderation-review-http.mjs';

test('synthetic end-to-end: evidence -> fake alert -> authenticated review -> draft/history -> erase', async (t) => {
  const preview = await createModerationReviewPreview({ root: mkdtempSync(join(tmpdir(), 'moderation-review-flow-')) });
  t.after(() => preview.close());
  const auth = `Basic ${Buffer.from(`operator:${SYNTHETIC_REVIEW_TOKEN}`).toString('base64')}`;
  const get = (path) => fetch(`${preview.origin}${PREFIX}${path}`, { headers: { authorization: auth } });
  const post = (path, body) => fetch(`${preview.origin}${PREFIX}${path}`, {
    method: 'POST', headers: { authorization: auth, origin: preview.origin,
      'content-type': 'application/json', 'x-operator-intent': 'moderation-review' },
    body: JSON.stringify(body),
  });
  assert.equal((await fetch(`${preview.origin}/moderation-v3.html`)).status, 401);
  assert.equal((await fetch(`${preview.origin}/moderation-v3.html`, { headers: { authorization: auth } })).status, 200);
  assert.equal(preview.alert.state, 'sent');
  assert.equal(preview.alerts.length, 1);
  assert.deepEqual(Object.keys(preview.alerts[0]).sort(), ['text', 'url']);
  assert.equal(new URL(preview.alerts[0].url).searchParams.get('case'), preview.alert.caseId);
  assert.doesNotMatch(preview.alerts[0].text, /Синтетический атлас|synthetic-author|synthetic-chat/u);
  const status = await (await get('/status')).json();
  assert.equal(status.retentionMs, null);
  assert.equal(status.collectionEnabled, false);
  assert.equal(status.deliveryEnabled, false);
  assert.equal(status.patternActivationEnabled, false);
  assert.equal(status.sanctionsEnabled, false);
  assert.equal(status.counts.retained, 1);
  assert.equal((await (await get('/cases')).json()).total, 2);
  assert.equal((await (await get('/patterns')).json()).total, 2);
  assert.equal((await (await get('/history')).json()).total, 3);

  const target = await (await get(`/cases/${preview.cases.hostile}`)).json();
  assert.match(target.messages[0].text, /<img src=x/u);
  const command = { expectedVersion: target.version, decisionId: randomUUID(), label: 'insufficient_evidence', note: 'Synthetic missing-context result' };
  const result = await (await post(`/cases/${target.id}/decisions`, command)).json();
  assert.equal(result.patternDraftId, null);
  assert.equal((await (await get('/patterns')).json()).total, 2);
  assert.equal((await (await get('/history')).json()).total, 4);
  const replay = await (await post(`/cases/${target.id}/decisions`, command)).json();
  assert.equal(replay.replayed, true);
  assert.equal((await (await get('/history')).json()).total, 4);
  assert.equal((await post(`/cases/${target.id}/decisions`, { ...command, label: 'hidden_advertising' })).status, 409);
  assert.equal((await post(`/cases/${target.id}/decisions`, { ...command, decisionId: randomUUID() })).status, 409);

  const ad = await (await get(`/cases/${preview.cases.ad}`)).json();
  assert.equal(ad.messageCount, 2);
  assert.equal(ad.messages.length, 2);
  const label = await (await post(`/cases/${ad.id}/decisions`, {
    expectedVersion: ad.version, decisionId: randomUUID(), label: 'hidden_advertising', note: 'Synthetic confirmed draft only',
  })).json();
  assert.ok(label.patternDraftId);
  assert.equal((await (await get('/patterns')).json()).total, 3);
  const erase = { expectedVersion: label.version, requestId: randomUUID() };
  const receiptResponse = await post(`/cases/${ad.id}/erase`, erase);
  assert.equal(receiptResponse.status, 200);
  const receipt = await receiptResponse.json();
  assert.equal(receipt.erased, true);
  assert.deepEqual(Object.keys(receipt).sort(), ['caseId', 'deletedAt', 'erased', 'expectedVersion', 'principal', 'requestId']);
  assert.equal((await get(`/cases/${ad.id}`)).status, 404);
  assert.equal((await (await get('/patterns')).json()).total, 2);
  assert.equal((await get(`/cases/${preview.cases.legitimate}`)).status, 200);
  assert.deepEqual(await (await post(`/cases/${ad.id}/erase`, erase)).json(), receipt);
  assert.equal((await post(`/cases/${ad.id}/erase`, { ...erase, requestId: randomUUID() })).status, 409);

  const retained = await (await get('/cases?status=retained')).json();
  assert.equal(retained.total, 1);
  const ordinary = await (await get(`/cases/${retained.cases[0].id}`)).json();
  assert.equal(ordinary.status, 'retained');
  assert.equal(ordinary.alert.state, 'disabled');
  assert.deepEqual(ordinary.patternIds, []);
  assert.equal((await post(`/cases/${ordinary.id}/erase`, {
    expectedVersion: ordinary.version, requestId: randomUUID(),
  })).status, 200);
  assert.equal((await (await get('/cases?status=retained')).json()).total, 0);
  assert.equal((await get(`/cases/${preview.cases.legitimate}`)).status, 200);
});

test('preview requires a fresh synthetic root and a rejected reseed cannot leak an open store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moderation-review-preview-restart-'));
  const preview = await createModerationReviewPreview({ root });
  const original = preview.store.status();
  await preview.close();
  await assert.rejects(createModerationReviewPreview({ root }), /synthetic_preview_requires_fresh_root/u);
  const store = createModerationReviewStore({ root, mode: 'synthetic', limits: SYNTHETIC_REVIEW_LIMITS });
  try { assert.deepEqual(store.status(), original); } finally { store.close(); }
});

test('preview rejects unrelated nonempty roots before changing files or permissions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'moderation-review-preview-unrelated-'));
  chmodSync(root, 0o755);
  const note = join(root, 'preserved.txt');
  writeFileSync(note, 'Synthetic unrelated contents');
  const before = { mode: lstatSync(root).mode, files: readdirSync(root), contents: readFileSync(note, 'utf8') };
  await assert.rejects(createModerationReviewPreview({ root }), /synthetic_preview_requires_fresh_root/u);
  assert.deepEqual({ mode: lstatSync(root).mode, files: readdirSync(root), contents: readFileSync(note, 'utf8') }, before);
});
