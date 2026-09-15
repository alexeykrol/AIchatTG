export const ASSISTANT_DIALOGUE_MAX_SERIALIZED_CHARS = 50_000;
export const ASSISTANT_PROVIDER_INPUT_MAX_CHARS = 60_000;

/** Prompt projection of retained Q/A turns; never changes stored history.
 * Turn count is capped by `assistantDialogueTurnLimit` in the store query.
 * This projection additionally keeps the newest complete tail inside a shared
 * serialized-size budget, leaving room in the provider's 60k input contract
 * for the current question and request envelope. Knowledge and working-state
 * projections keep their own independent bounds.
 * All stages of an Assistant request share this same snapshot.
 */
export function assistantDialogue(turns) {
  const text = (value) => typeof value === 'string' ? value.trim() : '';
  const valid = (Array.isArray(turns) ? turns : [])
    .map((turn) => ({ question: text(turn?.question), answer: text(turn?.answer) }))
    .filter((turn) => turn.question && turn.answer
      && turn.question.length <= 8192 && turn.answer.length <= 8192);
  const retained = [];
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    const candidate = [valid[index], ...retained];
    if (JSON.stringify(candidate).length > ASSISTANT_DIALOGUE_MAX_SERIALIZED_CHARS) break;
    retained.unshift(valid[index]);
  }
  return Object.freeze(retained.map(Object.freeze));
}

/**
 * Serialize a complete provider envelope while treating dialogue as the only
 * expendable field. The current question, admitted knowledge, route and
 * working state keep their full validated projection; oldest Q/A pairs are
 * removed until the whole request fits the provider contract.
 */
export function boundedAssistantInput(turns, buildPayload, { pretty = false } = {}) {
  if (typeof buildPayload !== 'function') return null;
  const projected = assistantDialogue(turns);
  for (let start = 0; start <= projected.length; start += 1) {
    let json;
    try {
      json = JSON.stringify(
        buildPayload(Object.freeze(projected.slice(start))),
        null,
        pretty ? 2 : undefined,
      );
    } catch {
      return null;
    }
    if (typeof json === 'string' && json.length <= ASSISTANT_PROVIDER_INPUT_MAX_CHARS) return json;
  }
  return null;
}
