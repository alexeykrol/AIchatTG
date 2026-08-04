export class LlmDisabledError extends Error {
  constructor() {
    super('LLM adapter is disabled; enable it only under an approved provider budget');
    this.name = 'LlmDisabledError';
  }
}

function disabled() {
  return {
    async moderate() { throw new LlmDisabledError(); },
    async routeAssistant() { throw new LlmDisabledError(); },
    async answer() { throw new LlmDisabledError(); },
  };
}

/** A narrow provider-neutral JSON seam. It never performs startup work. */
export function createLlmAdapter(config, { fetchFn = globalThis.fetch } = {}) {
  if (!config.enabled) return disabled();
  if (typeof fetchFn !== 'function') throw new Error('a fetch implementation is required for an enabled LLM adapter');
  async function invoke(kind, payload) {
    const response = await fetchFn(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ kind, model: config.model || null, ...payload }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || typeof result !== 'object') throw new Error(`LLM adapter failed with HTTP ${response.status}`);
    return result;
  }
  return {
    moderate: (payload) => invoke('moderate', payload),
    routeAssistant: (payload) => invoke('assistant_route', payload),
    answer: (payload) => invoke('answer', payload),
  };
}
