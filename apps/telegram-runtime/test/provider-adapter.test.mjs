import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRuntimeConfig } from '../src/config.mjs';
import {
  createProviderAdapter,
  ProviderRequestError,
  ProviderUnavailableError,
  validateProviderRuntimeConfig,
} from '../src/provider-adapter.mjs';

function providerConfig(overrides = {}) {
  return {
    enabled: true,
    vendor: 'openai-compatible',
    endpoint: 'https://provider.example.test/v1',
    apiKey: 'fixture-key',
    modelTuples: {
      moderatorSafety: { model: 'moderator-model', reasoningEffort: 'minimal', maxOutputTokens: 200 },
      assistantRouter: { model: 'router-model', reasoningEffort: 'none', maxOutputTokens: 100 },
      assistantAnswer: { model: 'answer-model', reasoningEffort: 'low', maxOutputTokens: 500 },
    },
    ...overrides,
  };
}

function completion(content, { model = 'returned-model', usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } } = {}) {
  return {
    model,
    choices: [{ message: { content } }],
    usage,
  };
}

function response(body, { ok = true, status = 200, requestId = 'req_fixture' } = {}) {
  return {
    ok,
    status,
    headers: { get(name) { return name === 'x-request-id' ? requestId : null; } },
    async json() { return body; },
  };
}

function answerPayload() {
  return {
    text: 'What does the approved snapshot say?',
    chatId: '-100-private',
    userId: '77',
    route: { action: 'teach', sourceId: 'course-content-v1' },
    dialogue: [{ question: 'Earlier question', answer: 'Earlier answer' }],
    knowledge: { sourceId: 'course-content-v1', entries: [{ id: 'lesson-1', content: 'Approved content.' }] },
  };
}

test('disabled and malformed providers fail before fake fetch', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; throw new Error('must not call'); };
  const disabled = createProviderAdapter({ enabled: false }, { fetchFn });
  const invalid = createProviderAdapter(providerConfig({ vendor: 'anthropic' }), { fetchFn });
  for (const operation of [disabled.moderate, disabled.routeAssistant, disabled.answer]) {
    await assert.rejects(operation({}), (error) => error instanceof ProviderUnavailableError && error.code === 'provider_disabled');
  }
  await assert.rejects(invalid.moderate({ text: 'fixture' }), (error) => error instanceof ProviderUnavailableError && error.code === 'provider_vendor_invalid');
  assert.equal(calls, 0);
});

test('validation accepts only the configured OpenAI-compatible HTTPS /v1 contract and all tuples', () => {
  assert.equal(validateProviderRuntimeConfig(providerConfig()).valid, true);
  for (const [field, value, code] of [
    ['vendor', 'openai', 'provider_vendor_invalid'],
    ['endpoint', 'http://provider.example.test/v1', 'provider_endpoint_invalid'],
    ['endpoint', 'https://provider.example.test/v1?key=bad', 'provider_endpoint_invalid'],
    ['endpoint', 'https://localhost/v1', 'provider_endpoint_invalid'],
    ['endpoint', 'https://provider.example.test/not-v1', 'provider_endpoint_invalid'],
    ['apiKey', 'line\nbreak', 'provider_api_key_invalid'],
  ]) {
    assert.equal(validateProviderRuntimeConfig(providerConfig({ [field]: value })).code, code);
  }
  const missingTuple = providerConfig();
  delete missingTuple.modelTuples.assistantAnswer;
  assert.equal(validateProviderRuntimeConfig(missingTuple).code, 'provider_model_tuples_invalid');
  assert.equal(validateProviderRuntimeConfig(providerConfig({ modelTuples: {
    ...providerConfig().modelTuples,
    assistantRouter: { model: 'router-model', reasoningEffort: 'medium', maxOutputTokens: 0 },
  } })).code, 'provider_model_tuples_invalid');
});

test('loadRuntimeConfig keeps the disabled default and normalizes three explicit runtime tuples', () => {
  const disabled = loadRuntimeConfig({}, { cwd: '/tmp/aichattg-provider-test' });
  assert.equal(disabled.provider.enabled, false);
  assert.throws(() => loadRuntimeConfig({
    TELEGRAM_RUNTIME_PROVIDER_ENABLED: 'true',
    TELEGRAM_RUNTIME_PROVIDER_MODEL: 'legacy-model',
  }, { cwd: '/tmp/aichattg-provider-test' }), /provider_vendor_invalid/);
  const loaded = loadRuntimeConfig({
    TELEGRAM_RUNTIME_PROVIDER_ENABLED: 'true',
    TELEGRAM_RUNTIME_PROVIDER_VENDOR: 'openai-compatible',
    TELEGRAM_RUNTIME_PROVIDER_ENDPOINT: 'https://provider.example.test/v1/',
    TELEGRAM_RUNTIME_PROVIDER_API_KEY: 'fixture-key',
    TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_MODEL: 'moderator-model',
    TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_REASONING_EFFORT: 'minimal',
    TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_MAX_OUTPUT_TOKENS: '200',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MODEL: 'router-model',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_REASONING_EFFORT: 'none',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MAX_OUTPUT_TOKENS: '100',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MODEL: 'answer-model',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_REASONING_EFFORT: 'low',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MAX_OUTPUT_TOKENS: '500',
  }, { cwd: '/tmp/aichattg-provider-test' });
  assert.equal(loaded.provider.endpoint, 'https://provider.example.test/v1/');
  assert.deepEqual(loaded.provider.modelTuples.assistantRouter, {
    model: 'router-model', reasoningEffort: 'none', maxOutputTokens: 100,
  });
});

