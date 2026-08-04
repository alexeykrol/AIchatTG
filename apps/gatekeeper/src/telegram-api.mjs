export class TelegramApiError extends Error {
  constructor(message, { method, status = null, ambiguous = false } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.method = method;
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

export class TelegramApi {
  constructor({ botToken, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async call(method, payload) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new TelegramApiError(`${method} delivery outcome is unknown: ${error.message}`, {
        method,
        ambiguous: true,
      });
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new TelegramApiError(`${method} returned a non-JSON response`, {
        method,
        status: response.status,
        ambiguous: response.status >= 500,
      });
    }
    if (!response.ok || !data.ok) {
      throw new TelegramApiError(`${method} failed: ${data.description || `HTTP ${response.status}`}`, {
        method,
        status: response.status,
        ambiguous: response.status >= 500,
      });
    }
    return data.result;
  }

  sendMessage(payload) {
    return this.call('sendMessage', payload);
  }

  answerCallbackQuery(payload) {
    return this.call('answerCallbackQuery', payload);
  }

  setWebhook(payload) {
    return this.call('setWebhook', payload);
  }

  deleteWebhook(payload = {}) {
    return this.call('deleteWebhook', payload);
  }
}
