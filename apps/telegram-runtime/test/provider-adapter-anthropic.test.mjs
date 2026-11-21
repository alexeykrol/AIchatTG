import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadRuntimeConfig } from '../src/config.mjs';
import {
  ANSWER_DISCIPLINE_RULES,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_ENDPOINT,
  ANTHROPIC_ENDPOINT_ALLOWLIST,
  answerSystemPrompt,
  anthropicRequestFor,
  createProviderAdapter,
  providerCallUsage,
  ProviderRequestError,
  ProviderUnavailableError,
  validateProviderRuntimeConfig,
} from '../src/provider-adapter.mjs';

const SECRET = 'sk-ant-fixture-secret-never-logged';
const OPENAI_KEY = 'openai-fixture-key';

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    vendor: 'openai',
    endpoint: 'https://provider.example.test/v1',
    apiKey: OPENAI_KEY,
    modelTuples: {
      moderatorSafety: { model: 'gpt-5.6-terra', reasoningEffort: 'medium', maxOutputTokens: 1024 },
      assistantRouter: { model: 'router-model', reasoningEffort: 'none', maxOutputTokens: 100 },
      assistantAnswer: { model: 'claude-sonnet-5-5', reasoningEffort: 'low', maxOutputTokens: 2000 },
    },
    ...overrides,
  };
}

function anthropicConfig(overrides = {}) {
  return baseConfig({ answerVendor: 'anthropic', anthropicApiKey: SECRET, ...overrides });
}

function answerPayload() {
  return {
    text: 'Что говорит урок?', chatId: '-100-private', userId: '77',
    route: { action: 'teach', sourceId: 'course-content-v1' },
    dialogue: [{ question: 'Earlier question', answer: 'Earlier answer' }],
    knowledge: { sourceId: 'course-content-v1', entries: [{ id: 'lesson-1', content: 'Approved content.' }] },
  };
}

function messagesBody({ text = 'Ответ.', usage = { input_tokens: 100, output_tokens: 40 }, model = 'claude-sonnet-5-5' } = {}) {
  return {
    id: 'msg_fixture', type: 'message', role: 'assistant', model, stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text }],
    ...(usage === null ? {} : { usage }),
  };
}

function response(body, { ok = true, status = 200, headers = { 'request-id': 'req_ant_fixture' } } = {}) {
  return {
    ok, status,
    headers: { get(name) { return headers[String(name).toLowerCase()] ?? null; } },
    async json() { return body; },
  };
}

