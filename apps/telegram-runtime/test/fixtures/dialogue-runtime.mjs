// Offline fixture only. All external interfaces are injected; no bootstrap/env.
import { createAnalyzerAdapter } from '../../src/analyzer-adapter.mjs';
import { runtimeAnalyzerSpec } from '../../src/analyzer-spec.mjs';
import { openRuntimeDatabase, createRuntimeStore } from '../../src/database.mjs';
import { createProviderAdapter } from '../../src/provider-adapter.mjs';
import { createTelegramRuntime } from '../../src/runtime.mjs';

globalThis.fetch = async () => { throw new Error('network forbidden in dialogue fixture'); };

export function dialogueRuntime(databasePath, { mode = 'dispatch', turnLimit = 3, ttl = 604800 } = {}) {
  const db = openRuntimeDatabase(databasePath);
  const clock = { now: 1800000000 };
  const store = createRuntimeStore(db, { now: () => clock.now });
  const calls = [];
  const faults = { answer: false, delivery: false, afterAnalysis: null };
  const tuple = (model) => ({ model, reasoningEffort: 'low', maxOutputTokens: 500 });
  const wire = createProviderAdapter({
    enabled: true, vendor: 'openai', endpoint: 'https://fixture.invalid/v1', apiKey: 'offline-fixture',
    modelTuples: {
      moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1024 },
      assistantRouter: tuple('fixture-router'),
      assistantAnswer: tuple('fixture-answer'),
    },
  }, { fetchFn: async (_url, request) => {
    const body = JSON.parse(request.body);
    const input = JSON.parse(body.messages[1].content);
    const stage = input.current_turn ? 'analysis' : body.model === 'fixture-answer' ? 'answer' : 'router';
    calls.push({ stage, input });
    if (stage === 'answer' && faults.answer) throw new Error('offline answer failure');
    const content = stage === 'analysis' ? JSON.stringify({
      topics: ['content'], topics_evidence: input.current_turn, context_dependent: true,
      level: { hypothesis: 'none', confidence: 'low', evidence: '' },
      intent: { kind: 'explicit', confidence: 'high', evidence: '', hidden_premise: null },
    }) : stage === 'router' ? JSON.stringify({ action: 'teach', sourceId: 'course-content-v1' })
      : `Assistant response: ${input.question}`;
    if (stage === 'analysis') faults.afterAnalysis?.();
    return { ok: true, status: 200, async json() {
      return { model: body.model, choices: [{ message: { content } }] };
    } };
  } });
  const config = {
    ingressEnabled: false, moderationMode: 'live', moderationAntichannelPin: true,
    assistantModerationWaitMs: 0, assistantModerationPollMs: 1, assistantKnowledgeEnabled: true,
    assistantDialogueTurnLimit: turnLimit, assistantDialogueTtlSec: ttl,
    assistantCooldownSec: 0, assistantDailyPerUser: 100,
    moderator: { chatIds: ['-100', '-200'], botToken: '', exemptBotIds: [] },
    assistant: { chatIds: ['-100', '-200'], botToken: '', botUsername: 'fixture_bot', exemptBotIds: [] },
  };
  const runtime = createTelegramRuntime({
    config, store,
    provider: { ...wire, async moderate() {
      return { safetyRoute: 'clean', abuseLevel: null, confidence: 0.98, reason: 'fixture', modelId: 'fake' };
    } },
    analyzer: createAnalyzerAdapter({ config: { mode, chatIds: ['-100', '-200'] }, provider: wire, spec: runtimeAnalyzerSpec().spec }),
    contentRetrieval: { available: true, async forQuestion(input) {
      calls.push({ stage: 'retrieval', input: structuredClone(input) });
      return { grounded: true, knowledge: { sourceId: 'course-content-v1', entries: [{ id: 'fixture', content: 'Offline course knowledge.' }] } };
    } },
    guard: { async senderDisposition() { return { proven: true, exempt: false }; } },
    moderatorTelegram: {}, notifier: { async notify() { return { delivered: true }; } },
    assistantTelegram: { async sendMessage(input) {
      if (faults.delivery) throw new Error('offline delivery failure');
      calls.push({ stage: 'delivery', input });
      return { ok: true, data: { message_id: 123 } };
    } },
  });
  return { db, store, clock, calls, faults, runtime, close: () => db.close(),
    async ask(id, text, { chat = -100, user = 7 } = {}) {
      const message = { message_id: id, chat: { id: chat }, from: { id: user, is_bot: false }, text: `/ask ${text}` };
      await runtime.handleUpdate('moderator', { update_id: id * 2, message });
      return runtime.handleUpdate('assistant', { update_id: id * 2 + 1, message });
    },
  };
}

// A separate process opens ONLY the caller-created temporary fixture database.
if (process.argv[2] === '--turns') {
  const rig = dialogueRuntime(process.argv[3], JSON.parse(process.argv[4]));
  try {
    const outcomes = [];
    for (const { id, text, ...identity } of JSON.parse(process.argv[5])) {
      outcomes.push(await rig.ask(id, text, identity));
      rig.clock.now += 1;
    }
    console.log(JSON.stringify({ outcomes, calls: rig.calls }));
  } finally { rig.close(); }
}
