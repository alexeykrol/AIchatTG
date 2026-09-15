import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/domains-v3.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/u)[1];
const domains = [
  { id: 'assistant-self', title: 'Assistant', knowledgeFile: 'assistant-self.md' },
  { id: 'abuse', title: 'Abuse', knowledgeFile: 'abuse.md' },
  { id: 'content', title: 'Content', knowledgeFile: null, sourceKind: 'retrieval' },
];

function detail(id) {
  return {
    ...domains.find((domain) => domain.id === id),
    releasedText: `# ${id}\nReleased knowledge for ${id}.`, candidateText: null,
    sourceDigest: 'a'.repeat(64), baseDigest: 'a'.repeat(64),
    editingEnabled: true, stale: false,
  };
}

function element() {
  return {
    value: '', textContent: '', hidden: false, disabled: false, children: [], listeners: {},
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
    addEventListener(type, listener) { this.listeners[type] = listener; },
  };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function fixture() {
  const nodes = new Map(), requests = [];
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
  };
  // Run the real inline browser script. Deferred fetches control response order;
  // this test neither opens a browser/network connection nor writes candidates.
  const context = vm.createContext({
    document,
    fetch(path, options = {}) {
      return new Promise((resolve, reject) => {
        requests.push({
          path, method: options.method || 'GET', body: options.body && JSON.parse(options.body),
          respond(data, status = 200) { resolve({ ok: status < 400, status, json: async () => data }); },
          reject,
        });
      });
    },
  });
  vm.runInContext(script, context);
  requests.shift().respond({ domains });
  await flush();
  requests.shift().respond(detail('assistant-self'));
  await flush();
  return {
    requests, node: (id) => document.getElementById(id),
    select(id) {
      const index = domains.findIndex((domain) => domain.id === id);
      return document.getElementById('list').children[index].listeners.click();
    },
    save() { return document.getElementById('save').listeners.click(); },
  };
}

test('switching domains invalidates the old editor before fetch resolves and blocks mismatched saves', async () => {
  const ui = await fixture();
  ui.node('candidate').value = '# Assistant\nOnly for the assistant domain.';
  const switching = ui.select('abuse');
  assert.equal(ui.node('editor').hidden, true);
  assert.equal(ui.node('save').disabled, true);
  assert.equal(ui.node('candidate').disabled, true);
  assert.equal(ui.node('reset').disabled, true);
  await ui.save();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].method, 'GET');
  ui.requests.shift().respond(detail('abuse'));
  await switching;
  ui.node('candidate').value = '# Abuse\nOnly for the abuse domain.';
  const saving = ui.save();
  const request = ui.requests.shift();
  assert.equal(request.path, '/api/operator/domains/abuse/candidates');
  assert.equal(request.body.text, '# Abuse\nOnly for the abuse domain.');
  request.respond({ error: 'candidate_stale' }, 409);
  await saving;
});

test('late domain responses cannot replace the current selection or editor', async () => {
  const ui = await fixture();
  const first = ui.select('abuse');
  const oldRequest = ui.requests.shift();
  const second = ui.select('assistant-self');
  ui.requests.shift().respond(detail('assistant-self'));
  await second;
  ui.node('candidate').value = '# Assistant\nUnsaved local text.';
  oldRequest.respond(detail('abuse'));
  await first;
  assert.equal(ui.node('title').textContent, 'Assistant');
  assert.equal(ui.node('candidate').value, '# Assistant\nUnsaved local text.');
  assert.equal(ui.node('save').disabled, false);
});

test('a late failed response cannot hide the current editor or replace its notice', async () => {
  const ui = await fixture();
  const first = ui.select('abuse');
  const oldRequest = ui.requests.shift();
  const second = ui.select('assistant-self');
  ui.requests.shift().respond(detail('assistant-self'));
  await second;
  const notice = ui.node('notice').textContent;
  oldRequest.reject(new Error('late network error'));
  await first;
  assert.equal(ui.node('editor').hidden, false);
  assert.equal(ui.node('notice').textContent, notice);
});

test('selecting a non-Markdown domain prevents a pending response from reopening its editor', async () => {
  const ui = await fixture();
  const first = ui.select('abuse');
  const oldRequest = ui.requests.shift();
  await ui.select('content');
  oldRequest.respond(detail('abuse'));
  await first;
  assert.equal(ui.node('editor').hidden, true);
  assert.equal(ui.node('save').disabled, true);
  await ui.save();
  assert.equal(ui.requests.length, 0);
});

for (const success of [true, false]) {
  test(`selection during an in-flight save stays intact after ${success ? 'success' : 'failure'}`, async () => {
    const ui = await fixture();
    ui.node('candidate').value = '# Assistant\nCaptured assistant draft.';
    const saving = ui.save();
    const saveRequest = ui.requests.shift();
    assert.equal(saveRequest.path, '/api/operator/domains/assistant-self/candidates');
    assert.equal(saveRequest.body.text, '# Assistant\nCaptured assistant draft.');
    await ui.save();
    assert.equal(ui.requests.length, 0, 'a second save cannot start while one is pending');
    const switching = ui.select('abuse');
    ui.requests.shift().respond(detail('abuse'));
    await switching;
    assert.equal(ui.node('save').disabled, true);
    const notice = ui.node('notice').textContent;
    saveRequest.respond(success ? { runtimeApplied: false } : { error: 'candidate_stale' }, success ? 201 : 409);
    await saving;
    assert.equal(ui.node('title').textContent, 'Abuse');
    assert.equal(ui.node('candidate').value, detail('abuse').releasedText);
    assert.equal(ui.node('notice').textContent, notice);
    assert.equal(ui.node('save').disabled, false);
    assert.equal(ui.requests.length, 0, 'save completion cannot reload a different selection');
  });
}

test('a save completion cannot unlock an editor whose new selection is still loading', async () => {
  const ui = await fixture();
  const saving = ui.save();
  const saveRequest = ui.requests.shift();
  const switching = ui.select('abuse');
  const readRequest = ui.requests.shift();
  saveRequest.respond({ runtimeApplied: false }, 201);
  await saving;
  assert.equal(ui.node('editor').hidden, true);
  assert.equal(ui.node('save').disabled, true);
  readRequest.respond(detail('abuse'));
  await switching;
  assert.equal(ui.node('save').disabled, false);
});

test('a successful save reloads only its domain and ignores that reload after a new selection', async () => {
  const ui = await fixture();
  const saving = ui.save();
  ui.requests.shift().respond({ runtimeApplied: false }, 201);
  await flush();
  const reload = ui.requests.shift();
  assert.equal(reload.path, '/api/operator/domains/assistant-self');
  const switching = ui.select('abuse');
  ui.requests.shift().respond(detail('abuse'));
  await switching;
  const notice = ui.node('notice').textContent;
  reload.respond(detail('assistant-self'));
  await saving;
  assert.equal(ui.node('title').textContent, 'Abuse');
  assert.equal(ui.node('notice').textContent, notice);
  assert.equal(ui.node('save').disabled, false);
});

test('an API response for the wrong domain is rejected and cannot be saved', async () => {
  const ui = await fixture();
  const switching = ui.select('abuse');
  ui.requests.shift().respond(detail('assistant-self'));
  await switching;
  assert.equal(ui.node('editor').hidden, true);
  assert.equal(ui.node('save').disabled, true);
  await ui.save();
  assert.equal(ui.requests.length, 0);
});