function chatCompletion(content) {
  return {
    model: 'router-model', choices: [{ finish_reason: 'stop', message: { content, refusal: null } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

test('answer vendor validation matrix', () => {
  const absent = validateProviderRuntimeConfig(baseConfig());
  assert.equal(absent.valid, true);
  assert.equal(Object.hasOwn(absent.config, 'answerVendor'), false);
  assert.equal(Object.hasOwn(absent.config, 'anthropicApiKey'), false);
  // Explicit openai and empty string are the same as absent: byte-identical config.
  for (const answerVendor of ['openai', '', null, undefined]) {
    assert.deepEqual(validateProviderRuntimeConfig(baseConfig({ answerVendor })).config, absent.config);
  }
  const ok = validateProviderRuntimeConfig(anthropicConfig());
  assert.equal(ok.valid, true);
  assert.equal(ok.config.answerVendor, 'anthropic');
  assert.equal(ok.config.anthropicEndpoint, ANTHROPIC_DEFAULT_ENDPOINT);
  assert.equal(ok.config.vendor, 'openai');
  assert.equal(validateProviderRuntimeConfig(anthropicConfig({ anthropicEndpoint: 'https://api.anthropic.com/v1' }))
    .config.anthropicEndpoint, 'https://api.anthropic.com/v1/');
  for (const [overrides, code] of [
    [{ answerVendor: 'google' }, 'provider_answer_vendor_invalid'],
    [{ answerVendor: 'Anthropic' }, 'provider_answer_vendor_invalid'],
    [{ answerVendor: 42 }, 'provider_answer_vendor_invalid'],
    [{ anthropicApiKey: '' }, 'provider_anthropic_api_key_invalid'],
    [{ anthropicApiKey: undefined }, 'provider_anthropic_api_key_invalid'],
    [{ anthropicApiKey: 'line\nbreak' }, 'provider_anthropic_api_key_invalid'],
    [{ anthropicEndpoint: 'http://api.anthropic.com/v1/' }, 'provider_anthropic_endpoint_invalid'],
    [{ anthropicEndpoint: 'https://api.anthropic.com/v2/' }, 'provider_anthropic_endpoint_invalid'],
    [{ anthropicEndpoint: 'https://127.0.0.1/v1/' }, 'provider_anthropic_endpoint_invalid'],
  ]) assert.equal(validateProviderRuntimeConfig(anthropicConfig(overrides)).code, code, JSON.stringify(overrides));
  for (const effort of ['none', 'minimal']) {
    const config = anthropicConfig();
    config.modelTuples.assistantAnswer = { ...config.modelTuples.assistantAnswer, reasoningEffort: effort };
    assert.equal(validateProviderRuntimeConfig(config).code, 'provider_answer_effort_invalid');
  }
  // The global vendor and safety tuple stay OpenAI-only.
  assert.equal(validateProviderRuntimeConfig(anthropicConfig({ vendor: 'anthropic' })).code, 'provider_vendor_invalid');
});

test('loadRuntimeConfig reads the answer vendor env and fails startup on a bad Anthropic setting', () => {
  const env = {
    TELEGRAM_RUNTIME_PROVIDER_ENABLED: 'true', TELEGRAM_RUNTIME_PROVIDER_VENDOR: 'openai',
    TELEGRAM_RUNTIME_PROVIDER_ENDPOINT: 'https://provider.example.test/v1/',
    TELEGRAM_RUNTIME_PROVIDER_API_KEY: OPENAI_KEY,
    TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_MODEL: 'gpt-5.6-terra',
    TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_REASONING_EFFORT: 'medium',
    TELEGRAM_RUNTIME_PROVIDER_MODERATOR_SAFETY_MAX_OUTPUT_TOKENS: '1024',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MODEL: 'router-model',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_REASONING_EFFORT: 'low',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MAX_OUTPUT_TOKENS: '256',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MODEL: 'claude-sonnet-5-5',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_REASONING_EFFORT: 'low',
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MAX_OUTPUT_TOKENS: '2000',
  };
  const cwd = '/tmp/aichattg-anthropic-test';
  const openaiOnly = loadRuntimeConfig(env, { cwd }).provider;
  assert.equal(Object.hasOwn(openaiOnly, 'answerVendor'), false);
  // An Anthropic key alone does not switch anything.
  assert.deepEqual(loadRuntimeConfig({ ...env, TELEGRAM_RUNTIME_ANTHROPIC_API_KEY: SECRET }, { cwd }).provider, openaiOnly);
  const switched = loadRuntimeConfig({ ...env,
    TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_VENDOR: 'anthropic', TELEGRAM_RUNTIME_ANTHROPIC_API_KEY: SECRET }, { cwd }).provider;
  assert.equal(switched.answerVendor, 'anthropic');
  assert.equal(switched.anthropicEndpoint, 'https://api.anthropic.com/v1/');
  assert.equal(switched.anthropicApiKey, SECRET);
  assert.throws(() => loadRuntimeConfig({ ...env, TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_VENDOR: 'anthropic' }, { cwd }),
    /provider_anthropic_api_key_invalid/);
  assert.throws(() => loadRuntimeConfig({ ...env, TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_VENDOR: 'mistral' }, { cwd }),
    /provider_answer_vendor_invalid/);
  assert.throws(() => loadRuntimeConfig({ ...env, TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_VENDOR: 'anthropic',
    TELEGRAM_RUNTIME_ANTHROPIC_API_KEY: SECRET, TELEGRAM_RUNTIME_ANTHROPIC_ENDPOINT: 'http://insecure.example/v1/' }, { cwd }),
  /provider_anthropic_endpoint_invalid/);
  // A startup error never echoes the key.
  try {
    loadRuntimeConfig({ ...env, TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_VENDOR: 'anthropic',
      TELEGRAM_RUNTIME_ANTHROPIC_API_KEY: SECRET, TELEGRAM_RUNTIME_ANTHROPIC_ENDPOINT: 'nope' }, { cwd });
    assert.fail('must throw');
  } catch (error) { assert.equal(String(error.message).includes(SECRET), false); }
});

test('anthropic answer request mapping: endpoint, headers, system, effort, max_tokens', async () => {
  const calls = [];
  const adapter = createProviderAdapter(anthropicConfig(), {
    async fetchFn(url, init) { calls.push({ url, init }); return response(messagesBody()); },
  });
  const payload = answerPayload();
  const answered = await adapter.answer(payload);
  assert.equal(answered.text, 'Ответ.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  const { headers } = calls[0].init;
  assert.equal(headers['x-api-key'], SECRET);
  assert.equal(headers['anthropic-version'], ANTHROPIC_API_VERSION);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(Object.hasOwn(headers, 'authorization'), false);
  assert.ok(calls[0].init.signal);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body), ['model', 'max_tokens', 'system', 'messages', 'output_config']);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.max_tokens, 2000);
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.system, answerSystemPrompt(payload));
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(JSON.parse(body.messages[0].content).question, payload.text);
  assert.equal(calls[0].init.body.includes(SECRET), false);
  assert.equal(calls[0].init.body.includes(OPENAI_KEY), false);
  assert.deepEqual(anthropicRequestFor({ tuple: { model: 'm', reasoningEffort: 'high' }, system: 's', input: 'i', maxOutputTokens: 9 }),
    { model: 'm', max_tokens: 9, system: 's', messages: [{ role: 'user', content: 'i' }], output_config: { effort: 'high' } });
});

test('anthropic response and usage map into the shared receipt contract', async () => {
  const adapter = createProviderAdapter(anthropicConfig(), {
    async fetchFn() {
      return response(messagesBody({ text: 'Часть 1. ', usage: {
        input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 30, cache_creation_input_tokens: 5,
      } }));
    },
  });
  const answered = await adapter.answer(answerPayload());
  assert.equal(answered.modelId, 'claude-sonnet-5-5');
  assert.deepEqual({ ...answered.receipt }, {
    vendor: 'anthropic', operation: 'assistantAnswer', modelId: 'claude-sonnet-5-5', configuredModelId: 'claude-sonnet-5-5',
    reasoningEffort: 'low', httpStatus: 200, requestId: 'req_ant_fixture',
    inputTokens: 135, outputTokens: 40, totalTokens: 175, cacheReadInputTokens: 30, cacheCreationInputTokens: 5,
    costUsd: null, retryCount: 0, stopReason: 'end_turn', incomplete: false,
  });
  assert.deepEqual({ ...providerCallUsage(answered.receipt) },
    { modelId: 'claude-sonnet-5-5', inputTokens: 135, outputTokens: 40, totalTokens: 175 });

  const multi = createProviderAdapter(anthropicConfig(), {
    async fetchFn() {
      return response({ ...messagesBody(), content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] });
    },
  });
  assert.equal((await multi.answer(answerPayload())).text, 'AB');

  const noUsage = createProviderAdapter(anthropicConfig(), { async fetchFn() { return response(messagesBody({ usage: null })); } });
  const unmeasured = await noUsage.answer(answerPayload());
  assert.equal(unmeasured.receipt.inputTokens, null);
  assert.equal(unmeasured.receipt.totalTokens, null);
});

