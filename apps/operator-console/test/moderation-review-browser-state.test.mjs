import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/moderation-v3.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/u)[1];
const prefix = '/api/operator/moderation-review/v1';
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const enabled = { mode:'synthetic', decisionsEnabled:true, retentionMs:null, collectionEnabled:false, deliveryEnabled:false, patternActivationEnabled:false, sanctionsEnabled:false };
const cases = [a, b].map((id) => ({ id, version:1, status:'pending', preview:`Synthetic ${id}`, updatedAt:'2026-09-15T10:00:00Z', messageCount:1 }));
const queuePath = `${prefix}/cases?status=pending&limit=30&offset=0`;

function detail(id = a, version = 1, extra = {}) {
  return { ...cases.find((item) => item.id === id), version, chatId:'synthetic-chat', detectorVersion:'synthetic-v1', expiresAt:null,
    messages:[{ messageId:'synthetic-message', revision:1, text:`Private synthetic evidence ${id}`, userId:'synthetic-user', observedAt:'2026-09-15T10:00:00Z', context:null, truncated:false }],
    reasons:['synthetic_reason'], alert:{ state:'uncertain' }, decisions:[], ...extra };
}
function element(tag = 'div') {
  const node = { tag, value:'', textContent:'', className:'', hidden:false, disabled:false, children:[], listeners:{}, dataset:{}, attributes:{},
    replaceChildren(...children) { this.children = children; this.textContent = ''; },
    append(...children) { this.children.push(...children); },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
  };
  Object.defineProperty(node, 'innerHTML', { set() { throw new Error('Private data must never enter HTML'); } });
  return node;
}
function allText(node) { return [node.textContent, ...node.children.map(allText)].join('\n'); }
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
async function flush() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }
function setup(search = '') {
  const nodes = new Map(), requests = [], urls = [];
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gu)) {
    const node = element(match[1]); node.hidden = /\bhidden\b/u.test(match[2]); node.disabled = /\bdisabled\b/u.test(match[2]); nodes.set(match[3], node);
  }
  const document = { getElementById(id) { assert.ok(nodes.has(id), `Unknown element ${id}`); return nodes.get(id); }, createElement:element };
  let serial = 0;
  const context = vm.createContext({ document, URLSearchParams, location:{ search }, history:{ replaceState(_state, _unused, url) { urls.push(url); } },
    crypto:{ randomUUID() { serial += 1; return `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`; } },
    fetch(path, options = {}) { return new Promise((resolve, reject) => {
      requests.push({ path, method:options.method || 'GET', headers:options.headers, credentials:options.credentials, cache:options.cache,
        body:options.body ? JSON.parse(options.body) : undefined,
        respond(data, status = 200) { resolve({ ok:status < 400, status, json:async () => data }); },
        invalidJson(status = 200) { resolve({ ok:status < 400, status, json:async () => { throw new Error('invalid JSON'); } }); }, reject,
      });
    }); },
  });
  vm.runInContext(script, context);
  const ui = { requests, urls, node:(id) => document.getElementById(id),
    take(path, method = 'GET') { const index = requests.findIndex((request) => request.path === path && request.method === method); assert.notEqual(index, -1, `Missing ${method} ${path}; pending: ${requests.map((request) => request.path)}`); return requests.splice(index, 1)[0]; },
    click(id) { return document.getElementById(id).listeners.click(); },
    filter(status) { ui.node('queue-filter').value = status; return ui.node('queue-filter').listeners.change(); },
    choose(label = 'hidden_advertising', note = 'Synthetic owner note') { ui.node('review-label').value = label; ui.node('review-note').value = note; ui.node('review-label').listeners.change(); },
    select(id) { const button = ui.node('case-list').children.find((node) => node.dataset.caseId === id); assert.ok(button, `Missing case ${id}`); return button.listeners.click(); },
  };
  return ui;
}
async function fixture({ search = '', status = enabled, selected = a } = {}) {
  const ui = setup(search);
  ui.take(`${prefix}/status`).respond(status); await flush();
  if (status.decisionsEnabled !== true) return ui;
  ui.take(queuePath).respond({ cases, total:cases.length }); await flush();
  if (search === `?case=${a}` || search === `?case=${b}`) {
    const id = new URLSearchParams(search).get('case'); ui.take(`${prefix}/cases/${id}`).respond(detail(id)); await flush();
  } else if (selected) {
    const selecting = ui.select(selected); ui.take(`${prefix}/cases/${selected}`).respond(detail(selected)); await selecting;
  }
  return ui;
}
function decisionResponse(request) { return { caseId:request.path.includes(b) ? b : a, version:request.body.expectedVersion, decisionId:request.body.decisionId, label:request.body.label, patternDraftId:request.body.label === 'insufficient_evidence' ? null : 'synthetic-draft' }; }
function eraseResponse(request) { return { caseId:request.path.includes(b) ? b : a, expectedVersion:request.body.expectedVersion, requestId:request.body.requestId, erased:true, principal:'operator', deletedAt:'2026-09-15T10:00:00Z' }; }

