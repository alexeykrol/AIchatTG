import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildAnalyzerUserPayload } from '../src/analyzer-spec.mjs';
import {
  ASSISTANT_DIALOGUE_MAX_SERIALIZED_CHARS,
  ASSISTANT_PROVIDER_INPUT_MAX_CHARS,
  assistantDialogue,
} from '../src/assistant-dialogue.mjs';
import { dialogueRuntime } from './fixtures/dialogue-runtime.mjs';

// A missed injection must fail before any network transport can be used.
globalThis.fetch = async () => { throw new Error('network forbidden in dialogue tests'); };
const fixture = fileURLToPath(new URL('./fixtures/dialogue-runtime.mjs', import.meta.url));
const answer = (question) => `Assistant response: ${question}`;
const pair = (question) => ({ question, answer: answer(question) });
const at = (calls, stage) => calls.filter((call) => call.stage === stage).at(-1)?.input;
function inFolder(body) {
  return async () => {
    const folder = mkdtempSync(join(tmpdir(), 'aichattg-dialogue-wave1-'));
    try { await body(folder); } finally { rmSync(folder, { recursive: true, force: true }); }
  };
}
function child(db, mode, turns) {
  return JSON.parse(execFileSync(process.execPath, [fixture, '--turns', db, JSON.stringify({ mode }), JSON.stringify(turns)], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 20000,
  }).trim().split('\n').at(-1));
}

for (const mode of ['dispatch', 'observe', 'off']) {
  test(`fresh process restores both sides for ${mode} routing, retrieval and answer`, inFolder(async (folder) => {
    const db = join(folder, 'runtime.db');
    const original = 'Я изучаю агента по вечерам, доступно два часа.';
    const correction = 'Поправка: на агента теперь доступно четыре часа.';
    const first = child(db, mode, [{ id: 1, text: original }, { id: 2, text: correction }]);
    assert.deepEqual(first.outcomes.map((outcome) => outcome.kind), ['answered', 'answered']);
    const resumed = child(db, mode, [{ id: 3, text: 'Продолжим с исправленными условиями.' }]);
    assert.equal(resumed.outcomes[0].kind, 'answered');
    const expected = [pair(original), pair(correction)];
    assert.deepEqual(at(resumed.calls, 'answer').dialogue, expected);
    assert.deepEqual(at(resumed.calls, 'retrieval').dialogueTail, { user: correction, assistant: answer(correction) });
    assert.equal(at(resumed.calls, 'retrieval').sessionId, '-100:7');
    if (mode !== 'off') {
      const analysis = at(resumed.calls, 'analysis');
      assert.deepEqual(analysis.dialogue, expected);
      assert.equal(analysis.previous_user_turns, undefined, 'new Q/A input must not mislabel or duplicate assistant words');
    }
    if (mode !== 'dispatch') assert.deepEqual(at(resumed.calls, 'router').dialogue, expected);
    else assert.equal(at(resumed.calls, 'router'), undefined, 'dispatch must not add a second routing call');
  }));
}

test('user, chat and separate runtime storage isolate participant history', inFolder(async (folder) => {
  const rig = dialogueRuntime(join(folder, 'runtime.db'));
  const other = dialogueRuntime(join(folder, 'other-instance.db'));
  try {
    const identities = [{ user: 7, chat: -100 }, { user: 8, chat: -100 }, { user: 7, chat: -200 }];
    for (const [n, identity] of identities.entries()) {
      assert.equal((await rig.ask(n + 10, `Ситуация ${n}`, identity)).kind, 'answered');
      assert.deepEqual(at(rig.calls, 'answer').dialogue, []);
    }
    for (const [n, identity] of identities.entries()) {
      await rig.ask(n + 20, 'Продолжим', identity);
      assert.deepEqual(at(rig.calls, 'analysis').dialogue, [pair(`Ситуация ${n}`)]);
      assert.deepEqual(at(rig.calls, 'answer').dialogue, [pair(`Ситуация ${n}`)]);
    }
    await other.ask(30, 'Независимый участник');
    assert.deepEqual(at(other.calls, 'answer').dialogue, []);
    assert.equal(other.store.recentDialogue('-100', '7').length, 1);
  } finally { rig.close(); other.close(); }
}));

for (const failure of ['answer', 'delivery']) {
  test(`${failure} failure does not invent a completed turn after restart`, inFolder(async (folder) => {
    const db = join(folder, 'runtime.db');
    const rig = dialogueRuntime(db);
    try {
      await rig.ask(40, 'Исходное условие');
      rig.faults[failure] = true;
      assert.notEqual((await rig.ask(41, 'Незавершённая попытка')).kind, 'answered');
      assert.deepEqual(rig.store.recentDialogue('-100', '7'), [pair('Исходное условие')]);
    } finally { rig.close(); }
    const resumed = child(db, 'dispatch', [{ id: 42, text: 'Продолжим после сбоя' }]);
    assert.equal(resumed.outcomes[0].kind, 'answered');
    assert.deepEqual(at(resumed.calls, 'analysis').dialogue, [pair('Исходное условие')]);
    assert.deepEqual(at(resumed.calls, 'answer').dialogue, [pair('Исходное условие')]);
  }));
}

