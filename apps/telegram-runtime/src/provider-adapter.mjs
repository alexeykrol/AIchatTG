export class ProviderUnavailableError extends Error {
  constructor(code) {
    super(`AIchatTG provider is unavailable: ${code}`);
    this.name = 'ProviderUnavailableError';
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unavailable(code) {
  return Object.freeze({
    async moderate() { throw new ProviderUnavailableError(code); },
    async routeAssistant() { throw new ProviderUnavailableError(code); },
    async answer() { throw new ProviderUnavailableError(code); },
  });
}

/**
 * Validate only the portable runtime contract. It intentionally does not read
 * process.env, a News config file, or an SDK-specific global configuration.
 */
export function validateProviderRuntimeConfig(config) {
  if (config == null || config.enabled === false) return { valid: false, code: 'provider_disabled' };
  if (!plainObject(config) || config.enabled !== true) {
    return { valid: false, code: 'provider_configuration_invalid' };
  }

  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  let endpoint;
  try { endpoint = new URL(String(config.endpoint || '')); } catch {
    return { valid: false, code: 'provider_configuration_invalid' };
  }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password || !apiKey || !model) {
    return { valid: false, code: 'provider_configuration_invalid' };
  }
  return {
    valid: true,
    config: Object.freeze({
      enabled: true,
      endpoint: endpoint.toString(),
      apiKey,
      model,
    }),
  };
}

export function isProviderUnavailableError(error) {
  return error instanceof ProviderUnavailableError;
}

/**
 * Provider-neutral, demand-only JSON transport. Construction never makes a
 * network request. Tests can inject fetchFn; a disabled or invalid adapter
 * always rejects before invoking it.
 */
export function createProviderAdapter(config, { fetchFn = globalThis.fetch } = {}) {
  const validated = validateProviderRuntimeConfig(config);
  if (!validated.valid) return unavailable(validated.code);
  if (typeof fetchFn !== 'function') return unavailable('provider_transport_unavailable');

  async function invoke(kind, payload) {
    const response = await fetchFn(validated.config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${validated.config.apiKey}`,
      },
      body: JSON.stringify({ kind, model: validated.config.model, input: payload }),
    });
    let result = null;
    try {
      result = typeof response?.json === 'function' ? await response.json() : null;
    } catch {
      result = null;
    }
    if (!response?.ok || !plainObject(result)) {
      throw new Error(`provider request failed with HTTP ${Number(response?.status) || 0}`);
    }
    return result;
  }

  return Object.freeze({
    moderate: (payload) => invoke('moderate', payload),
    routeAssistant: (payload) => invoke('assistant_route', payload),
    answer: (payload) => invoke('answer', payload),
  });
}