test('preserves seven shell links, release stamp, shared stylesheet and fourth reference section', () => {
  const nav = html.match(/<nav class="nav"[\s\S]*?<\/nav>/u)[0];
  assert.deepEqual([...nav.matchAll(/href="([^"]+)"/gu)].map((match) => match[1]), ['/moderation-v3.html', '/assistant-v3.html', '/settings-v3.html', '/domains-v3.html', '/analytics-v3.html', '/tests-v3.html', '/help-v3.html']);
  assert.equal((html.match(/\{\{CONSOLE_RELEASE_STAMP\}\}/gu) || []).length, 1);
  assert.match(html, /href="\/console-v3\.css"/u);
  assert.match(html, /@media \(max-width:760px\).*grid-template-columns:minmax\(0, 1fr\)/u);
  assert.match(html, /@media \(max-width:760px\).*section:last-child \{ order:-1; \}/u, 'deep-linked evidence precedes the potentially long queue on a phone');
  assert.match(html, /white-space:pre-wrap; overflow-wrap:anywhere/u);
  assert.match(html, /min-height:44px/u);
  assert.match(html, /id="panel-reference"[\s\S]*?Действующий режим[\s\S]*?Действующий текст правил/u);
});

test('disabled status is not an empty queue and performs no private reads or writes', async () => {
  const ui = await fixture({ search:`?case=${a}`, status:{ decisionsEnabled:false, mode:'disabled' } });
  assert.match(ui.node('review-status').textContent, /отключена.*не пустая очередь/u);
  assert.equal(ui.node('review-save').disabled, true); assert.equal(ui.node('erase-start').disabled, true);
  await ui.click('review-save'); await ui.click('erase-confirm');
  assert.equal(ui.requests.length, 0); assert.equal(ui.node('case-detail').hidden, true);
});

test('an unmounted new API is unavailable, not an empty queue or an expired case', async () => {
  const ui = setup(); ui.take(`${prefix}/status`).respond({ error:'not_found' }, 404); await flush();
  assert.match(ui.node('review-status').textContent, /Сервис.*недоступен.*не пустая выборка/u);
  assert.doesNotMatch(ui.node('review-status').textContent, /Кейс не найден/u);
  assert.equal(ui.node('review-save').disabled, true); assert.equal(ui.requests.length, 0);
});

test('failed live bootstrap is unavailable, not disabled or missing stored evidence', async () => {
  const ui = await fixture({ search:`?case=${a}`, status:{ mode:'unavailable', decisionsEnabled:false } });
  assert.match(ui.node('review-status').textContent, /недоступен.*Полнота захвата неизвестна.*основная модерация/u);
  assert.match(ui.node('case-status').textContent, /не означает, что материалы удалены/u);
  assert.equal(ui.requests.length, 0); assert.equal(ui.node('review-save').disabled, true);
});

test('live coverage reports attempts and unknown history without claiming complete capture', async () => {
  const ui = await fixture({ status:{ ...enabled, mode:'live', deliveryEnabled:true,
    coverage:{ countersKnownSinceBoot:true, counts:{ acknowledged:4, not_attempted:1, rejected:0, uncertain:2 } } } });
  assert.match(ui.node('retention').textContent, /подтверждено 4, не начато 1, отклонено 0, исход неизвестен 2/u);
  assert.match(ui.node('retention').textContent, /не уникальных сообщений.*Полнота истории неизвестна.*не восстанавливаются.*включены/u);
  assert.match(ui.node('case-alert').textContent, /Личное служебное уведомление.*Санкции в чате не выполняются/u);
  const unknown = await fixture({ status:{ ...enabled, mode:'live', coverage:{ status:'unknown', counts:null } } });
  assert.match(unknown.node('retention').textContent, /Сведения о захвате сообщений недоступны/u);
  assert.doesNotMatch(unknown.node('retention').textContent, /подтверждено 0/u);
});

test('covert promotion has cautious Russian reasons and erase discloses race and replay limits', async () => {
  const ui = await fixture(); const selecting = ui.select(a);
  ui.take(`${prefix}/cases/${a}`).respond(detail(a, 1, { patternIds:['covert-testimonial-bait'],
    reasons:['covert_testimonial_bait'] })); await selecting;
  assert.match(allText(ui.node('case-reasons')), /Подозрение на скрытую рекламу в отзыве/u);
  ui.click('erase-start'); const warning = ui.node('erase-explanation').textContent;
  assert.match(warning, /идентификаторы источника.*Защита от повторного появления.*не сохраняется/u);
  assert.match(warning, /служебное уведомление может прийти после удаления.*Контекст в других кейсах/u);
  ui.click('erase-cancel'); assert.equal(ui.node('erase-confirmation').hidden, true);
  assert.equal(ui.requests.length, 0);
});

test('retained filter reads ordinary observations without changing the selected case or triggering actions', async () => {
  const ui = await fixture(); assert.equal(ui.node('queue-filter').value, 'pending');
  ui.choose('legitimate', 'Keep current edit'); ui.click('erase-start');
  const filtering = ui.filter('retained');
  assert.equal(ui.node('erase-confirmation').hidden, true); await ui.click('erase-confirm');
  const request = ui.take(`${prefix}/cases?status=retained&limit=30&offset=0`);
  assert.equal(ui.requests.length, 0); assert.equal(request.method, 'GET');
  request.respond({ cases:[{ ...cases[1], status:'retained', patternIds:[], label:null }], total:1 }); await filtering;
  assert.equal(ui.node('case-title').textContent, `Кейс ${a.slice(0, 8)}`); assert.equal(ui.node('review-note').value, 'Keep current edit');
  assert.match(allText(ui.node('case-list')), /Сохранённое наблюдение/u); assert.equal(ui.node('queue-title').textContent, 'Сохранённые наблюдения');
  const selecting = ui.select(b); ui.take(`${prefix}/cases/${b}`).respond(detail(b, 4, { status:'retained', reasons:[], patternIds:[], alert:{ state:'disabled' } })); await selecting;
  assert.match(ui.node('case-title').textContent, /Сохранённое наблюдение/u); assert.match(allText(ui.node('case-reasons')), /Подозрения не обнаружены/u);
  assert.match(ui.node('case-alert').textContent, /Уведомление отключено/u); assert.equal(ui.node('erase-start').disabled, false); assert.equal(ui.requests.length, 0);
  ui.click('erase-start'); const erasing = ui.click('erase-confirm'); const erase = ui.take(`${prefix}/cases/${b}/erase`, 'POST');
  assert.equal(erase.body.expectedVersion, 4); erase.respond({ error:'review_case_stale' }, 409); await erasing;
  assert.equal(ui.node('case-detail').hidden, false); assert.equal(ui.node('erase-start').disabled, true);
});

for (const fail of [false, true]) {
  test(`late prior-filter ${fail ? 'failure' : 'response'} cannot replace all-cases results`, async () => {
    const ui = await fixture();
    const first = ui.filter('retained'); const old = ui.take(`${prefix}/cases?status=retained&limit=30&offset=0`);
    const next = ui.filter('all'); const latest = ui.take(`${prefix}/cases?status=all&limit=30&offset=0`);
    latest.respond({ cases:[cases[0]], total:1 }); await next;
    const status = ui.node('queue-status').textContent;
    if (fail) old.reject(new Error('late private error')); else old.respond({ cases:[{ ...cases[1], status:'retained' }], total:1 });
    await first;
    assert.equal(ui.node('queue-filter').value, 'all'); assert.equal(ui.node('queue-status').textContent, status);
    assert.equal(ui.node('case-list').children[0].dataset.caseId, a); assert.equal(ui.node('queue-title').textContent, 'Все кейсы');
    assert.equal(ui.node('case-title').textContent, `Кейс ${a.slice(0, 8)}`); assert.equal(ui.requests.length, 0);
  });
}

test('filtering preserves the exact in-flight request target/version and never causes another write', async () => {
  const ui = await fixture(); ui.choose(); const saving = ui.click('review-save'); const save = ui.take(`${prefix}/cases/${a}/decisions`, 'POST');
  const filtering = ui.filter('retained'); ui.take(`${prefix}/cases?status=retained&limit=30&offset=0`).respond({ cases:[{ ...cases[1], status:'retained' }], total:1 }); await filtering;
  const selecting = ui.select(b); ui.take(`${prefix}/cases/${b}`).respond(detail(b, 7, { status:'retained', reasons:[], alert:{ state:'disabled' } })); await selecting;
  assert.equal(save.body.expectedVersion, 1); assert.equal(save.path, `${prefix}/cases/${a}/decisions`);
  save.respond(decisionResponse(save)); await saving;
  assert.match(ui.node('case-title').textContent, new RegExp(b.slice(0, 8))); assert.equal(ui.requests.length, 0);
});

test('empty retained results are distinct from disabled/unavailable state, and filter values are allowlisted', async () => {
  const ui = await fixture(); const filtering = ui.filter('retained'); ui.take(`${prefix}/cases?status=retained&limit=30&offset=0`).respond({ cases:[], total:0 }); await filtering;
  assert.match(ui.node('queue-status').textContent, /наблюдений.*нет.*не подтверждает.*сбор включён/u);
  await ui.filter('all&action=erase'); assert.equal(ui.node('queue-filter').value, 'retained'); assert.equal(ui.requests.length, 0);
  const disabled = await fixture({ status:{ decisionsEnabled:false } }); assert.equal(disabled.node('queue-filter').disabled, true);
  await disabled.filter('retained'); assert.equal(disabled.requests.length, 0); assert.equal(disabled.node('queue-filter').value, 'pending');
});

test('changing the filter resets pagination without changing the selected UUID', async () => {
  const ui = await fixture();
  const all = ui.filter('all'); ui.take(`${prefix}/cases?status=all&limit=30&offset=0`).respond({ cases, total:61 }); await all;
  const next = ui.click('queue-next'); ui.take(`${prefix}/cases?status=all&limit=30&offset=30`).respond({ cases, total:61 }); await next;
  const retained = ui.filter('retained'); ui.take(`${prefix}/cases?status=retained&limit=30&offset=0`).respond({ cases:[], total:0 }); await retained;
  assert.equal(ui.node('queue-prev').disabled, true); assert.equal(ui.urls.at(-1), `/moderation-v3.html?case=${a}`); assert.equal(ui.requests.length, 0);
});

test('opaque deep link loads only its case with no implicit action or arbitrary URL target', async () => {
  const ui = await fixture({ search:`?case=${b}`, selected:null });
  assert.equal(ui.node('panel-queue').hidden, false); assert.equal(ui.node('case-title').textContent, `Кейс ${b.slice(0, 8)}`);
  assert.ok(ui.node('case-meta').textContent.includes(b));
  assert.equal(ui.requests.length, 0); assert.equal(ui.urls.length, 0);
  assert.match(allText(ui.node('case-messages')), /Контекст отсутствует/u);
  assert.equal(ui.node('retention').textContent, 'Бессрочно, до ручного удаления');
});

for (const search of ['?case=../../erase', '?case=javascript:alert(1)', `?case=${a}&case=${b}`, '?case=%3Cimg%20onerror=attack%3E']) {
  test(`rejects invalid or ambiguous deep link ${search}`, async () => {
    const ui = await fixture({ search, selected:null });
    assert.match(ui.node('case-status').textContent, /Некорректная ссылка/u);
    assert.equal(ui.requests.length, 0); assert.equal(ui.node('case-detail').hidden, true);
    assert.equal(ui.node('case-status').textContent.includes(search), false);
  });
}

test('selection invalidates the previous editor synchronously and fences writes during loading', async () => {
  const ui = await fixture(); ui.choose(); ui.click('erase-start');
  const changing = ui.select(b);
  assert.equal(ui.node('case-detail').hidden, true); assert.equal(ui.node('review-save').disabled, true);
  assert.equal(ui.node('review-note').value, ''); assert.equal(ui.node('erase-confirmation').hidden, true);
  await ui.click('review-save'); await ui.click('erase-confirm');
  assert.equal(ui.requests.length, 1);
  ui.take(`${prefix}/cases/${b}`).respond(detail(b, 2)); await changing;
  assert.equal(ui.node('review-note').disabled, false); assert.equal(ui.node('review-save').disabled, true);
  ui.choose(); const saving = ui.click('review-save'); const request = ui.take(`${prefix}/cases/${b}/decisions`, 'POST');
  assert.equal(request.body.expectedVersion, 2); request.respond({ error:'case_version_conflict' }, 409); await saving;
});

for (const fail of [false, true]) {
  test(`late detail ${fail ? 'failure' : 'success'} cannot replace the current case or private edits`, async () => {
    const ui = await fixture(); const older = ui.select(b); const request = ui.take(`${prefix}/cases/${b}`);
    const latest = ui.select(a); ui.take(`${prefix}/cases/${a}`).respond(detail(a)); await latest; ui.choose('legitimate', 'Current unsaved note');
    const notice = ui.node('case-status').textContent;
    if (fail) request.reject(new Error('Private upstream failure')); else request.respond(detail(b));
    await older;
    assert.equal(ui.node('case-title').textContent, `Кейс ${a.slice(0, 8)}`); assert.equal(ui.node('review-note').value, 'Current unsaved note');
    assert.equal(ui.node('case-status').textContent, notice); assert.equal(ui.node('review-save').disabled, false);
  });
}

for (const mismatch of [false, true]) {
  test(`${mismatch ? 'mismatched' : 'expired/missing'} detail is explicit and cannot be saved`, async () => {
    const ui = await fixture(); const changing = ui.select(b); const request = ui.take(`${prefix}/cases/${b}`);
    request.respond(mismatch ? detail(a) : { error:'case_not_found' }, mismatch ? 200 : 404); await changing;
    assert.equal(ui.node('case-detail').hidden, true); assert.equal(ui.node('review-save').disabled, true);
    if (!mismatch) assert.match(ui.node('case-status').textContent, /не найден.*истёк/u);
    await ui.click('review-save'); assert.equal(ui.requests.length, 0);
  });
}

test('decision uses exact version/UUID payload, intent header and server-owned principal; duplicate click is blocked', async () => {
  const ui = await fixture(); ui.choose('legitimate', 'Synthetic negative example');
  const saving = ui.click('review-save'); const request = ui.take(`${prefix}/cases/${a}/decisions`, 'POST');
  assert.deepEqual(Object.keys(request.body).sort(), ['decisionId', 'expectedVersion', 'label', 'note']);
  assert.equal(request.body.label, 'legitimate'); assert.equal(request.body.expectedVersion, 1);
  assert.match(request.body.decisionId, /^[\da-f-]{36}$/u);
  assert.equal(request.headers['X-Operator-Intent'], 'moderation-review'); assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.credentials, 'same-origin'); assert.equal(request.cache, 'no-store');
  assert.equal(ui.node('review-save').disabled, true); assert.equal(ui.node('review-note').disabled, true);
  await ui.click('review-save'); assert.equal(ui.requests.length, 0);
  request.respond(decisionResponse(request)); await saving;
  assert.match(ui.node('case-status').textContent, /черновой пример сохранены.*не активированы/u);
  assert.equal(ui.node('review-save').disabled, true);
  ui.take(queuePath).respond({ cases:[cases[1]], total:1 }); await flush();
});

