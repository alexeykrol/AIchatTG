function disabledResult() { return { ok: false, skipped: 'telegram_transport_disabled' }; }

/**
 * Telegram I/O is demand-only. This module deliberately exposes neither polling
 * nor command/webhook registration methods, so constructing it cannot cut over a bot.
 */
export function createTelegramAdapter({ botToken = '', fetchFn = globalThis.fetch } = {}) {
  if (!botToken) {
    return {
      async sendMessage() { return disabledResult(); }, async banMember() { return disabledResult(); },
      async banSenderChat() { return disabledResult(); }, async deleteMessage() { return disabledResult(); },
      async unpinMessage() { return disabledResult(); },
      async getChatMember() { return disabledResult(); },
    };
  }
  if (typeof fetchFn !== 'function') throw new Error('Telegram adapter requires fetch');
  async function call(method, body) {
    const response = await fetchFn(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return response.ok && data.ok !== false ? { ok: true, data: data.result } : { ok: false, error: data.description || `http_${response.status}` };
  }
  return {
    sendMessage: ({ chatId, text, replyToMessageId }) => call('sendMessage', { chat_id: chatId, text, reply_to_message_id: replyToMessageId }),
    banMember: ({ chatId, userId }) => call('banChatMember', { chat_id: chatId, user_id: userId }),
    banSenderChat: ({ chatId, senderChatId }) => call('banChatSenderChat', { chat_id: chatId, sender_chat_id: senderChatId }),
    deleteMessage: ({ chatId, messageId }) => call('deleteMessage', { chat_id: chatId, message_id: messageId }),
    unpinMessage: ({ chatId, messageId }) => call('unpinChatMessage', { chat_id: chatId, message_id: messageId }),
    getChatMember: ({ chatId, userId }) => call('getChatMember', { chat_id: chatId, user_id: userId }),
  };
}