test('anthropic errors are classified like the OpenAI path and never leak the key', async () => {
  const cases = [
    [async () => { throw new Error(`socket closed ${SECRET}`); }, 'provider_transport_failed', null],
    [async () => response({ type: 'error', error: { type: 'authentication_error' } }, { ok: false, status: 401 }), 'provider_http_error', 401],
    [async () => response({ type: 'error', error: { type: 'permission_error' } }, { ok: false, status: 403 }), 'provider_http_error', 403],
    [async () => response({ type: 'error', error: { type: 'rate_limit_error' } }, { ok: false, status: 429 }), 'provider_http_error', 429],
    [async () => response({ type: 'error', error: { type: 'api_error' } }, { ok: false, status: 500 }), 'provider_http_error', 500],
    [async () => response({ type: 'error', error: { type: 'overloaded_error' } }, { ok: false, status: 529 }), 'provider_http_error', 529],
    [async () => response({ model: 'claude-sonnet-5-5', content: 'not-an-array', usage: { input_tokens: 1, output_tokens: 1 } }), 'provider_response_invalid', 200],
    [async () => response({ ...messagesBody(), content: [{ type: 'thinking', thinking: 'x' }] }), 'provider_response_invalid', 200],
    [async () => response(messagesBody({ usage: { input_tokens: -1, output_tokens: 3 } })), 'provider_response_invalid', null],
    [async () => ({ ok: true, status: 200, headers: { get: () => null }, async json() { throw new Error('bad json'); } }), 'provider_response_invalid', null],
  ];
  for (const [fetchFn, code, status] of cases) {
    let calls = 0;
    const adapter = createProviderAdapter(anthropicConfig(), { async fetchFn(...args) { calls++; return fetchFn(...args); } });
    await assert.rejects(adapter.answer(answerPayload()), (error) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.code, code);
      assert.equal(error.retryable, false);
      if (status != null) assert.equal(error.receipt?.httpStatus, status);
      assert.equal(JSON.stringify({ message: error.message, receipt: error.receipt }).includes(SECRET), false);
      return true;
    });
    assert.equal(calls, 1, `${code}: exactly one attempt, no automatic retry`);
  }
});