test('insufficient evidence records history only and never claims a draft was created', async () => {
  const ui = await fixture(); ui.choose('insufficient_evidence');
  const saving = ui.click('review-save'); const request = ui.take(`${prefix}/cases/${a}/decisions`, 'POST');
  request.respond(decisionResponse(request)); await saving;
  assert.match(ui.node('case-status').textContent, /в истории.*пример не создан/u);
});

for (const failure of [false, true]) {
  test(`late save ${failure ? 'failure' : 'success'} never changes another case or its notice`, async () => {
    const ui = await fixture(); ui.choose(); const saving = ui.click('review-save'); const request = ui.take(`${prefix}/cases/${a}/decisions`, 'POST');
    const changing = ui.select(b); ui.take(`${prefix}/cases/${b}`).respond(detail(b)); await changing;
    assert.equal(ui.node('review-note').disabled, true);
    const notice = ui.node('case-status').textContent;
    request.respond(failure ? { error:'conflict_private_payload' } : decisionResponse(request), failure ? 409 : 200); await saving;
    assert.equal(ui.node('case-title').textContent, `Кейс ${b.slice(0, 8)}`); assert.equal(ui.node('review-note').value, '');
    assert.equal(ui.node('case-status').textContent, notice); assert.equal(ui.node('review-note').disabled, false); assert.equal(ui.requests.length, 0);
  });
}

