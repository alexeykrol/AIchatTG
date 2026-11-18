import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SCENARIO_PATH, validateScenario } from '../src/scenario.mjs';
import { JoinGatekeeperService } from '../src/service.mjs';
import { JoinStore } from '../src/store.mjs';
import { TelegramApiError } from '../src/telegram-api.mjs';

export const CHAT_ID = -1001234567890;
export const OTHER_CHAT_ID = -1009999999999;
export const T0 = Date.parse('2026-11-15T10:00:00.000Z');
export const TOKEN = '123456:TEST_token-not-real';
export const SECRET = 'test_webhook_secret_0123456789';

export function rawScenario() {
  return JSON.parse(fs.readFileSync(DEFAULT_SCENARIO_PATH, 'utf8'));
}

export function scenario(edit = () => {}) {
  const raw = rawScenario();
  edit(raw);
  return validateScenario(raw);
}

export function definiteError(method = 'sendMessage') {
  return new TelegramApiError(`${method} failed: Forbidden: bot can't initiate conversation`, { method, status: 403 });
}

export function ambiguousError(method = 'sendMessage') {
  return new TelegramApiError(`${method} outcome is unknown: timeout`, { method, ambiguous: true });
}

export const READ_METHODS = new Set(['getUserProfilePhotos', 'getChat']);

export function memoryLogger() {
  const lines = [];
  const log = (level) => (event, data = {}) => { lines.push({ level, event, ...data }); };
  return { lines, info: log('info'), warn: log('warn'), error: log('error') };
}

export class FakeTelegram {
  constructor() {
    this.calls = [];
    this.failures = {};
    this.photoCount = 3;
    // getChat(user) result; set personal_chat to simulate a profile channel.
    this.chatInfo = { type: 'private' };
  }

  failNext(method, error) {
    (this.failures[method] ||= []).push(error);
  }

  async record(method, payload, result) {
    this.calls.push({ method, payload });
    const queue = this.failures[method];
    if (queue && queue.length) throw queue.shift();
    return result;
  }

  sendMessage(payload) { return this.record('sendMessage', payload, { message_id: this.calls.length }); }
  answerCallbackQuery(payload) { return this.record('answerCallbackQuery', payload, true); }
  approveChatJoinRequest(payload) { return this.record('approveChatJoinRequest', payload, true); }
  declineChatJoinRequest(payload) { return this.record('declineChatJoinRequest', payload, true); }
  restrictChatMember(payload) { return this.record('restrictChatMember', payload, true); }
  banChatMember(payload) { return this.record('banChatMember', payload, true); }
  unbanChatMember(payload) { return this.record('unbanChatMember', payload, true); }
  editMessageReplyMarkup(payload) { return this.record('editMessageReplyMarkup', payload, true); }
  editMessageText(payload) { return this.record('editMessageText', payload, true); }

  // Texts the user sees, in order: new messages and edited ones.
  shownTexts() {
    return this.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.payload.text);
  }
  getUserProfilePhotos(payload) { return this.record('getUserProfilePhotos', payload, { total_count: this.photoCount, photos: [] }); }
  getChat(payload) { return this.record('getChat', payload, { id: payload.chat_id, ...this.chatInfo }); }
  setWebhook(payload) { return this.record('setWebhook', payload, true); }

  byMethod(method) { return this.calls.filter((call) => call.method === method); }
  writes() { return this.calls.filter((call) => !READ_METHODS.has(call.method)); }
}

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'join-gatekeeper-test-'));
}

export function noRequestError(method = 'approveChatJoinRequest') {
  return new TelegramApiError(`${method} failed: Bad Request: HIDE_REQUESTER_MISSING`, { method, status: 400 });
}

export function authError(method = 'declineChatJoinRequest') {
  return new TelegramApiError(`${method} failed: Bad Request: not enough rights`, { method, status: 400 });
}

export function harness({
  mode = 'enforce', scenarioEdit, targetChatIds = [String(CHAT_ID)], groupLink = '', logger,
} = {}) {
  const dir = tempDir();
  const store = new JoinStore(path.join(dir, 'join-gatekeeper.sqlite'));
  const telegram = new FakeTelegram();
  const clock = { now: T0 };
  const sc = scenario(scenarioEdit);
  const config = { mode, targetChatIds, webhookSecret: SECRET, scenario: sc, groupLink };
  const service = new JoinGatekeeperService({
    config, store, telegram, scenario: sc, now: () => clock.now, ...(logger ? { logger } : {}),
  });
  let updateId = 1000;
  const h = {
    dir, store, telegram, clock, service, scenario: sc, config,
    nextUpdateId: () => ++updateId,
    close() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    joinRequest({ user = {}, chatId = CHAT_ID, bio, userChatId } = {}) {
      const from = { id: 555001, is_bot: false, first_name: 'Мария', last_name: 'Петрова', username: 'maria_p', ...user };
      return service.handleUpdate({
        update_id: h.nextUpdateId(),
        chat_join_request: {
          chat: { id: chatId, type: 'supergroup', title: 'Group' },
          from,
          user_chat_id: userChatId === undefined ? from.id : userChatId,
          date: Math.floor(clock.now / 1000),
          ...(bio === undefined ? {} : { bio }),
        },
      });
    },
    say(text, { userId = 555001, chatType = 'private', chatId } = {}) {
      return service.handleUpdate({
        update_id: h.nextUpdateId(),
        message: {
          message_id: h.nextUpdateId(),
          chat: { id: chatId ?? (chatType === 'private' ? userId : CHAT_ID), type: chatType },
          from: { id: userId, is_bot: false, first_name: 'Мария' },
          date: Math.floor(clock.now / 1000),
          text,
        },
      });
    },
    press(questionId, optionId, { userId = 555001, messageId = 1 } = {}) {
      return service.handleUpdate({
        update_id: h.nextUpdateId(),
        callback_query: {
          id: `cb-${h.nextUpdateId()}`,
          from: { id: userId, is_bot: false, first_name: 'Мария' },
          message: { message_id: messageId, chat: { id: userId, type: 'private' } },
          data: `jg:${questionId}:${optionId}`,
        },
      });
    },
  };
  return h;
}

// Passes the whole questionnaire from Q1 (participate → agree → one topic → done).
export async function passAll(h, { userId = 555001, topic = 'agents' } = {}) {
  await h.press('participate', 'yes', { userId });
  await h.press('rules', 'agree', { userId });
  await h.press('topics', topic, { userId });
  return h.press('topics', 'done', { userId });
}

export function readyScenarioFile(dir) {
  const raw = rawScenario();
  raw.status = 'ready';
  const file = path.join(dir, 'ready-scenario.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return file;
}

export function draftScenarioFile(dir) {
  const raw = rawScenario();
  raw.status = 'draft';
  const file = path.join(dir, 'draft-scenario.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return file;
}

export function baseEnv(dir, overrides = {}) {
  return {
    JOIN_GATEKEEPER_BOT_TOKEN: TOKEN,
    JOIN_GATEKEEPER_TARGET_CHAT_IDS: `${CHAT_ID}`,
    JOIN_GATEKEEPER_WEBHOOK_SECRET: SECRET,
    JOIN_GATEKEEPER_DATA_ROOT: dir,
    ...overrides,
  };
}
