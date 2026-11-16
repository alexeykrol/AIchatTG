// Shared deterministic text helpers for screening and answer evaluation.

// Zero-width, invisible formatting, bidi controls, soft hyphen, filler characters.
export const INVISIBLE_CHARS_RE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ]/gu;
const INVISIBLE_TEST_RE = new RegExp(INVISIBLE_CHARS_RE.source, 'u');
export const EMOJI_RE = /\p{Extended_Pictographic}/gu;

export function hasInvisibleChars(value) {
  return INVISIBLE_TEST_RE.test(String(value ?? ''));
}

export function stripInvisible(value) {
  return String(value ?? '').replace(INVISIBLE_CHARS_RE, '');
}

// NFKC, strip zero-width/invisible, lowercase, collapse whitespace.
export function normalizeText(value) {
  return stripInvisible(String(value ?? '').normalize('NFKC'))
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

export function countEmoji(value) {
  return (String(value ?? '').match(EMOJI_RE) || []).length;
}

export function countLettersOrDigits(value) {
  return (String(value ?? '').match(/[\p{L}\p{N}]/gu) || []).length;
}

export function words(value) {
  return normalizeText(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// Comparison form: normalized, punctuation/emoji/symbols removed, spaces collapsed.
export function comparable(value) {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function compileLinkPatterns(patterns) {
  return patterns.map((pattern) => new RegExp(pattern, 'iu'));
}

export function containsLink(value, compiledPatterns) {
  const text = normalizeText(value);
  return compiledPatterns.some((re) => re.test(text));
}

// Keyword stems match only at the start of a word, so "bet" does not hit
// "elizabeth" and "earn" does not hit "learn".
export function keywordHits(value, keywords) {
  const text = normalizeText(value);
  const hits = [];
  for (const keyword of keywords) {
    const kw = normalizeText(keyword);
    if (!kw) continue;
    let from = 0;
    while (from <= text.length) {
      const index = text.indexOf(kw, from);
      if (index === -1) break;
      const before = index === 0 ? '' : text[index - 1];
      if (!before || !/[\p{L}\p{N}]/u.test(before)) {
        hits.push(kw);
        break;
      }
      from = index + 1;
    }
  }
  return hits;
}