test('save completion cannot unlock the next case while its detail is still loading', async () => {
  const ui = await fixture(); ui.choose(); const saving = ui.click('review-save'); const save = ui.take(`${prefix}/cases/${a}/decisions`, 'POST');
  const changing = ui.select(b); const read = ui.take(`${prefix}/cases/${b}`);
  save.respond(decisionResponse(save)); await saving;
  assert.equal(ui.node('case-detail').hidden, true); assert.equal(ui.node('review-note').disabled, true);
  read.respond(detail(b)); await changing; assert.equal(ui.node('review-note').disabled, false);
});

for (const failure of ['network', 'json', 'wrong-receipt', 'server']) {
  test(`ambiguous ${failure} write preserves the same request ID and exact payload on deliberate retry`, async () => {
    const ui = await fixture(); ui.choose(); const saving = ui.click('review-save'); const first = ui.take(`${prefix}/cases/${a}/decisions`, 'POST');
    if (failure === 'network') first.reject(new Error('Private server text'));
    if (failure === 'json') first.invalidJson();
    if (failure === 'wrong-receipt') first.respond({ ...decisionResponse(first), caseId:b });
    if (failure === 'server') first.respond({ error:'internal_private_error' }, 500);
    await saving; assert.match(ui.node('case-status').textContent, /не подтверждён/u); assert.doesNotMatch(ui.node('case-status').textContent, /Private|internal_private/u);
    const retrying = ui.click('review-save'); const retry = ui.take(`${prefix}/cases/${a}/decisions`, 'POST');
    assert.deepEqual(retry.body, first.body); retry.respond(decisionResponse(retry)); await retrying;
  });
}

