import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REWRITE_MAX_ATTEMPTS,
  REWRITE_MAX_CHARS,
  REWRITE_REASONS,
  chooseBetterPack,
  packBestScore,
  rewriteTrace,
  shouldRewrite,
  validateRewrite,
} from '../src/rewrite.mjs';

function pack(status, confidence = 'low', scores = []) {
  return {
    status,
    confidence,
    selected: scores.map((score, i) => ({ chunk_id: `c${i}`, score, selection_reason: '' })),
  };
}

test('Rewrite stays off unless it is explicitly enabled', () => {
  const gate = shouldRewrite(pack('not_found', 'none'), {});
  assert.equal(gate.rewrite, false);
  assert.equal(gate.reason, REWRITE_REASONS.DISABLED);
  assert.equal(shouldRewrite(pack('not_found', 'none'), { enabled: false }).rewrite, false);
});

test('Only an ungrounded pack earns a second pass', () => {
  for (const status of ['not_found', 'insufficient_context', 'error']) {
    const gate = shouldRewrite(pack(status), { enabled: true });
    assert.equal(gate.rewrite, true, `${status} must trigger`);
    assert.equal(gate.reason, null);
  }
  // A grounded pack is never re-searched: paying a model call to improve an
  // answer the retriever already supports buys nothing measurable.
  const ready = shouldRewrite(pack('ready', 'high'), { enabled: true });
  assert.equal(ready.rewrite, false);
  assert.equal(ready.reason, REWRITE_REASONS.NOT_TRIGGERED);
});

test('The second pass is bounded to exactly one attempt', () => {
  assert.equal(REWRITE_MAX_ATTEMPTS, 1);
  const exhausted = shouldRewrite(pack('not_found', 'none'), { enabled: true, attempts: 1 });
  assert.equal(exhausted.rewrite, false);
  assert.equal(exhausted.reason, REWRITE_REASONS.BUDGET_EXHAUSTED);
});

test('A missing pack cannot trigger a rewrite', () => {
  const gate = shouldRewrite(null, { enabled: true });
  assert.equal(gate.rewrite, false);
  assert.equal(gate.reason, REWRITE_REASONS.PACK_MISSING);
});

test('A usable rewrite is a bounded, changed, non-empty string', () => {
  const ok = validateRewrite('  память моделей между сессиями  ', 'бот помнил прошлый разговор?');
  assert.equal(ok.valid, true);
  assert.equal(ok.question, 'память моделей между сессиями');
  assert.equal(ok.reason, null);
});

test('Degenerate rewrites are rejected before they cost a second search', () => {
  const original = 'как передать контекст?';
  // Declining to rewrite and answering with garbage are different events: a
  // measurement that merges them cannot say whether the mechanism or its input
  // was missing.
  assert.equal(validateRewrite(null, original).reason, REWRITE_REASONS.DECLINED);
  assert.equal(validateRewrite(undefined, original).reason, REWRITE_REASONS.DECLINED);
  assert.equal(validateRewrite({ question: 'x' }, original).reason, REWRITE_REASONS.NOT_A_STRING);
  assert.equal(validateRewrite(42, original).reason, REWRITE_REASONS.NOT_A_STRING);
  assert.equal(validateRewrite('   ', original).reason, REWRITE_REASONS.EMPTY);
  assert.equal(validateRewrite('ab', original).reason, REWRITE_REASONS.EMPTY);
  assert.equal(validateRewrite('я'.repeat(REWRITE_MAX_CHARS + 1), original).reason,
    REWRITE_REASONS.TOO_LONG);
  // An echo of the question would re-run an identical search for the price of a
  // model call, so it is refused on the normalized form rather than byte-wise.
  assert.equal(validateRewrite('Как  передать КОНТЕКСТ?', original).reason,
    REWRITE_REASONS.UNCHANGED);
  for (const rejected of [null, '   ', 'Как  передать КОНТЕКСТ?']) {
    assert.equal(validateRewrite(rejected, original).question, null);
  }
});

test('Status decides the winner before anything else', () => {
  const first = pack('not_found', 'none', []);
  const second = pack('ready', 'low', [0.61]);
  const forward = chooseBetterPack(first, second);
  assert.equal(forward.winner, 'second');
  assert.equal(forward.reason, 'status');
  assert.equal(forward.pack, second);

  // A rewrite that lands on a worse status must not replace the first pack.
  const backward = chooseBetterPack(pack('ready', 'high', [0.9]), pack('not_found', 'none'));
  assert.equal(backward.winner, 'first');
  assert.equal(backward.pack.status, 'ready');
});

test('Confidence breaks a status tie, then the best entry score', () => {
  const byConfidence = chooseBetterPack(pack('ready', 'low', [0.9]), pack('ready', 'high', [0.7]));
  assert.equal(byConfidence.winner, 'second');
  assert.equal(byConfidence.reason, 'confidence');

  const byScore = chooseBetterPack(
    pack('insufficient_context', 'low', [0.31, 0.2]),
    pack('insufficient_context', 'low', [0.44]));
  assert.equal(byScore.winner, 'second');
  assert.equal(byScore.reason, 'score');

  const worseScore = chooseBetterPack(
    pack('insufficient_context', 'low', [0.44]),
    pack('insufficient_context', 'low', [0.31]));
  assert.equal(worseScore.winner, 'first');
  assert.equal(worseScore.reason, 'score');
});

test('A complete tie keeps the question the user actually asked', () => {
  const first = pack('insufficient_context', 'low', [0.4]);
  const second = pack('insufficient_context', 'low', [0.4]);
  const chosen = chooseBetterPack(first, second);
  assert.equal(chosen.winner, 'first');
  assert.equal(chosen.reason, 'tie');
  assert.equal(chosen.pack, first);
});

test('A missing side of the comparison never wins', () => {
  const real = pack('ready', 'high', [0.8]);
  assert.equal(chooseBetterPack(real, null).winner, 'first');
  assert.equal(chooseBetterPack(real, null).reason, 'second_missing');
  assert.equal(chooseBetterPack(null, real).winner, 'second');
  assert.equal(chooseBetterPack(null, real).reason, 'first_missing');
});

test('Best score reads only finite numbers and defaults to zero', () => {
  assert.equal(packBestScore(pack('ready', 'low', [0.2, 0.75, 0.5])), 0.75);
  assert.equal(packBestScore(pack('not_found', 'none', [])), 0);
  assert.equal(packBestScore(null), 0);
  assert.equal(packBestScore({ selected: [{ score: 'x' }, { score: 0.3 }] }), 0.3);
});

test('The trace states what was tried and why the winner won', () => {
  const trace = rewriteTrace({
    attempted: true, rewrittenQuestion: 'память моделей', reason: 'status',
    winner: 'second', firstStatus: 'not_found', secondStatus: 'ready',
  });
  assert.deepEqual({ ...trace }, {
    attempted: true,
    max_attempts: 1,
    rewritten_question: 'память моделей',
    reason: 'status',
    winner: 'second',
    first_status: 'not_found',
    second_status: 'ready',
  });
  assert.equal(Object.isFrozen(trace), true);

  const skipped = rewriteTrace({ attempted: false, reason: REWRITE_REASONS.DISABLED });
  assert.equal(skipped.attempted, false);
  assert.equal(skipped.rewritten_question, null);
  assert.equal(skipped.winner, null);
});
