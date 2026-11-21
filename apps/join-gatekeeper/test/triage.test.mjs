import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { JoinStore } from '../src/store.mjs';
import { generateToken, hashToken } from '../src/tokens.mjs';
import { runTriageCli } from '../src/triage-cli.mjs';
import { classifyExport, executeTriage, sha256 } from '../src/triage.mjs';
import { TelegramApiError } from '../src/telegram-api.mjs';
import {
  ambiguousError, authError, CHAT_ID, definiteError, FakeTelegram, noRequestError, scenario, T0, tempDir, TOKEN,
} from './helpers.mjs';

const SC = scenario();
const DAY = 24 * 3600 * 1000;

function request(userId, extra = {}) {
  return {
    user_id: userId, first_name: 'Анна', last_name: 'Иванова', username: `anna${userId}`, bio: null,
    requested_at: '2026-11-10T08:00:00Z', is_bot: false, is_scam: false, is_fake: false, is_premium: null,
    has_photo: true, lang_code: 'ru', ...extra,
  };
}

function exportDoc(requests) {
  return { schema: 'joingate-pending-export-v1', chat_id: CHAT_ID, generated_at: '2026-11-17T09:00:00Z', requests };
}

function classify(requests) {
  const exportText = JSON.stringify(exportDoc(requests));
  return { exportText, ...classifyExport({ exportText, scenario: SC, now: T0 }) };
}