test('a changed payload gets a new request ID; changing back retries the original ambiguous request', async () => {
  const ui = await fixture(); ui.choose(); const saving = ui.click('review-save'); const first = ui.take(`${prefix}/cases/${a}/decisions`, 'POST'); first.reject(new Error('network')); await saving;
  ui.choose('legitimate', 'Different payload'); const changed = ui.click('review-save'); const second = ui.take(`${prefix}/cases/${a}/decisions`, 'POST');
  assert.notEqual(second.body.decisionId, first.body.decisionId); second.reject(new Error('network')); await changed;
  ui.choose(); const retrying = ui.click('review-save'); const retry = ui.take(`${prefix}/cases/${a}/decisions`, 'POST');
  assert.deepEqual(retry.body, first.body); retry.respond({ error:'conflict' }, 409); await retrying;
});

test('stale version rejects decision and deletion until explicit refresh', async () => {
  const ui = await fixture(); ui.choose(); const saving = ui.click('review-save'); ui.take(`${prefix}/cases/${a}/decisions`, 'POST').respond({ error:'stale' }, 409); await saving;
  assert.match(ui.node('case-status').textContent, /Обновите кейс/u);
  assert.equal(ui.node('review-save').disabled, true); assert.equal(ui.node('erase-start').disabled, true);
  ui.click('erase-start'); await ui.click('erase-confirm'); assert.equal(ui.requests.length, 0);
});

