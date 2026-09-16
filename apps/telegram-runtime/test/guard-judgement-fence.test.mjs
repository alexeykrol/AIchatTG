import assert from 'node:assert/strict';
import test from 'node:test';
import { createGuardAdapter } from '../src/guard-adapter.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture({ onRights = async () => {} } = {}) {
  const calls = [];
  let rightsCalls = 0;
  const transport = Object.fromEntries([
    'deleteMessage', 'sendMessage', 'banMember', 'banSenderChat',
  ].map((name) => [name, async (input) => {
    calls.push({ name, input });
    return { ok: true };
  }]));
  transport.getChatMember = async () => {
    await onRights(++rightsCalls);
    return { ok: true, data: {
      status: 'administrator', can_delete_messages: true, can_restrict_members: true,
    } };
  };
  const guard = createGuardAdapter({
    telegram: transport, guardBotId: 'guard', guardChatIds: ['chat'],
  });
  return { guard, calls, rightsCalls: () => rightsCalls };
}

const actions = [
  {
    name: 'warning', external: 'sendMessage', failure: 'action_precondition_unproven',
    invoke: (guard, predicate) => guard.sendWarning({
      chatId: 'chat', messageId: 'source', text: 'warning', beforeAction: predicate,
    }),
  },
  {
    name: 'member ban', external: 'banMember', failure: 'action_precondition_unproven',
    invoke: (guard, predicate) => guard.banAuthor({
      chatId: 'chat', userId: 'author', beforeAction: predicate,
    }),
  },
  {
    name: 'sender-chat ban', external: 'banSenderChat', failure: 'action_precondition_unproven',
    invoke: (guard, predicate) => guard.banAuthor({
      chatId: 'chat', senderChatId: 'channel', beforeAction: predicate,
    }),
  },
  {
    name: 'purge deletion', external: 'deleteMessage', failure: 'delete_precondition_unproven',
    invoke: (guard, predicate) => guard.deleteMessage({
      chatId: 'chat', messageId: 'purge-target', beforeDelete: predicate,
    }),
  },
];

for (const action of actions) {
  test(`Guard fences ${action.name} after a revision change during asynchronous rights proof`, async () => {
    const entered = deferred();
    const rights = deferred();
    const { guard, calls } = fixture({ onRights: async () => {
      entered.resolve();
      await rights.promise;
    } });
    let revision = 1;
    let predicateCalls = 0;
    const result = action.invoke(guard, () => {
      predicateCalls += 1;
      return revision === 1;
    });
    await entered.promise;
    assert.equal(predicateCalls, 0, 'predicate must run after live rights proof');
    assert.deepEqual(calls, []);
    revision = 2;
    rights.resolve();
    assert.deepEqual(await result, { ok: false, skipped: action.failure, uncertain: false });
    assert.equal(predicateCalls, 1);
    assert.deepEqual(calls, []);
  });

  test(`Guard permits ${action.name} only on synchronous literal true without an intervening await`, async () => {
    const { guard, calls } = fixture();
    let revision = 1;
    const result = action.invoke(guard, () => {
      queueMicrotask(() => {
        revision = 2;
        assert.equal(calls.length, 1, 'external invocation must precede the next microtask');
      });
      return revision === 1;
    });
    assert.deepEqual(await result, { ok: true });
    assert.equal(revision, 2);
    assert.deepEqual(calls.map(({ name }) => name), [action.external]);
  });

  for (const [name, predicate] of [
    ['false', () => false],
    ['truthy string', () => 'true'],
    ['truthy object', () => ({ ok: true })],
    ['undefined result', () => undefined],
    ['throw', () => { throw new Error('stale claim'); }],
    ['fulfilled Promise', () => Promise.resolve(true)],
    ['rejected Promise', () => Promise.reject(new Error('stale claim'))],
    ['non-function', true],
  ]) {
    test(`Guard rejects ${name} predicate for ${action.name} without any external action`, async () => {
      const { guard, calls } = fixture();
      assert.deepEqual(await action.invoke(guard, predicate), {
        ok: false, skipped: action.failure, uncertain: false,
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, []);
    });
  }
}

for (const action of actions) {
  test(`Guard independently fences ${action.name} as the second action in an enforcement plan`, async () => {
    const entered = deferred();
    const rights = deferred();
    const { guard, calls, rightsCalls } = fixture({ onRights: async (count) => {
      if (count === 2) {
        entered.resolve();
        await rights.promise;
      }
    } });
    let revision = 1;
    const isCurrent = () => revision === 1;
    assert.deepEqual(await guard.deleteMessage({
      chatId: 'chat', messageId: 'source', beforeDelete: isCurrent,
    }), { ok: true });
    const result = action.invoke(guard, isCurrent);
    await entered.promise;
    revision = 2;
    rights.resolve();
    assert.deepEqual(await result, { ok: false, skipped: action.failure, uncertain: false });
    assert.equal(rightsCalls(), 2);
    assert.deepEqual(calls, [{ name: 'deleteMessage', input: { chatId: 'chat', messageId: 'source' } }]);
  });
}

test('Guard does not reuse a successful ban fence for later purge deletions', async () => {
  let revision = 1;
  const { guard, calls, rightsCalls } = fixture({ onRights: async (count) => {
    if (count === 3) revision = 2;
  } });
  const isCurrent = () => revision === 1;
  assert.deepEqual(await guard.banAuthor({
    chatId: 'chat', userId: 'author', beforeAction: isCurrent,
  }), { ok: true });
  assert.deepEqual(await guard.deleteMessage({
    chatId: 'chat', messageId: 'purge-1', beforeDelete: isCurrent,
  }), { ok: true });
  assert.deepEqual(await guard.deleteMessage({
    chatId: 'chat', messageId: 'purge-2', beforeDelete: isCurrent,
  }), { ok: false, skipped: 'delete_precondition_unproven', uncertain: false });
  assert.equal(rightsCalls(), 3);
  assert.deepEqual(calls.map(({ name, input }) => [name, input.messageId || input.userId]), [
    ['banMember', 'author'], ['deleteMessage', 'purge-1'],
  ]);
});