test('one turn snapshot survives a TTL boundary between analysis and answer', inFolder(async (folder) => {
  const rig = dialogueRuntime(join(folder, 'runtime.db'), { ttl: 10 });
  try {
    await rig.ask(50, 'Контекст до паузы');
    rig.clock.now += 1;
    rig.faults.afterAnalysis = () => { rig.clock.now += 11; };
    await rig.ask(51, 'Уточнение');
    assert.deepEqual(at(rig.calls, 'answer').dialogue, [pair('Контекст до паузы')]);
    assert.deepEqual(at(rig.calls, 'retrieval').dialogueTail, { user: 'Контекст до паузы', assistant: answer('Контекст до паузы') });
    rig.faults.afterAnalysis = null;
    await rig.ask(52, 'Следующий ход');
    assert.deepEqual(at(rig.calls, 'answer').dialogue, [pair('Уточнение')], 'existing TTL still applies at the next turn');
  } finally { rig.close(); }
}));

test('configured turn limit is the single retained turn-count cap', inFolder(async (folder) => {
  const rig = dialogueRuntime(join(folder, 'runtime.db'), { turnLimit: 5 });
  try {
    for (let n = 0; n < 5; n += 1) { await rig.ask(60 + n, `Условие ${n}`); rig.clock.now += 1; }
    const snapshot = ['Условие 0', 'Условие 1', 'Условие 2', 'Условие 3'].map(pair);
    assert.deepEqual(at(rig.calls, 'analysis').dialogue, snapshot);
    assert.deepEqual(at(rig.calls, 'answer').dialogue, snapshot);
    assert.equal(rig.store.recentDialogue('-100', '7', { limit: 5 }).length, 5);
    assert.equal(rig.store.listAssistantAnswers().length, 5);
  } finally { rig.close(); }
}));

test('prompt projection keeps the newest complete tail inside the provider input budget', () => {
  const maximal = Array.from({ length: 4 }, (_, index) => ({
    question: `${index}:${'q'.repeat(8_190)}`,
    answer: `${index}:${'a'.repeat(8_190)}`,
  }));
  const projected = assistantDialogue(maximal);
  assert.equal(projected.length, 3);
  assert.equal(projected[0].question.startsWith('1:'), true);
  assert.ok(JSON.stringify(projected).length <= ASSISTANT_DIALOGUE_MAX_SERIALIZED_CHARS);
});

test('analyzer trims dialogue against the complete question and working-state envelope', () => {
  const maximal = Array.from({ length: 4 }, (_, index) => ({
    question: `${index}:${'q'.repeat(8_190)}`,
    answer: `${index}:${'a'.repeat(8_190)}`,
  }));
  const currentTurn = 'x'.repeat(8_192);
  const input = buildAnalyzerUserPayload(
    currentTurn,
    [],
    maximal,
    { summary: 's'.repeat(5_000) },
  );
  const payload = JSON.parse(input);
  assert.ok(input.length <= ASSISTANT_PROVIDER_INPUT_MAX_CHARS);
  assert.ok(payload.dialogue.length < 3, 'analyzer must budget more than the isolated dialogue array');
  assert.equal(payload.dialogue.at(-1).question.startsWith('3:'), true);
  assert.equal(payload.current_turn, currentTurn);
});

test('a large valid retained tail reaches the actual analyzer provider within its input budget', inFolder(async (folder) => {
  const rig = dialogueRuntime(join(folder, 'runtime.db'));
  try {
    for (let n = 0; n < 3; n += 1) {
      assert.equal((await rig.ask(70 + n, `Условие ${n}: ${'a'.repeat(7900)}`)).kind, 'answered');
    }
    assert.equal((await rig.ask(73, 'Продолжим')).kind, 'answered');
    assert.equal(at(rig.calls, 'analysis').current_turn, 'Продолжим');
    assert.equal(at(rig.calls, 'analysis').dialogue.length, 3);
    assert.deepEqual(at(rig.calls, 'analysis').dialogue, at(rig.calls, 'answer').dialogue);
  } finally { rig.close(); }
}));

test('same-second turns retain chronological corrections and the newest window after restart', inFolder(async (folder) => {
  const db = join(folder, 'runtime.db');
  const rig = dialogueRuntime(db);
  const questions = Array.from({ length: 5 }, (_, n) => `Коррекция условия ${n}`);
  try {
    for (const [n, question] of questions.entries()) {
      assert.equal((await rig.ask(80 + n, question)).kind, 'answered');
      assert.deepEqual(at(rig.calls, 'answer').dialogue, questions.slice(Math.max(0, n - 3), n).map(pair));
      // Opaque identifiers deliberately sort opposite to insertion order.
      // This makes the UUID tie-break defect reproducible, not probabilistic.
      rig.db.prepare('UPDATE runtime_assistant_turns SET id = ? WHERE event_id = ?')
        .run(`opaque-${9 - n}`, `assistant:${(80 + n) * 2 + 1}`);
    }
    assert.deepEqual(rig.store.recentDialogue('-100', '7'), questions.slice(-3).map(pair));
  } finally { rig.close(); }
  const resumed = child(db, 'dispatch', [{ id: 90, text: 'Продолжим' }]);
  assert.equal(resumed.outcomes[0].kind, 'answered');
  assert.deepEqual(at(resumed.calls, 'answer').dialogue, questions.slice(-3).map(pair));
  assert.deepEqual(at(resumed.calls, 'analysis').dialogue, questions.slice(-3).map(pair));
}));

test('legacy analyzer callers retain the previousTexts payload contract', () => {
  assert.deepEqual(JSON.parse(buildAnalyzerUserPayload('сейчас', ['раньше', '', 'потом'])), {
    previous_user_turns: ['раньше', 'потом'], current_turn: 'сейчас',
  });
});