test('private case erasure requires two explicit steps, exact version/UUID and no Telegram payload', async () => {
  const ui = await fixture(); await ui.click('erase-confirm'); assert.equal(ui.requests.length, 0);
  ui.click('erase-start'); assert.equal(ui.requests.length, 0); assert.equal(ui.node('erase-confirmation').hidden, false);
  assert.match(ui.node('erase-explanation').textContent, new RegExp(a)); assert.match(ui.node('erase-explanation').textContent, /версия 1/u);
  assert.match(ui.node('erase-explanation').textContent, /Telegram не затрагивается/u); assert.match(ui.node('erase-explanation').textContent, /Физическое удаление.*не гарантируется/u);
  const erasing = ui.click('erase-confirm'); const request = ui.take(`${prefix}/cases/${a}/erase`, 'POST');
  assert.deepEqual(Object.keys(request.body).sort(), ['expectedVersion', 'requestId']); assert.equal(request.body.expectedVersion, 1);
  await ui.click('erase-confirm'); assert.equal(ui.requests.length, 0);
  request.respond(eraseResponse(request)); await erasing;
  assert.equal(ui.node('case-detail').hidden, true); assert.equal(ui.node('case-messages').children.length, 0);
  assert.equal(ui.urls.at(-1), '/moderation-v3.html'); assert.match(ui.node('case-status').textContent, /удалены из Review.*Telegram не затронут/u);
});

