import {
  isMarkupParseError,
  plainTextFromMarkdown,
  splitForTelegram,
  TELEGRAM_MESSAGE_LIMIT,
  telegramHtmlFromMarkdown,
} from '@aichattg/telegram-core';

function disabledResult() { return { ok: false, skipped: 'telegram_transport_disabled' }; }

export const TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Telegram I/O is demand-only. This module deliberately exposes neither polling
 * nor command/webhook registration methods, so constructing it cannot cut over a bot.
 */
export function createTelegramAdapter({
  botToken = '',
  fetchFn = globalThis.fetch,
  requestTimeoutMs = TELEGRAM_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!botToken) {
    return {
      async sendMessage() { return disabledResult(); }, async banMember() { return disabledResult(); },
      async banSenderChat() { return disabledResult(); }, async deleteMessage() { return disabledResult(); },
      async unpinMessage() { return disabledResult(); },
      async getChatMember() { return disabledResult(); },
    };
  }
  if (typeof fetchFn !== 'function') throw new Error('Telegram adapter requires fetch');
  const timeoutMs = Number(requestTimeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error('Telegram adapter requestTimeoutMs must be an integer between 100 and 120000');
  }
  async function call(method, body) {
    const response = await fetchFn(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      // A timed-out Telegram mutation is deliberately ambiguous: the adapter
      // never retries it, and the runtime keeps the delivery fence in place.
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Headers alone do not prove a Telegram mutation receipt. In particular,
    // the deadline may fire while the response body is still being read. A
    // missing/malformed body is therefore an ambiguous transport failure, not
    // a synthetic success derived from HTTP 200.
    const data = await response.json();
    return response.ok && data.ok !== false ? { ok: true, data: data.result } : { ok: false, error: data.description || `http_${response.status}` };
  }
  /**
   * Ответ модели написан в markdown, а Telegram его не разбирает без
   * `parse_mode` — до этой правки читатель видел `**жирный**` и `###` буквально.
   *
   * Три правила, каждое закрывает свой класс ошибки:
   * 1. Длинный ответ РЕЖЕТСЯ до отправки. Telegram отвергает сообщение длиннее
   *    лимита целиком, то есть длинный ответ не «обрезался» — он не доходил.
   * 2. Отказ по разбору разметки лечится ОДНОЙ повторной отправкой плоским
   *    текстом. Это не ретрай доставки: при таком отказе (400) сообщение не
   *    доставлено по определению, задвоить ответ нечем. Любая другая ошибка
   *    повтору не подлежит — она либо не лечится снятием разметки, либо
   *    неоднозначна по факту доставки.
   * 3. Первая часть отвечает реплаем на вопрос, остальные — простыми
   *    сообщениями: цепочка реплаев на собственные сообщения читается как спам.
   * Квитанция берётся у ПЕРВОЙ части: именно её id — ответ на вопрос.
   */
  async function sendRendered({ chatId, text, replyToMessageId, markup = true, forceReply = false, footer = '' }) {
    if (typeof footer !== 'string' || footer.length > 256 || /[\r\n]/u.test(footer)) {
      throw new Error('Telegram footer must be one line of at most 256 characters');
    }
    const suffix = footer ? `\n\n${footer}` : '';
    // Reserve the complete footer before splitting, then append it AFTER
    // Markdown rendering. Neither version/date nor Markdown fences can split it.
    const parts = splitForTelegram(text, { limit: TELEGRAM_MESSAGE_LIMIT - suffix.length - (footer ? 2 : 0) });
    // A hard UTF-16 split must not divide an emoji. Two reserved code units
    // above leave room when moving the high surrogate into the next part.
    if (footer) for (let i = 0; i < parts.length - 1; i++) {
      if (/[\uD800-\uDBFF]$/u.test(parts[i]) && /^[\uDC00-\uDFFF]/u.test(parts[i + 1])) {
        parts[i + 1] = parts[i].slice(-1) + parts[i + 1];
        parts[i] = parts[i].slice(0, -1);
      }
    }
    if (!parts.length) return { ok: false, error: 'empty_message' };
    let first = null;
    for (const [index, part] of parts.entries()) {
      const replyTo = index === 0 ? replyToMessageId : undefined;
      const tail = index === parts.length - 1 ? suffix : '';
      const htmlTail = tail.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      let result = await call('sendMessage', {
        chat_id: chatId,
        text: markup ? telegramHtmlFromMarkdown(part) + htmlTail : part + tail,
        ...(markup ? { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } : {}),
        reply_to_message_id: replyTo,
        ...(!markup && forceReply && index === 0 ? { reply_markup: { force_reply: true, selective: true } } : {}),
      });
      if (markup && !result.ok && isMarkupParseError(result.error)) {
        result = await call('sendMessage', {
          chat_id: chatId,
          text: plainTextFromMarkdown(part) + tail,
          reply_to_message_id: replyTo,
          link_preview_options: { is_disabled: true },
        });
        if (result.ok) result = { ...result, degraded: 'markup_stripped' };
      }
      // Часть не ушла — дальше не шлём: рваный ответ хуже короткого, а первая
      // неудача уже говорит вызывающему всё, что ему нужно знать.
      if (!result.ok) return index === 0 ? result : { ...first, partial: true, error: result.error };
      if (index === 0) first = result;
      if (result.degraded) first = { ...first, degraded: result.degraded };
    }
    return first;
  }

  return {
    // `forceReply` opens the reply compose box for the addressed user in
    // Telegram's client, so their very next message becomes a genuine reply
    // — the same channel `detectAssistantQuestion`'s `reason: 'reply'` path
    // recognises. `selective: true` shows the prompt only to the user being
    // replied to, not the whole chat. Used only on the plain (non-markup)
    // path: a rendered model answer never needs it.
    sendMessage: ({ chatId, text, replyToMessageId, markup = false, forceReply = false, footer = '' }) => (
      markup === true || footer !== ''
        ? sendRendered({ chatId, text, replyToMessageId, markup, forceReply, footer })
        : call('sendMessage', {
          chat_id: chatId, text, reply_to_message_id: replyToMessageId,
          ...(forceReply ? { reply_markup: { force_reply: true, selective: true } } : {}),
        })
    ),
    banMember: ({ chatId, userId }) => call('banChatMember', { chat_id: chatId, user_id: userId }),
    banSenderChat: ({ chatId, senderChatId }) => call('banChatSenderChat', { chat_id: chatId, sender_chat_id: senderChatId }),
    deleteMessage: ({ chatId, messageId }) => call('deleteMessage', { chat_id: chatId, message_id: messageId }),
    unpinMessage: ({ chatId, messageId }) => call('unpinChatMessage', { chat_id: chatId, message_id: messageId }),
    getChatMember: ({ chatId, userId }) => call('getChatMember', { chat_id: chatId, user_id: userId }),
  };
}
