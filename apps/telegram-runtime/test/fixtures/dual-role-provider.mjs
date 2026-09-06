// Synthetic-side adapter: the same construction as the expert; the role text
// from the run enters the system message of the answer stage. This file is pinned.
import { withRoleInSystemMessage } from '../../scripts/lib/dual-dialogue.mjs';
import { ANSWER_MODEL, createFixtureProviders, questionDigest } from './dual-provider-base.mjs';
export function createManagedProviders({ record, config }) {
  const roleText = config?.instance?.role_text;
  if (typeof roleText !== 'string' || !roleText) throw new Error('role_adapter_requires_role_text');
  return createFixtureProviders({ record, config,
    wrapFetch: (fetchFn) => withRoleInSystemMessage(fetchFn, roleText, { answerModel: ANSWER_MODEL }),
    answer: (input) => `Скептик (ход ${input.dialogue.length + 1}, на ${questionDigest(input.question)}): а prompting у вас настоящий или просто слова?` });
}
