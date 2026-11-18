// Deterministic answer evaluation and decision (questionnaire v2, A0-bis).
// Pure functions: no I/O.
import { adSignals } from './screening.mjs';
import { comparable, countEmoji, countLettersOrDigits, normalizeText } from './text.mjs';

// Answer rows of the multi_choice question are an append-only log in
// join_answers (no schema change): `reason` tells the row kind.
export const TOPIC_ROW = Object.freeze({
  toggle: 'toggle', // text = option id; selection = odd number of toggles
  custom: 'custom_topic', // text = the user's own topic (clean)
  done: 'done', // text = "selected:<ids>;custom:<n>"
});

export function nonsenseReason(text, promptText = '') {
  const normalized = normalizeText(text);
  if (!normalized) return 'empty';
  const letters = countLettersOrDigits(normalized);
  if (letters === 0) {
    return countEmoji(normalized) > 0 ? 'only_emoji' : 'only_punctuation';
  }
  const compact = normalized.replace(/[^\p{L}\p{N}]/gu, '');
  if (compact.length >= 2 && new Set(compact).size === 1) return 'repeated_char';
  const answerCmp = comparable(normalized);
  const promptCmp = comparable(promptText);
  if (promptCmp && answerCmp && (answerCmp === promptCmp || (answerCmp.length >= 15 && promptCmp.includes(answerCmp)))) {
    return 'copy_of_question';
  }
  return null;
}

// Choice question. input: { optionId } for a button or { text } for a typed
// answer. Returns { pass, reason, optionId? }:
//   pass=true                     → accepted option;
//   pass=false, reason=R_*        → a definite rejecting option (decline code);
//   pass=false, reason=no_matching_option / unknown_option → not an answer,
//   the question is shown again.
export function evaluateChoice(question, input = {}) {
  let option;
  if (typeof input.optionId === 'string') {
    option = question.options.find((o) => o.id === input.optionId);
    if (!option) return { pass: false, reason: 'unknown_option' };
  } else {
    const typed = comparable(input.text);
    option = typed
      ? question.options.find((o) => comparable(o.label) === typed || o.aliases.some((alias) => comparable(alias) === typed))
      : null;
    if (!option) return { pass: false, reason: 'no_matching_option' };
  }
  if (option.reject) return { pass: false, reason: option.reject, optionId: option.id };
  return { pass: true, reason: 'accepted_option', optionId: option.id };
}

// A user's own topic (free text on the multi_choice question).
//   { kind: 'reject', reason: 'R_TOPIC_AD', signals } — link / @mention / spam keyword;
//   { kind: 'ignore', reason: 'nonsense:*' }          — nothing meaningful, not counted;
//   { kind: 'accept' }                                 — counted as a topic.
export function evaluateCustomTopic(question, text, scenario) {
  const signals = adSignals(text, scenario);
  if (signals.length > 0) return { kind: 'reject', reason: question.custom.reject, signals };
  const nonsense = nonsenseReason(text, question.promptText);
  if (nonsense) return { kind: 'ignore', reason: `nonsense:${nonsense}` };
  return { kind: 'accept' };
}

// Current selection of the multi_choice question from its answer rows.
export function topicState(question, answers) {
  const selected = new Set();
  let custom = 0;
  for (const row of answers) {
    if (row.question_id !== question.id || row.pass !== 1) continue;
    if (row.reason === TOPIC_ROW.toggle && question.options.some((o) => o.id === row.text)) {
      if (selected.has(row.text)) selected.delete(row.text); else selected.add(row.text);
    } else if (row.reason === TOPIC_ROW.custom) {
      custom += 1;
    }
  }
  const ordered = question.options.map((o) => o.id).filter((id) => selected.has(id));
  return { selected: ordered, custom, satisfied: ordered.length >= question.minSelected || custom >= 1 };
}

// Final decision over all answers (decision rule A0-bis). Returns
// { approve: true } when every question is answered acceptably, else
// { approve: false, missing: questionId }. Rejecting answers never reach this
// point: they decline at once with their own code.
export function decideAnswers(questions, answers) {
  for (const question of questions) {
    if (question.type === 'choice') {
      const last = answers.filter((row) => row.question_id === question.id && row.reason !== 'no_matching_option'
        && row.reason !== 'unknown_option').at(-1);
      if (!last || last.pass !== 1) return { approve: false, missing: question.id };
    } else {
      const done = answers.some((row) => row.question_id === question.id && row.reason === TOPIC_ROW.done && row.pass === 1);
      if (!done || !topicState(question, answers).satisfied) return { approve: false, missing: question.id };
    }
  }
  return { approve: true };
}