test('refresh and case changes cancel erase confirmation; stale clicks cannot erase', async () => {
  const ui = await fixture(); ui.click('erase-start'); const changing = ui.select(b); ui.take(`${prefix}/cases/${b}`).respond(detail(b)); await changing;
  await ui.click('erase-confirm'); assert.equal(ui.requests.length, 0);
  ui.click('erase-start'); const refreshing = ui.click('review-refresh'); assert.equal(ui.node('erase-confirmation').hidden, true);
  await ui.click('erase-confirm'); assert.equal(ui.requests.filter((request) => request.method === 'POST').length, 0);
  ui.take(`${prefix}/status`).respond(enabled); await refreshing;
  ui.take(queuePath).respond({ cases, total:2 }); ui.take(`${prefix}/cases/${b}`).respond(detail(b, 2)); await flush();
  await ui.click('erase-confirm'); assert.equal(ui.requests.length, 0); assert.equal(ui.node('erase-confirmation').hidden, true);
});

test('ambiguous erasure needs a new confirmation but reuses its exact request ID', async () => {
  const ui = await fixture(); ui.click('erase-start'); const erasing = ui.click('erase-confirm'); const first = ui.take(`${prefix}/cases/${a}/erase`, 'POST');
  first.reject(new Error('network')); await erasing; assert.equal(ui.node('case-detail').hidden, false);
  await ui.click('erase-confirm'); assert.equal(ui.requests.length, 0);
  ui.click('erase-start'); const retrying = ui.click('erase-confirm'); const retry = ui.take(`${prefix}/cases/${a}/erase`, 'POST');
  assert.deepEqual(retry.body, first.body); retry.respond(eraseResponse(retry)); await retrying;
});

test('late erasure receipt cannot remove the newly selected case', async () => {
  const ui = await fixture(); ui.click('erase-start'); const erasing = ui.click('erase-confirm'); const request = ui.take(`${prefix}/cases/${a}/erase`, 'POST');
  const changing = ui.select(b); ui.take(`${prefix}/cases/${b}`).respond(detail(b)); await changing;
  request.respond(eraseResponse(request)); await erasing;
  assert.equal(ui.node('case-title').textContent, `Кейс ${b.slice(0, 8)}`); assert.equal(ui.node('case-detail').hidden, false);
  assert.equal(ui.urls.at(-1), `/moderation-v3.html?case=${b}`); assert.equal(ui.requests.length, 0);
});

test('hostile text/labels are textContent only; context truncation is explicit and no hostile target becomes a link', async () => {
  const ui = await fixture(); const hostile = '<img src=x onerror=alert(1)> javascript:alert(2)';
  const selecting = ui.select(a); ui.take(`${prefix}/cases/${a}`).respond(detail(a, 1, {
    messages:[{ messageId:hostile, revision:1, text:hostile, context:{ text:hostile }, truncated:{ text:true, context:true } }],
    reasons:[hostile], detectorVersion:hostile, decisions:[{ label:'__proto__', note:hostile, principal:hostile }],
  })); await selecting;
  assert.ok(allText(ui.node('case-messages')).includes(hostile)); assert.match(allText(ui.node('case-messages')), /с сокращением/u);
  assert.match(allText(ui.node('case-decisions')), /Неизвестное решение/u); assert.ok(allText(ui.node('case-decisions')).includes(hostile));
  assert.equal(descendants(ui.node('case-detail')).some((node) => node.tag === 'a' || node.tag === 'img'), false);
  ui.choose(hostile, hostile); await ui.click('review-save'); assert.equal(ui.requests.length, 0);
  assert.equal(ui.node('review-status').textContent.includes(hostile), false); assert.equal(ui.node('case-status').textContent.includes(hostile), false);
});