let dir;
let store;
afterEach(() => {
  store?.close();
  store = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('triage classify', () => {
  test('pre-check codes: R_SCAM / R_PROFILE_AD / R_STOPWORD → reject; everything else → accept_restricted', () => {
    const { exportText, files, summary } = classify([
      request(1),
      request(2, { is_scam: true }),
      request(3, { is_fake: true }),
      request(4, { is_bot: true }),
      request(5, { bio: 'crypto casino заработок' }),
      request(6, { bio: 'мой сайт https://example.com' }),
      request(7, { first_name: '🔥🔥', last_name: null, has_photo: false }),
      request(8, { last_name: '@promo_ch' }),
    ]);
    const reject = JSON.parse(files['reject.json']);
    const accept = JSON.parse(files['accept_restricted.json']);
    assert.equal(reject.schema, 'joingate-triage-v1');
    assert.equal(reject.source_sha256, sha256(exportText));
    assert.equal(reject.chat_id, CHAT_ID);
    assert.deepEqual(reject.items.map((i) => [i.user_id, i.reasons]), [
      [2, ['R_SCAM']], [3, ['R_SCAM']], [4, ['R_SCAM']], [5, ['R_STOPWORD']], [6, ['R_PROFILE_AD']], [8, ['R_PROFILE_AD']],
    ]);
    assert.deepEqual(reject.items[0].signals, ['is_scam']);
    assert.deepEqual(reject.items[4].signals, ['link:bio']);
    assert.deepEqual(accept.items, [
      { user_id: 1, requested_at: '2026-11-10T08:00:00Z', reasons: [], signals: [] },
      { user_id: 7, requested_at: '2026-11-10T08:00:00Z', reasons: [], signals: [] },
    ], 'soft signals (emoji name, no photo) do not reject');
    assert.deepEqual(summary.counts, { reject: 6, accept_restricted: 2 });
    assert.deepEqual(summary.reasons.reject, { R_SCAM: 3, R_STOPWORD: 1, R_PROFILE_AD: 2 });
    assert.deepEqual(summary.reasons.accept_restricted, { none: 2 });
    assert.equal(summary.list_sha256.reject, sha256(files['reject.json']));
  });

  test('has_personal_chat: true → R_PROFILE_AD; false / null / missing → no signal', () => {
    const withField = classify([
      request(1, { has_personal_chat: true }),
      request(2, { has_personal_chat: false }),
      request(3, { has_personal_chat: null }),
      request(4),
    ]);
    const reject = JSON.parse(withField.files['reject.json']);
    assert.deepEqual(reject.items.map((i) => [i.user_id, i.reasons, i.signals]), [[1, ['R_PROFILE_AD'], ['personal_chat']]]);
    assert.deepEqual(JSON.parse(withField.files['accept_restricted.json']).items.map((i) => i.user_id), [2, 3, 4]);
    const doc = exportDoc([request(1)]);
    doc.requests[0].has_personal_chat = 'yes';
    assert.throws(() => classifyExport({ exportText: JSON.stringify(doc), scenario: SC }), /has_personal_chat must be a boolean or null/);
  });

  test('is_deleted: true → R_DELETED before R_SCAM; false / null / missing → no signal; counted in summary', () => {
    const { files, summary } = classify([
      request(1, { is_deleted: true, is_scam: true, bio: 'https://x.example' }),
      request(2, { is_deleted: false }),
      request(3, { is_deleted: null }),
      request(4),
      request(5, { is_deleted: true }),
    ]);
    const reject = JSON.parse(files['reject.json']);
    assert.deepEqual(reject.items.map((i) => [i.user_id, i.reasons, i.signals]), [
      [1, ['R_DELETED'], ['is_deleted']], [5, ['R_DELETED'], ['is_deleted']],
    ]);
    assert.deepEqual(JSON.parse(files['accept_restricted.json']).items.map((i) => i.user_id), [2, 3, 4]);
    assert.deepEqual(summary.reasons.reject, { R_DELETED: 2 });
    const doc = exportDoc([request(1)]);
    doc.requests[0].is_deleted = 'true';
    assert.throws(() => classifyExport({ exportText: JSON.stringify(doc), scenario: SC }), /is_deleted must be a boolean or null/);
  });

  test('execute reject records R_DELETED as decision_reason', async () => {
    dir = tempDir();
    store = new JoinStore(path.join(dir, 'join-gatekeeper.sqlite'));
    const { files } = classify([request(1, { is_deleted: true })]);
    const listText = files['reject.json'];
    const receipt = await executeTriage({
      listText, action: 'reject', expectSha256: sha256(listText), confirm: true, store, telegram: new FakeTelegram(),
      targetChatIds: [String(CHAT_ID)], sleep: async () => {}, now: () => T0,
    });
    assert.equal(receipt.completed, true);
    assert.equal(store.listByUserAndStates(1, ['declined_screening'])[0].decision_reason, 'R_DELETED');
  });

  test('null fields are unknown, never false', () => {
    const { files } = classify([request(7, {
      first_name: null, last_name: null, username: null, is_bot: null, is_scam: null, is_fake: null, has_photo: null,
    })]);
    assert.deepEqual(JSON.parse(files['accept_restricted.json']).items[0].reasons, []);
  });

  test('schema errors are refused', () => {
    const bad = {
      'wrong schema': (d) => { d.schema = 'v0'; },
      'missing user_id': (d) => { delete d.requests[0].user_id; },
      'non-positive user_id': (d) => { d.requests[0].user_id = -5; },
      'missing requested_at': (d) => { delete d.requests[0].requested_at; },
      'bad requested_at': (d) => { d.requests[0].requested_at = 'yesterday'; },
      'string boolean': (d) => { d.requests[0].is_scam = 'true'; },
      'unknown key': (d) => { d.requests[0].email = 'a@b.c'; },
      'duplicate user': (d) => { d.requests.push(request(1)); },
      'positive chat id': (d) => { d.chat_id = 5; },
    };
    for (const [name, edit] of Object.entries(bad)) {
      const doc = exportDoc([request(1)]);
      edit(doc);
      assert.throws(() => classifyExport({ exportText: JSON.stringify(doc), scenario: SC }), /invalid joingate-pending-export-v1/, name);
    }
    assert.throws(() => classifyExport({ exportText: '{', scenario: SC }), /not JSON/);
  });

  test('CLI classify writes 0600 files and refuses to overwrite', async () => {
    dir = tempDir();
    const input = path.join(dir, 'export.json');
    fs.writeFileSync(input, JSON.stringify(exportDoc([request(1), request(2, { is_scam: true })])));
    const outDir = path.join(dir, 'triage-out');
    const summary = await runTriageCli(['classify', '--input', input, '--out-dir', outDir], { env: {}, out: () => {}, now: () => T0 });
    assert.equal(summary.total, 2);
    for (const name of ['reject.json', 'accept_restricted.json', 'summary.json']) {
      assert.equal(fs.statSync(path.join(outDir, name)).mode & 0o777, 0o600);
    }
    await assert.rejects(() => runTriageCli(['classify', '--input', input, '--out-dir', outDir], { env: {}, out: () => {} }), /overwrite/);
  });
});

describe('triage execute', () => {
  function setup(requests) {
    dir = tempDir();
    store = new JoinStore(path.join(dir, 'join-gatekeeper.sqlite'));
    const { files } = classify(requests);
    return { files, telegram: new FakeTelegram() };
  }

  function run(listText, action, options = {}) {
    const sleeps = [];
    let t = T0;
    return executeTriage({
      listText, action, expectSha256: sha256(listText), confirm: true, store, targetChatIds: [String(CHAT_ID)],
      probationDays: 7, now: () => t++, sleep: async (ms) => { sleeps.push(ms); }, ...options,
    }).then((receipt) => ({ receipt, sleeps }));
  }

  test('dry run makes no calls; wrong sha refuses', async () => {
    const { files, telegram } = setup([request(1), request(2)]);
    const listText = files['accept_restricted.json'];
    const plan = await executeTriage({ listText, action: 'accept_restricted', expectSha256: sha256(listText), telegram, store });
    assert.equal(plan.dry_run, true);
    assert.deepEqual(plan.user_ids, [1, 2]);
    assert.deepEqual(telegram.calls, []);
    assert.deepEqual(store.listJournal(), []);
    await assert.rejects(() => executeTriage({ listText, action: 'accept_restricted', expectSha256: 'a'.repeat(64) }), /does not match/);
    await assert.rejects(() => executeTriage({
      listText, action: 'accept_restricted', expectSha256: 'a'.repeat(64), confirm: true, store, telegram, targetChatIds: [String(CHAT_ID)],
    }), /does not match/);
    assert.deepEqual(telegram.calls, []);
    await assert.rejects(() => executeTriage({ listText, action: 'reject', expectSha256: sha256(listText) }), /is "accept_restricted"/);
  });

  test('confirm accept_restricted: approve + restrict + probation, paced ≥1 s; verified member approved without restriction', async () => {
    const { files, telegram } = setup([request(1), request(2), request(3)]);
    const token = generateToken();
    store.insertIssuedToken({ tokenSha256: hashToken(token), siteRecordId: 'paid-3', now: T0 });
    store.useToken({ tokenSha256: hashToken(token), userId: 3, now: T0 });
    const { receipt, sleeps } = await run(files['accept_restricted.json'], 'accept_restricted', { telegram });
    assert.equal(receipt.completed, true);
    assert.deepEqual(receipt.counts, { approved_restricted: 2, approved_verified: 1 });
    assert.deepEqual(sleeps, [1000, 1000]);
    assert.deepEqual(telegram.calls.map((c) => [c.method, c.payload.user_id]), [
      ['approveChatJoinRequest', 1], ['restrictChatMember', 1],
      ['approveChatJoinRequest', 2], ['restrictChatMember', 2],
      ['approveChatJoinRequest', 3],
    ]);
    assert.ok(Object.values(telegram.calls[1].payload.permissions).every((v) => v === false));
    const probation = store.listByUserAndStates(1, ['probation']);
    assert.equal(probation.length, 1);
    assert.equal(probation[0].restrict_state, 'restricted');
    assert.ok(probation[0].probation_deadline_at >= T0 + 7 * DAY);
    assert.equal(store.listByUserAndStates(3, ['approved_token']).length, 1);
    assert.equal(receipt.schema, 'joingate-triage-receipt-v1');
    assert.equal(store.listJournal('triage_receipt').length, 1);
  });

  test('confirm accept_restricted: unconfirmed restriction goes to the discrepancy queue, not probation', async () => {
    const { files, telegram } = setup([request(1)]);
    telegram.failNext('restrictChatMember', definiteError('restrictChatMember'));
    const { receipt } = await run(files['accept_restricted.json'], 'accept_restricted', { telegram });
    assert.deepEqual(receipt.counts, { approved_restrict_failed: 1 });
    assert.equal(store.listByUserAndStates(1, ['probation']).length, 0);
    const queue = store.listRestrictionDiscrepancies();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].decision_reason, 'restrict_unconfirmed');
    assert.equal(queue[0].restrict_state, 'failed');
  });

  test('pacing below 1 s and non-allowlisted chat are refused', async () => {
    const { files, telegram } = setup([request(1)]);
    const listText = files['accept_restricted.json'];
    await assert.rejects(() => run(listText, 'accept_restricted', { telegram, pacingMs: 10 }), /at least 1000/);
    await assert.rejects(() => run(listText, 'accept_restricted', { telegram, targetChatIds: ['-100777'] }), /not in/);
    assert.deepEqual(telegram.calls, []);
  });

  test('reject: decline; stops on the first ambiguous error; idempotent rerun continues', async () => {
    const { files, telegram } = setup([
      request(1, { is_scam: true }), request(2, { is_fake: true }), request(3, { is_bot: true }),
    ]);
    const listText = files['reject.json'];
    // user 1 ok, user 2 ambiguous → stop before user 3
    const queue = [null, ambiguousError('declineChatJoinRequest')];
    const original = telegram.declineChatJoinRequest.bind(telegram);
    telegram.declineChatJoinRequest = async (payload) => {
      const failure = queue.shift();
      if (failure) {
        telegram.calls.push({ method: 'declineChatJoinRequest', payload });
        throw failure;
      }
      return original(payload);
    };
    const first = await run(listText, 'reject', { telegram });
    assert.equal(first.receipt.completed, false);
    assert.equal(first.receipt.stopped.user_id, 2);
    assert.equal(first.receipt.stopped.state, 'inconclusive');
    assert.deepEqual(telegram.calls.map((c) => c.payload.user_id), [1, 2]);
    const declined = store.listByUserAndStates(1, ['declined_screening']);
    assert.equal(declined.length, 1);
    assert.equal(declined[0].decision_reason, 'R_SCAM', 'decline records the reason code');

    const second = await run(listText, 'reject', { telegram });
    assert.equal(second.receipt.completed, true);
    assert.equal(second.receipt.counts.skipped_already_processed, 1);
    assert.equal(second.receipt.counts.declined, 2);
    assert.deepEqual(telegram.calls.map((c) => c.payload.user_id), [1, 2, 2, 3]);

    const third = await run(listText, 'reject', { telegram });
    assert.deepEqual(third.receipt.counts, { skipped_already_processed: 3 });
    assert.equal(telegram.calls.length, 4, 'nothing repeated');
  });

  test('auth error stops; "no request" is a recorded normal outcome', async () => {
    const { files, telegram } = setup([request(1, { is_scam: true }), request(2, { is_scam: true }), request(3, { is_scam: true })]);
    telegram.failNext('declineChatJoinRequest', noRequestError('declineChatJoinRequest'));
    telegram.failNext('declineChatJoinRequest', authError('declineChatJoinRequest'));
    const { receipt } = await run(files['reject.json'], 'reject', { telegram });
    assert.equal(receipt.results[0].outcome, 'no_request');
    assert.equal(receipt.stopped.user_id, 2);
    assert.equal(receipt.stopped.state, 'auth');
    assert.equal(telegram.calls.length, 2);
  });

  test('403 "user is deactivated" is skipped_deleted, not a stop; rerun goes on', async () => {
    const { files, telegram } = setup([request(1, { is_scam: true }), request(2, { is_scam: true }), request(3, { is_scam: true })]);
    telegram.failNext('declineChatJoinRequest', new TelegramApiError(
      'declineChatJoinRequest failed: Forbidden: user is deactivated', { method: 'declineChatJoinRequest', status: 403 },
    ));
    const { receipt } = await run(files['reject.json'], 'reject', { telegram });
    assert.equal(receipt.completed, true);
    assert.equal(receipt.stopped, null);
    assert.deepEqual(receipt.counts, { skipped_deleted: 1, declined: 2 });
    assert.match(receipt.results[0].error, /deactivated/);
    assert.equal(telegram.calls.length, 3);
    const again = await run(files['reject.json'], 'reject', { telegram });
    assert.deepEqual(again.receipt.counts, { skipped_already_processed: 3 });
  });

  test('a real 403 (bot was kicked) still stops the batch', async () => {
    const { files, telegram } = setup([request(1, { is_scam: true }), request(2, { is_scam: true })]);
    telegram.failNext('declineChatJoinRequest', new TelegramApiError(
      'declineChatJoinRequest failed: Forbidden: bot was kicked from the supergroup chat', { method: 'declineChatJoinRequest', status: 403 },
    ));
    const { receipt } = await run(files['reject.json'], 'reject', { telegram });
    assert.equal(receipt.stopped.state, 'auth');
    assert.equal(telegram.calls.length, 1);
  });

  test('CLI execute: dry run by default, confirm writes a 0600 receipt', async () => {
    const { files, telegram } = setup([request(1)]);
    const listFile = path.join(dir, 'accept_restricted.json');
    fs.writeFileSync(listFile, files['accept_restricted.json']);
    const sha = sha256(files['accept_restricted.json']);
    const env = {
      JOIN_GATEKEEPER_DATA_ROOT: dir,
      JOIN_GATEKEEPER_BOT_TOKEN: TOKEN,
      JOIN_GATEKEEPER_TARGET_CHAT_IDS: String(CHAT_ID),
    };
    store.close();
    store = null;
    const args = ['execute', '--list', listFile, '--action', 'accept_restricted', '--expect-sha256', sha];
    const plan = await runTriageCli(args, { env: {}, out: () => {}, telegramFactory: () => telegram });
    assert.equal(plan.dry_run, true);
    assert.deepEqual(telegram.calls, []);
    const receiptDir = path.join(dir, 'receipts');
    const printed = [];
    const receipt = await runTriageCli([...args, '--confirm', '--receipt-dir', receiptDir], {
      env, out: (l) => printed.push(l), telegramFactory: () => telegram, sleep: async () => {},
    });
    assert.equal(receipt.completed, true);
    const file = JSON.parse(printed[0]).receipt;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).list_sha256, sha);
    assert.equal(telegram.byMethod('restrictChatMember').length, 1);
  });
});
