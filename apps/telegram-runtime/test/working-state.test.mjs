import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyWorkingState, applyWorkingStateUpdate, projectWorkingState, STATE_TTL } from '../src/assistant-working-state.mjs';
import { createWorkingStateUpdater } from '../src/working-state-updater.mjs';
const pair = { id: 'c:p:t1', user: { turn_id: 'c:p:t1:user', text: 'budget is 100 and later 200', timestamp: 1000 }, assistant: { turn_id: 'c:p:t1:assistant', text: 'I propose a goal', timestamp: 1001 } };
const op = (overrides = {}) => ({ op: 'upsert', id: 'budget', kind: 'condition', value: '100', status: 'active', evidence: { turn_id: pair.user.turn_id, role: 'user', quote: '100' }, ...overrides });
const change = (state, operations, clock = 1001) => applyWorkingStateUpdate(state, { base_revision: state.revision, operations }, pair, clock);
test('attributed correction retains lineage, unrelated turns and reads do not renew TTL', () => {
  const first = change(emptyWorkingState(), [op()]); const corrected = change(first, [op({ value: '200', evidence: { ...op().evidence, quote: '200' } })]);
  assert.equal(corrected.history[1].changes[0].before.value, '100');
  assert.equal(corrected.items[0].value, '200');
  const later = change(corrected, [], 1200);
  assert.equal(later.items[0].evidence.timestamp, 1000);
  assert.equal(projectWorkingState(later, 1000 + STATE_TTL).items.length, 0);
  assert.equal(later.items.length, 1);
});
test('stale revision, fields, fabricated evidence, kinds, resolves, and assistant facts fail closed', () => {
  const state = change(emptyWorkingState(), [op()]);
  assert.throws(() => applyWorkingStateUpdate(state, { base_revision: 0, operations: [] }, pair, 1001), /stale_revision/);
  for (const operation of [op({ extra: true }), op({ kind: 'goal' }), op({ op: 'resolve', id: 'absent', status: 'resolved' }),
    op({ evidence: { ...op().evidence, quote: 'fabricated' } }), op({ evidence: { ...op().evidence, turn_id: 'other:user' } }),
    op({ evidence: { ...op().evidence, role: 'system' } }), op({ evidence: { ...op().evidence, timestamp: 1000 } }),
    op({ evidence: { turn_id: pair.assistant.turn_id, role: 'assistant', quote: 'goal' } })]) assert.throws(() => change(state, [operation]));
  const proposed = op({ id: 'proposal', kind: 'goal', status: 'proposed', evidence: { turn_id: pair.assistant.turn_id, role: 'assistant', quote: 'goal' } });
  assert.equal(change(state, [proposed]).items[1].status, 'proposed');
  assert.throws(() => change(state, [{ ...proposed, id: 'budget', kind: 'condition' }]), /assistant_fact/);
});
test('hard bounds fail rather than dropping unrelated state', () => {
  assert.throws(() => change(emptyWorkingState(), Array.from({ length: 17 }, (_, i) => op({ id: `b${i}` }))), /operation_limit/);
  const state = change(emptyWorkingState(), Array.from({ length: 16 }, (_, i) => op({ id: `b${i}` })));
  assert.throws(() => change(state, [op()]), /item_limit/);
  assert.equal(state.items.length, 16);
  assert.throws(() => change(emptyWorkingState(), [op({ value: 'x'.repeat(513) })]), /text/);
  assert.throws(() => change(emptyWorkingState(), Array.from({ length: 16 }, (_, i) => op({ id: `x${i}`, value: 'x'.repeat(512) }))), /projection_limit/);
});
test('real updater boundary receives usable current state only and records known and ambiguous errors', async () => {
  const state = change(emptyWorkingState(), [op()]); let input;
  const updater = createWorkingStateUpdater({ async complete(request) { input = JSON.parse(request.input); return { text: 'invalid', usage: { totalTokens: 7 } }; } });
  const result = await updater.update({ state, pair, now: 1000 + STATE_TTL });
  assert.deepEqual(input.state.items, []); assert.equal(input.state.history, undefined);
  assert.equal(result.status, 'state_pending'); assert.equal(result.usage.totalTokens, 7);
  const uncertain = await createWorkingStateUpdater({ async complete() { throw Object.assign(new Error('transport'), { usage: { totalTokens: 8 } }); } }).update({ state, pair, now: 1001 });
  assert.equal(uncertain.status, 'uncertain'); assert.equal(uncertain.usage.totalTokens, 8);
});
