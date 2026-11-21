export const OPENAI_BASE = 'https://api.openai.com/v1';

/** Install only on the answer adapter; other operations keep their original transport. */
export function withAnswerAddendum(fetchFn, addendum) {
  return (url, init) => {
    const body = JSON.parse(init.body);
    const instruction = body.messages.find(({ role }) => role === 'system' || role === 'developer');
    if (typeof instruction?.content !== 'string') throw new Error('answer_instruction_missing');
    instruction.content += `\n\n${addendum}`;
    return fetchFn(url, { ...init, body: JSON.stringify(body) });
  };
}

/** A deterministic Chat Completions transport for mock runs. */
export function fakeOpenAITransport({ calls = [] } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const { question } = JSON.parse(body.messages.find(({ role }) => role === 'user').content);
    const input = Math.floor(Buffer.byteLength(JSON.stringify(body.messages), 'utf8') / 4);
    const output = Math.min(40, body.max_completion_tokens);
    return {
      ok: true, status: 200, headers: { get: (name) => (name === 'x-request-id' ? 'req_mock' : null) },
      json: async () => ({
        id: 'chatcmpl_mock', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `[mock] ответ на вопрос: ${question}` },
          finish_reason: 'stop' }],
        usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
          prompt_tokens_details: { cached_tokens: Math.floor(input / 2) },
          completion_tokens_details: { reasoning_tokens: Math.floor(output / 2) } },
      }),
    };
  };
}
