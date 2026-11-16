// Deterministic account screening from Telegram-only signals (contract §5).
// Pure function: no I/O, no model calls.
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

export function screenApplicant({ from = {}, bio = null, photoCount = null } = {}, scenario) {
  const { spamKeywords, compiledLinkPatterns } = scenario.screening;
  const reasons = [];
  let block = false;

  if (from.is_bot === true) {
    return { verdict: 'block', reasons: ['is_bot'] };
  }

  const rawName = [from.first_name, from.last_name].filter((part) => typeof part === 'string').join(' ');
  const username = typeof from.username === 'string' ? from.username : '';
  const bioText = typeof bio === 'string' ? bio : '';
  const fields = { name: rawName, username, bio: bioText };

  // Links, t.me, invite links, @-mentions of other accounts.
  let linkFound = false;
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    if (containsLink(value, compiledLinkPatterns)) {
      linkFound = true;
      reasons.push(`link:${field}`);
    }
    if (field !== 'username' && MENTION_RE.test(normalizeText(value))) {
      linkFound = true;
      reasons.push(`mention:${field}`);
    }
  }

  // Spam keywords (distinct stems across all fields).
  const hits = new Set();
  for (const value of Object.values(fields)) {
    for (const hit of keywordHits(value, spamKeywords)) hits.add(hit);
  }
  for (const hit of hits) reasons.push(`spam_keyword:${hit}`);
  if (hits.size >= 2) block = true;
  if (hits.size >= 1 && linkFound) block = true;

  // Name shape.
  if (hasInvisibleChars(rawName) || hasInvisibleChars(username)) reasons.push('invisible_chars');
  const letters = countLettersOrDigits(stripInvisible(rawName.normalize('NFKC')));
  const emoji = countEmoji(rawName);
  if (letters === 0) {
    reasons.push('empty_name');
  } else if (emoji > 0 && emoji >= letters) {
    reasons.push('emoji_name');
  }
  if (hasMixedScriptWord(rawName) || hasMixedScriptWord(username)) reasons.push('mixed_script');

  // Weak signal: only together with another reason.
  if (photoCount === 0 && reasons.length > 0) reasons.push('no_photo');

  if (block) return { verdict: 'block', reasons };
  if (reasons.length > 0) return { verdict: 'review', reasons };
  return { verdict: 'clean', reasons };
}