test('moderation uses its tuple once, normalizes JSON and returns a content-free receipt', async () => {
  const calls = [];
  const adapter = createProviderAdapter(providerConfig(), {
    async fetchFn(url, init) {
      calls.push({ url, init });
      return response(completion(JSON.stringify({
        safetyRoute: 'abuse', abuseLevel: 'weak', confidence: 0.91, reason: 'policy', quote: 'fixture message', modelId: 'ignored-by-adapter',
      }), { model: 'moderator-returned' }));
    },
  });
  const result = await adapter.moderate({ text: 'fixture message', chatId: 'never-sent' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://provider.example.test/v1/chat/completions');
  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.model, 'moderator-model');
  assert.equal(request.max_completion_tokens, 200);
  assert.equal(request.reasoning_effort, 'minimal');
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.deepEqual(JSON.parse(request.messages[1].content), { message: 'fixture message' });
  assert.equal(result.modelId, 'moderator-returned');
  assert.deepEqual(result.receipt, {
    vendor: 'openai-compatible', operation: 'moderatorSafety', modelId: 'moderator-returned', configuredModelId: 'moderator-model',
    reasoningEffort: 'minimal', httpStatus: 200, requestId: 'req_fixture', inputTokens: 11, outputTokens: 7, totalTokens: 18,
    costUsd: null, retryCount: 0,
  });
  assert.equal(JSON.stringify(result.receipt).includes('fixture message'), false);
  assert.equal(JSON.stringify(result.receipt).includes('policy'), false);
});

test('router and answer use their own tuples without field fallback or identity leakage', async () => {
  const requests = [];
  const responses = [
    response(completion(JSON.stringify({ action: 'support', sourceId: 'course-operations-v1' }), { model: 'router-returned' })),
    response(completion('Answer only from approved knowledge.', { model: 'answer-returned' })),
  ];
  const adapter = createProviderAdapter(providerConfig(), {
    async fetchFn(url, init) { requests.push({ url, body: JSON.parse(init.body) }); return responses.shift(); },
  });
  const route = await adapter.routeAssistant({ text: 'How do I open the course?', courseOperationsHint: true, chatId: 'not-sent' });
  const answer = await adapter.answer(answerPayload());
  assert.deepEqual({ action: route.action, sourceId: route.sourceId, modelId: route.modelId }, {
    action: 'support', sourceId: 'course-operations-v1', modelId: 'router-returned',
  });
  assert.equal(answer.text, 'Answer only from approved knowledge.');
  assert.equal(answer.modelId, 'answer-returned');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.model, 'router-model');
  assert.equal(Object.hasOwn(requests[0].body, 'reasoning_effort'), false);
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
  assert.equal(requests[1].body.model, 'answer-model');
  assert.equal(requests[1].body.reasoning_effort, 'low');
  assert.equal(Object.hasOwn(requests[1].body, 'response_format'), false);
  assert.equal(requests[1].body.messages[1].content.includes('not-sent'), false);
  assert.equal(JSON.stringify(answer.receipt).includes('Approved content.'), false);
});

test('invalid outgoing input, HTTP failures and malformed responses never retry or expose content in receipts', async () => {
  let calls = 0;
  const adapter = createProviderAdapter(providerConfig(), {
    async fetchFn() {
      calls++;
      return response({ error: { message: 'private provider detail' }, usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 } }, { ok: false, status: 429 });
    },
  });
  await assert.rejects(adapter.answer({}), (error) => error instanceof ProviderRequestError && error.code === 'provider_request_invalid');
  assert.equal(calls, 0);
  await assert.rejects(adapter.moderate({ text: 'fixture message' }), (error) => {
    assert.equal(error.code, 'provider_http_error');
    assert.equal(error.retryable, false);
    assert.equal(JSON.stringify(error.receipt).includes('private provider detail'), false);
    return true;
  });
  assert.equal(calls, 1);
  const malformed = createProviderAdapter(providerConfig(), { async fetchFn() { calls++; return response(completion('not JSON')); } });
  await assert.rejects(malformed.routeAssistant({ text: 'fixture', courseOperationsHint: false }), (error) => error.code === 'provider_response_invalid');
  assert.equal(calls, 2);
});

test('transport errors have no automatic retry', async () => {
  let calls = 0;
  const adapter = createProviderAdapter(providerConfig(), { async fetchFn() { calls++; throw new Error('network detail'); } });
  await assert.rejects(adapter.moderate({ text: 'fixture' }), (error) => error instanceof ProviderRequestError
    && error.code === 'provider_transport_failed' && error.retryable === false);
  assert.equal(calls, 1);
});
