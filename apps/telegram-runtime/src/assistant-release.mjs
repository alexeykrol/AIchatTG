import { readFileSync } from 'node:fs';

// Public component version, independent of npm scaffolding and Git build IDs.
// Release admission validates this immutable source file against production.
export const ASSISTANT_RELEASE = Object.freeze(JSON.parse(
  readFileSync(new URL('./assistant-release.json', import.meta.url), 'utf8'),
));
const [year, month, day] = ASSISTANT_RELEASE.releasedOn.split('-');
export const ASSISTANT_RELEASE_LINE = `Версия ${ASSISTANT_RELEASE.version} от ${day}.${month}.${year}`;

// Logical delivered text for audit receipts; bounded model memory stays bare.
export function assistantReleaseText(text) {
  return `${text}\n\n${ASSISTANT_RELEASE_LINE}`;
}
