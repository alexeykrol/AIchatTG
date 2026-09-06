/** Prompt projection of retained Q/A turns; never changes stored history.
 * Keep the existing answer interface limits: three complete turns, 8192 chars
 * per side. All stages of an Assistant request share this same snapshot.
 */
export function assistantDialogue(turns) {
  const text = (value) => typeof value === 'string' ? value.trim() : '';
  return Object.freeze((Array.isArray(turns) ? turns : [])
    .map((turn) => ({ question: text(turn?.question), answer: text(turn?.answer) }))
    .filter((turn) => turn.question && turn.answer
      && turn.question.length <= 8192 && turn.answer.length <= 8192)
    .slice(-3)
    .map(Object.freeze));
}
