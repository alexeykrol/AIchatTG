import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/analytics-v3.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/u)[1];

async function render(count, verifiedAt = '2026-09-15') {
  const nodes = new Map();
  function element() {
    return { textContent: '', children: [], append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; } };
  }
  const document = {
    createElement: element,
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
  };
  const bucket = { count: 75, pricedCount: 0, unknownCount: 75, knownEstimatedUsd: null,
    averageCostUsd: null, cost: null };
  const data = { status: 'available', today: bucket, week: bucket, total: bucket,
    coverage: { observedChatCount: count },
    pricing: { version: 'assistant-standard-text-prices-v1', verifiedAt } };
  const before = JSON.stringify(data), requests = [];
  vm.runInNewContext(script, { document, fetch: async (...args) => {
    requests.push(args); return { ok: true, json: async () => data };
  } });
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  assert.deepEqual(requests, [['/api/operator/analytics']]);
  assert.equal(JSON.stringify(data), before, 'formatting must not mutate analytics data');
  return document;
}

test('the actual analytics script uses Russian chat forms and a human pricing date', async () => {
  for (const [count, word] of [[0, 'чатах'], [1, 'чате'], [2, 'чатах'], [5, 'чатах'],
    [11, 'чатах'], [21, 'чате'], [101, 'чате'], [111, 'чатах']]) {
    const document = await render(count);
    assert.equal(document.getElementById('coverage').textContent,
      `Ответы записаны в ${count} ${word}. Не все обращения и затраты учтены.`);
    assert.equal(document.getElementById('pricing').textContent,
      'Тарифы проверены 15.09.2026 · оценка, не счёт к оплате.');
    assert.equal(document.getElementById('total').children[4].children[1].textContent, '—');
    assert.equal(document.getElementById('notice').hidden, true);
  }
});

test('an absent pricing date stays unknown without leaking a technical identifier', async () => {
  const document = await render(1, null);
  assert.equal(document.getElementById('pricing').textContent,
    'Дата проверки тарифов неизвестна · оценка, не счёт к оплате.');
});
