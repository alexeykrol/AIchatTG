import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256 } from './security.mjs';

const SUBSCRIPTION_PERIODS = new Set([
  'onetime',
  'weekly',
  'monthly',
  'quarterly',
  'halfyearly',
  'yearly',
]);
const SUBSCRIPTION_TYPES = new Set(['regular', 'gift', 'trial']);

function validationError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function requiredString(value, field, { max = 512 } = {}) {
  if (typeof value !== 'string') throw validationError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw validationError(`${field} must contain 1-${max} characters`);
  }
  return normalized;
}

function safeInteger(value, field, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw validationError(`${field} must be a safe integer greater than or equal to ${min}`);
  }
  return value;
}

function timestamp(value, field) {
  const source = requiredString(value, field, { max: 64 });
  const milliseconds = Date.parse(source);
  if (!Number.isFinite(milliseconds)) throw validationError(`${field} must be an ISO date-time`);
  return new Date(milliseconds).toISOString();
}

function telegramUsername(value) {
  if (value == null || value === '') return '';
  const username = requiredString(value, 'payload.telegram_username', { max: 32 }).replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    throw validationError('payload.telegram_username must be a valid Telegram username');
  }
  return username;
}

export function signTributeWebhook(apiKey, rawBody) {
  return createHmac('sha256', apiKey).update(rawBody).digest('hex');
}

export function verifyTributeWebhook({ apiKey, rawBody, signature }) {
  const match = /^(?:sha256=)?([a-f0-9]{64})$/i.exec(String(signature || '').trim());
  if (!match) return false;
  const expected = Buffer.from(signTributeWebhook(apiKey, rawBody), 'hex');
  const received = Buffer.from(match[1], 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function mapTributeNewSubscription(
  event,
  { tributeSubscriptionIds, tributeChannelId = '', targetChatId },
) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw validationError('Tribute webhook body must be an object');
  }
  const eventName = requiredString(event.name, 'name', { max: 64 });
  if (eventName !== 'new_subscription') return { ignored: 'unsupported_event' };
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw validationError('payload must be an object');
  }

  const subscriptionId = safeInteger(payload.subscription_id, 'payload.subscription_id', { min: 1 });
  const allowedSubscriptions = new Set(tributeSubscriptionIds.map(String));
  if (!allowedSubscriptions.has(String(subscriptionId))) {
    return { ignored: 'subscription_not_allowlisted' };
  }

  const channelId = safeInteger(payload.channel_id, 'payload.channel_id', { min: 1 });
  if (tributeChannelId && String(channelId) !== String(tributeChannelId)) {
    return { ignored: 'channel_not_allowlisted' };
  }

  const currency = requiredString(payload.currency, 'payload.currency', { max: 8 }).toUpperCase();
  if (currency !== 'RUB') return { ignored: 'non_rub_currency' };

  let subscriptionType = '';
  if (payload.type != null && payload.type !== '') {
    subscriptionType = requiredString(payload.type, 'payload.type', { max: 16 });
    if (!SUBSCRIPTION_TYPES.has(subscriptionType)) throw validationError('payload.type is not supported');
    if (subscriptionType === 'trial') return { ignored: 'trial_subscription' };
  }
  if (payload.period === 'trial') return { ignored: 'trial_subscription' };

  const price = safeInteger(payload.price, 'payload.price');
  if (price === 0) return { ignored: 'non_positive_price' };

  const createdAt = timestamp(event.created_at, 'created_at');
  timestamp(event.sent_at, 'sent_at');
  requiredString(payload.subscription_name, 'payload.subscription_name');
  const periodId = safeInteger(payload.period_id, 'payload.period_id', { min: 1 });
  const period = requiredString(payload.period, 'payload.period', { max: 32 });
  if (!SUBSCRIPTION_PERIODS.has(period)) throw validationError('payload.period is not supported');
  safeInteger(payload.amount, 'payload.amount');
  safeInteger(payload.user_id, 'payload.user_id');
  requiredString(payload.trb_user_id, 'payload.trb_user_id', { max: 128 });
  const telegramUserId = safeInteger(payload.telegram_user_id, 'payload.telegram_user_id', { min: 1 });
  requiredString(payload.channel_name, 'payload.channel_name');
  const expiresAt = timestamp(payload.expires_at, 'payload.expires_at');

  const username = telegramUsername(payload.telegram_username);
  const stableIdentity = {
    name: 'new_subscription',
    created_at: createdAt,
    payload: {
      subscription_id: subscriptionId,
      period_id: periodId,
      telegram_user_id: telegramUserId,
      channel_id: channelId,
      expires_at: expiresAt,
    },
  };
  const canonicalBody = JSON.stringify(stableIdentity);

  return {
    event: {
      event_id: `tribute-${sha256(canonicalBody)}`,
      event_type: 'newcomer',
      chat_id: String(targetChatId),
      user: {
        id: telegramUserId,
        is_bot: false,
        first_name: '',
        last_name: '',
        username,
      },
    },
    canonicalBody,
  };
}
