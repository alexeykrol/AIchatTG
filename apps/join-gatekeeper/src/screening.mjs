// Deterministic pre-questionnaire checks from Telegram-only signals
// (questionnaire v2, A0-bis). Pure functions: no I/O, no model calls.
//
// Precedence (after the rate limit, which the service checks first):
//   R_SCAM       — is_bot (join request), is_scam / is_fake (triage export);
//   R_PROFILE_AD — link or @mention in bio / name, link in username, or a
//                  channel attached to the profile (personal_chat);
//   R_STOPWORD   — spam keyword in name / username / bio.
// Soft signals (emoji/invisible chars, mixed script, empty name, no photo) are
// informational only: they never decline and never force a manual review.
import {
  containsLink,
  countEmoji,
  countLettersOrDigits,
  hasInvisibleChars,
  keywordHits,
  normalizeText,
  stripInvisible,
} from './text.mjs';

const MENTION_RE = /(^|[^\p{L}\p{N}_])@[a-z0-9_]{4,32}\b/iu;
const LATIN_RE = /\p{Script=Latin}/u;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

function hasMixedScriptWord(value) {
  const tokens = stripInvisible(String(value ?? '').normalize('NFKC')).split(/[^\p{L}]+/u).filter(Boolean);
  return tokens.some((token) => LATIN_RE.test(token) && CYRILLIC_RE.test(token));
}

export function containsMention(value) {
  return MENTION_RE.test(normalizeText(value));
}

// Advertising signals in a free text (used for a user's own topic):
// link (scenario linkPatterns), @mention, spam keyword.
export function adSignals(text, scenario) {
  const { spamKeywords, compiledLinkPatterns } = scenario.screening;
  const value = typeof text === 'string' ? text : '';
  if (!value) return [];
  const signals = [];
  if (containsLink(value, compiledLinkPatterns)) signals.push('link');
  if (containsMention(value)) signals.push('mention');
  for (const hit of keywordHits(value, spamKeywords)) signals.push(`spam_keyword:${hit}`);
  return signals;
}

// input: { from, bio, personalChat, photoCount, isScam, isFake }
//   personalChat: true / false / null (null = unknown, never a signal)
//   photoCount:   integer / null      (informational only)
// Returns { reason: null | 'R_SCAM' | 'R_PROFILE_AD' | 'R_STOPWORD', signals, info }.
// `signals` and `info` are codes only — never user text.
export function precheckApplicant({
  from = {}, bio = null, personalChat = null, photoCount = null, isScam = null, isFake = null,
} = {}, scenario) {
  const { spamKeywords, compiledLinkPatterns } = scenario.screening;

  const scam = [];
  if (from.is_bot === true) scam.push('is_bot');
  if (isScam === true) scam.push('is_scam');
  if (isFake === true) scam.push('is_fake');
  if (scam.length > 0) return { reason: 'R_SCAM', signals: scam, info: [] };

  const rawName = [from.first_name, from.last_name].filter((part) => typeof part === 'string').join(' ');
  const username = typeof from.username === 'string' ? from.username : '';
  const bioText = typeof bio === 'string' ? bio : '';
  const fields = { name: rawName, username, bio: bioText };

  const ad = [];
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    if (containsLink(value, compiledLinkPatterns)) ad.push(`link:${field}`);
    if (field !== 'username' && containsMention(value)) ad.push(`mention:${field}`);
  }
  if (personalChat === true) ad.push('personal_chat');

  const hits = new Set();
  for (const value of Object.values(fields)) {
    for (const hit of keywordHits(value, spamKeywords)) hits.add(hit);
  }
  const stop = [...hits].map((hit) => `spam_keyword:${hit}`);

  const info = [];
  if (hasInvisibleChars(rawName) || hasInvisibleChars(username)) info.push('invisible_chars');
  const letters = countLettersOrDigits(stripInvisible(rawName.normalize('NFKC')));
  const emoji = countEmoji(rawName);
  if (letters === 0) {
    info.push('empty_name');
  } else if (emoji > 0 && emoji >= letters) {
    info.push('emoji_name');
  }
  if (hasMixedScriptWord(rawName) || hasMixedScriptWord(username)) info.push('mixed_script');
  if (photoCount === 0) info.push('no_photo');

  const signals = [...ad, ...stop];
  if (ad.length > 0) return { reason: 'R_PROFILE_AD', signals, info };
  if (stop.length > 0) return { reason: 'R_STOPWORD', signals, info };
  return { reason: null, signals, info };
}
