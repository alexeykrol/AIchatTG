// Minimal Telegram Bot API client. Errors distinguish a definite failure
// (Telegram answered "no") from an ambiguous one (outcome unknown: network
// failure, timeout, 5xx) so callers never misreport an unknown outcome.

export class TelegramApiError extends Error {
  constructor(message, { method, status = null, ambiguous = false } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.method = method;
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

export function isAmbiguousTelegramError(error) {
  return !(error instanceof TelegramApiError) || error.ambiguous === true;
}

// Definite answer "there is no such join request / the user is already in" —
// a normal outcome of approveChatJoinRequest for a user who never requested.
const NO_REQUEST_RE = /HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT|request.{0,20}not found|join request|USER_NOT_FOUND|user not found/i;
export function isNoRequestError(error) {
  return !isAmbiguousTelegramError(error) && error.status === 400 && NO_REQUEST_RE.test(error.message);
}

// Definite errors that mean "this bot cannot do this at all" (wrong token,
// not an admin, missing right, rate limited) — a batch must stop on them.
const AUTH_RE = /unauthorized|forbidden|not enough rights|CHAT_ADMIN_REQUIRED|need administrator|not an administrator|bot is not a member|too many requests/i;
export function isAuthOrRateError(error) {
  if (isAmbiguousTelegramError(error)) return false;
  return [401, 403, 429].includes(error.status) || AUTH_RE.test(error.message);
}

// Permissions used for probation (contract v2 §2): restrict = all false,
// lift = all true.
export const PERMISSION_KEYS = Object.freeze([
  'can_send_messages', 'can_send_audios', 'can_send_documents', 'can_send_photos', 'can_send_videos',
  'can_send_video_notes', 'can_send_voice_notes', 'can_send_polls', 'can_send_other_messages',
  'can_add_web_page_previews', 'can_change_info', 'can_invite_users', 'can_pin_messages', 'can_manage_topics',
]);
export function permissions(value) {
  return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, value]));
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
      throw new TelegramApiError(`${method} outcome is unknown: ${error.message}`, { method, ambiguous: true });
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

  approveChatJoinRequest(payload) {
    return this.call('approveChatJoinRequest', payload);
  }

  declineChatJoinRequest(payload) {
    return this.call('declineChatJoinRequest', payload);
  }

  // Chat-member actions (contract v2 §2/§4): need can_restrict_members.
  restrictChatMember(payload) {
    return this.call('restrictChatMember', payload);
  }

  banChatMember(payload) {
    return this.call('banChatMember', payload);
  }

  unbanChatMember(payload) {
    return this.call('unbanChatMember', payload);
  }

  // Multi-select topics: toggling re-renders the keyboard of the same message.
  editMessageReplyMarkup(payload) {
    return this.call('editMessageReplyMarkup', payload);
  }

  getUserProfilePhotos(payload) {
    return this.call('getUserProfilePhotos', payload);
  }

  // Read-only (allowed in shadow mode): ChatFullInfo of the applicant, used
  // best-effort for `personal_chat` (a channel attached to the profile).
  getChat(payload) {
    return this.call('getChat', payload);
  }

  setWebhook(payload) {
    return this.call('setWebhook', payload);
  }
}
