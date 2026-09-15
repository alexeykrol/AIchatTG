import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/analytics-v3.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/u)[1];

async function render(count, verifiedAt = '2026-09-15', lastFive = null) {
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
    lastFive: lastFive ?? { count: 0, pricedCount: 0, unknownCount: 0, knownEstimatedUsd: null,
      knownStagesUsd: null, cost: null, averageCostUsd: null, rows: [] },
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
      'Тарифы проверены 15.09.2026 · оценка, не счёт: в журнале нет сведений о кешировании и типе тарифа.');
    assert.equal(document.getElementById('total').children[4].children[1].textContent, '—');
    assert.equal(document.getElementById('notice').hidden, true);
  }
});

test('an absent pricing date stays unknown without leaking a technical identifier', async () => {
  const document = await render(1, null);
  assert.equal(document.getElementById('pricing').textContent,
    'Дата проверки тарифов неизвестна · оценка, не счёт: в журнале нет сведений о кешировании и типе тарифа.');
});

test('the actual page puts five question prices first and labels the four-question mean', async () => {
  const priced = { known: true, noCall: false, usd: 0.0032,
    modelId: 'gpt-5.6-terra', inputTokens: 1000, outputTokens: 100 };
  const analyzer = { known: true, noCall: false, usd: 0.00016,
    modelId: 'gpt-5.6-luna', inputTokens: 500, outputTokens: 50 };
  const noRouter = { known: true, noCall: true, usd: 0, modelId: null,
    inputTokens: null, outputTokens: null };
  const unknownRouter = { known: false, noCall: false, usd: null, modelId: null,
    inputTokens: null, outputTokens: null };
  const lastFive = { count: 5, pricedCount: 4, unknownCount: 1, partiallyPricedCount: 1,
    knownEstimatedUsd: 4 * 0.00336, knownStagesUsd: 5 * 0.00336,
    cost: null, averageCostUsd: 0.00336,
    rows: Array.from({ length: 5 }, (_, index) => ({
      askedAt: 1789500000 - index,
      question: index === 0 ? '<script>это вопрос, а не HTML</script>' : `Вопрос ${index + 1}`,
      estimatedUsd: index === 0 ? null : 0.00336,
      knownStagesUsd: 0.00336,
      stages: { answer: priced, analyzer, router: index === 0 ? unknownRouter : noRouter },
    })) };
  const document = await render(1, '2026-09-15', lastFive);
  const metrics = document.getElementById('last-five-metrics').children;
  assert.equal(metrics[0].children[1].textContent, '4 из 5');
  assert.equal(metrics[1].children[1].textContent, '—', 'a missing fifth cost cannot become a total');
  assert.equal(metrics[2].children[1].textContent, '$0.003360');
  assert.equal(metrics[2].children[2].textContent, 'По 4 оценённым из 5');
  assert.equal(metrics[3].children[2].textContent,
    'Все известные этапы; вопросов с неполной ценой: 1');
  const rows = document.getElementById('last-five-rows').children;
  assert.equal(rows.length, 5);
  assert.equal(rows[0].children[0].textContent, '<script>это вопрос, а не HTML</script>');
  assert.equal(rows[0].children[1].textContent, '—');
  assert.match(rows[0].children[3].textContent, /учтённые этапы: \$0\.003360/u);
  assert.match(rows[1].children[4].textContent, /Маршрут: не вызывался/u);
});

test('a real tiny positive charge never displays as zero', async () => {
  const stage = { known: true, noCall: false, usd: 0.0000002,
    modelId: 'gpt-5.6-luna', inputTokens: 1, outputTokens: 0 };
  const zero = { known: true, noCall: false, usd: 0,
    modelId: 'gpt-5.6-luna', inputTokens: 0, outputTokens: 0 };
  const noCall = { known: true, noCall: true, usd: 0,
    modelId: null, inputTokens: null, outputTokens: null };
  const lastFive = { count: 1, pricedCount: 1, unknownCount: 0, partiallyPricedCount: 0,
    knownEstimatedUsd: stage.usd, knownStagesUsd: stage.usd,
    cost: stage.usd, averageCostUsd: stage.usd,
    rows: [{ askedAt: 1789500000, question: 'Один токен', estimatedUsd: stage.usd,
      knownStagesUsd: stage.usd, stages: { answer: stage, analyzer: zero, router: noCall } }] };
  const document = await render(1, '2026-09-15', lastFive);
  assert.equal(document.getElementById('last-five-metrics').children[1].children[1].textContent, '<$0.000001');
  assert.equal(document.getElementById('last-five-metrics').children[1].children[2].textContent,
    'Все выбранные вопросы оценены');
  assert.equal(document.getElementById('last-five-metrics').children[2].children[2].textContent,
    'По 1 оценённому из 1');
  assert.equal(document.getElementById('last-five-rows').children[0].children[1].textContent, '<$0.000001');
  assert.equal(document.getElementById('last-five-rows').children[0].children[4].textContent.includes('$0.000000'), false);
});