test('router, moderator safety and analyzer stay on OpenAI when the answer vendor is anthropic', async () => {
  const openaiCalls = [];
  const anthropicCalls = [];
  const fetchFn = async (url, init) => {
    if (url.startsWith('https://api.anthropic.com/')) { anthropicCalls.push({ url, init }); return response(messagesBody()); }
    openaiCalls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    return response(chatCompletion(JSON.stringify({ action: 'teach', sourceId: 'course-content-v1' })));
  };
  const plainAdapter = createProviderAdapter(baseConfig(), { fetchFn });
  const adapter = createProviderAdapter(anthropicConfig(), { fetchFn });
  assert.notEqual(adapter.configurationFingerprint, plainAdapter.configurationFingerprint);

  await plainAdapter.routeAssistant({ text: 'Как открыть курс?' });
  await adapter.routeAssistant({ text: 'Как открыть курс?' });
  assert.equal(anthropicCalls.length, 0);
  assert.equal(openaiCalls.length, 2);
  // Byte-for-byte the same router request with and without the answer switch.
  assert.deepEqual(openaiCalls[1], openaiCalls[0]);
  assert.equal(openaiCalls[1].url, 'https://provider.example.test/v1/chat/completions');
  assert.equal(openaiCalls[1].init.headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(openaiCalls[1].init.redirect, 'error', 'a keyed OpenAI request never follows a redirect');

  await adapter.analyze({ system: 'analyzer system', input: 'analyzer input' });
  assert.equal(anthropicCalls.length, 0);
  assert.equal(openaiCalls.at(-1).url, 'https://provider.example.test/v1/chat/completions');
  assert.equal(JSON.stringify(openaiCalls).includes(SECRET), false);

  // Moderation goes to the OpenAI endpoint (its response is irrelevant here).
  await adapter.moderate({ text: 'обычное сообщение' }).catch(() => {});
  assert.equal(anthropicCalls.length, 0);
  assert.equal(openaiCalls.at(-1).url, 'https://provider.example.test/v1/chat/completions');
  assert.equal(openaiCalls.at(-1).init.body.model, 'gpt-5.6-terra');

  await adapter.answer(answerPayload());
  assert.equal(anthropicCalls.length, 1);
});

test('the OpenAI answer path is unchanged when no answer vendor is configured', async () => {
  const requests = [];
  const adapter = createProviderAdapter(baseConfig({ modelTuples: { ...baseConfig().modelTuples,
    assistantAnswer: { model: 'answer-model', reasoningEffort: 'low', maxOutputTokens: 500 } } }), {
    async fetchFn(url, init) { requests.push({ url, body: JSON.parse(init.body) }); return response(chatCompletion('ok')); },
  });
  const answered = await adapter.answer(answerPayload());
  assert.equal(answered.receipt.vendor, 'openai');
  assert.equal(requests[0].url, 'https://provider.example.test/v1/chat/completions');
  assert.equal(Object.hasOwn(answered.receipt, 'cacheReadInputTokens'), false);
  assert.equal(requests[0].body.messages[0].content, answerSystemPrompt(answerPayload()));
});

test('answer discipline v2-cited is the verbatim tail of every answer system prompt', () => {
  const addendum = readFileSync(new URL('../../../scripts/eval/addenda/answer-discipline-v2-cited.md', import.meta.url), 'utf8')
    .replace(/\s+$/, '');
  assert.equal(ANSWER_DISCIPLINE_RULES, addendum);
  const prompts = [
    answerSystemPrompt(null),
    answerSystemPrompt(answerPayload()),
    answerSystemPrompt({ knowledge: { sourceId: 'course-operations-v1', entries: [] } }),
    answerSystemPrompt({ text: 'Погода?', dialogue: [], route: { action: 'redirect', sourceId: null },
      knowledge: null, knowledgeGap: 'off_domain', domainRoutes: [], domainCoverage: [], riskFlags: [] }),
  ];
  for (const prompt of prompts) {
    assert.ok(prompt.endsWith(`\n\n${ANSWER_DISCIPLINE_RULES}`));
    assert.match(prompt, /Никогда не отвечай отказом/u);
  }
});

test('an invalid anthropic answer configuration makes the whole adapter unavailable before any call', async () => {
  let calls = 0;
  const adapter = createProviderAdapter(anthropicConfig({ anthropicApiKey: '' }), { async fetchFn() { calls++; } });
  await assert.rejects(adapter.answer(answerPayload()),
    (error) => error instanceof ProviderUnavailableError && error.code === 'provider_anthropic_api_key_invalid');
  assert.equal(calls, 0);
});

test('configuration fingerprint is unchanged for an OpenAI-only answer route', () => {
  const config = validateProviderRuntimeConfig(baseConfig({ requestTimeoutMs: 45_000 })).config;
  const legacy = createHash('sha256').update(JSON.stringify({
    vendor: config.vendor, endpoint: config.endpoint, requestTimeoutMs: config.requestTimeoutMs,
    modelTuples: config.modelTuples,
  })).digest('hex');
  for (const answerVendor of [undefined, 'openai']) {
    const adapter = createProviderAdapter(baseConfig({ requestTimeoutMs: 45_000, answerVendor, anthropicApiKey: SECRET }),
      { fetchFn: async () => {} });
    assert.equal(adapter.configurationFingerprint, legacy);
  }
});

test('anthropic max_tokens truncation is an incomplete answer, never a finished one', async () => {
  for (const [stopReason, expected] of [['max_tokens', 'max_tokens'], ['refusal', 'refusal'], [undefined, 'missing'],
    ['pause_turn', 'pause_turn'], ['model_context_window_exceeded', 'model_context_window_exceeded']]) {
    const body = { ...messagesBody({ text: 'Обрезанный, но непустой ответ' }), stop_reason: stopReason };
    if (stopReason === undefined) delete body.stop_reason;
    const adapter = createProviderAdapter(anthropicConfig(), { async fetchFn() { return response(body); } });
    await assert.rejects(adapter.answer(answerPayload()), (error) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.code, 'provider_response_incomplete');
      assert.equal(error.receipt.stopReason, expected);
      assert.equal(error.receipt.incomplete, true);
      assert.equal(error.receipt.outputTokens, 40, 'the paid usage stays on the receipt');
      return true;
    });
  }
  const stopSequence = createProviderAdapter(anthropicConfig(), {
    async fetchFn() { return response({ ...messagesBody(), stop_reason: 'stop_sequence' }); },
  });
  const done = await stopSequence.answer(answerPayload());
  assert.equal(done.receipt.stopReason, 'stop_sequence');
  assert.equal(done.receipt.incomplete, false);
});

test('anthropic endpoint must be on the allowlist and keyed requests never follow redirects', async () => {
  assert.deepEqual([...ANTHROPIC_ENDPOINT_ALLOWLIST], ['https://api.anthropic.com/v1/']);
  for (const anthropicEndpoint of ['https://evil.example.com/v1/', 'https://api.anthropic.com.evil.test/v1/',
    'https://proxy.anthropic.example/v1/']) {
    assert.equal(validateProviderRuntimeConfig(anthropicConfig({ anthropicEndpoint })).code,
      'provider_anthropic_endpoint_invalid', anthropicEndpoint);
  }
  const inits = [];
  const adapter = createProviderAdapter(anthropicConfig(), {
    async fetchFn(url, init) { inits.push([url, init]); return response(messagesBody()); },
  });
  await adapter.answer(answerPayload());
  assert.equal(inits[0][0], 'https://api.anthropic.com/v1/messages');
  assert.equal(inits[0][1].redirect, 'error');
});
