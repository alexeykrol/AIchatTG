// Expert-side adapter: the canonical assistant, no role text. This file is pinned.
import { createFixtureProviders, questionDigest } from './dual-provider-base.mjs';
export function createManagedProviders({ record, config }) {
  if (config?.instance?.role_text != null) throw new Error('expert_adapter_received_role_text');
  return createFixtureProviders({ record, config,
    answer: (input) => `Ответ эксперта о prompting (ход ${input.dialogue.length + 1}, на ${questionDigest(input.question)}): prompting задаёт условия и инструкции для модели.` });
}