test('patterns and history are immutable read-only records, with safe links only to opaque case IDs', async () => {
  const ui = await fixture(); const opening = ui.click('tab-patterns');
  ui.take(`${prefix}/patterns?limit=30&offset=0`).respond({ patterns:[
    { caseId:a, revision:1, label:'hidden_advertising', note:'Synthetic positive', principal:'operator', state:'draft', patternIds:['synthetic'] },
    { caseId:b, revision:1, label:'legitimate', note:'Synthetic negative', principal:'operator', state:'draft', patternIds:[] },
    { caseId:'javascript:alert(1)', revision:2, label:'__proto__', note:'<script>bad</script>', principal:'operator', state:'active' },
  ], total:3 }); await opening;
  assert.match(allText(ui.node('patterns-list')), /Скрытая реклама/u); assert.match(allText(ui.node('patterns-list')), /Допустимый комментарий/u);
  assert.match(allText(ui.node('patterns-list')), /не активирован/u);
  assert.equal(descendants(ui.node('patterns-list')).filter((node) => node.tag === 'button').length, 2);
  assert.equal(descendants(ui.node('patterns-list')).some((node) => node.tag === 'input' || node.tag === 'textarea' || node.tag === 'a'), false);
  const history = ui.click('tab-history'); ui.take(`${prefix}/history?limit=30&offset=0`).respond({ history:[{ caseId:a, evidenceVersion:1, label:'insufficient_evidence', note:'Synthetic incomplete context', principal:'operator' }], total:1 }); await history;
  assert.match(allText(ui.node('history-list')), /Недостаточно данных/u); assert.equal(ui.requests.length, 0);
});

test('known detector reasons and pattern seeds have Russian descriptions, including repeated standard replies', async () => {
  const ui = await fixture(); const selecting = ui.select(a);
  ui.take(`${prefix}/cases/${a}`).respond(detail(a, 1, { patternIds:['repeated-standard-reply'], reasons:['repeated_long_standard_reply', 'original_context_missing'] })); await selecting;
  const reasons = ui.node('case-reasons'); const primary = reasons.children.filter((node) => node.tag !== 'details').map(allText).join('\n');
  assert.match(primary, /Длинный одинаковый ответ/u); assert.match(primary, /Повторяющийся шаблонный ответ/u); assert.match(primary, /Контекст исходного сообщения отсутствует/u);
  assert.doesNotMatch(primary, /repeated_long|repeated-standard|original_context/u);
  const technical = reasons.children.find((node) => node.tag === 'details'); assert.match(allText(technical), /repeated_long_standard_reply/u);
});

test('out-of-order list and status responses cannot replace current records or re-enable disabled service', async () => {
  const ui = await fixture(); const first = ui.click('tab-patterns'); const old = ui.take(`${prefix}/patterns?limit=30&offset=0`);
  const second = ui.click('patterns-refresh'); ui.take(`${prefix}/patterns?limit=30&offset=0`).respond({ patterns:[], total:0 }); await second;
  const notice = ui.node('patterns-status').textContent;
  old.respond({ patterns:[{ caseId:a, label:'legitimate', note:'Late private text' }], total:1 }); await first;
  assert.equal(ui.node('patterns-list').children.length, 0); assert.equal(ui.node('patterns-status').textContent, notice);
  const refresh1 = ui.click('review-refresh'); const status1 = ui.take(`${prefix}/status`);
  const refresh2 = ui.click('review-refresh'); ui.take(`${prefix}/status`).respond({ decisionsEnabled:false }); await refresh2;
  status1.respond(enabled); await refresh1;
  assert.match(ui.node('review-status').textContent, /отключена/u); assert.equal(ui.node('review-note').disabled, true); assert.equal(ui.requests.length, 0);
});

test('existing model/rules/stats remain available in the fourth section even when review is disabled', async () => {
  const ui = await fixture({ status:{ decisionsEnabled:false } }); const opening = ui.click('tab-reference');
  ui.take('/api/moderation/mode').respond({ mode:'shadow', model:'synthetic-model' });
  ui.take('/api/moderation/stats').respond({ totalEvents:0, byVerdict:{ clean:0, suspect:0, ban:0 }, tokens:{ input:0, output:0 } });
  ui.take('/api/moderation/events?limit=100').respond([]);
  ui.take('/api/moderation/prompts?platform=telegram').respond({ active:'policy-v2', versions:['policy-v2'], activeText:'Synthetic reference rules' }); await opening;
  assert.equal(ui.node('panel-reference').hidden, false); assert.equal(ui.node('mode').textContent, 'Наблюдение');
  assert.equal(ui.node('prompt-text').value, 'Synthetic reference rules'); assert.equal(ui.node('events-total').textContent, '0');
});
