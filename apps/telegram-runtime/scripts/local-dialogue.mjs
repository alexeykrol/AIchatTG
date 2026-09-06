#!/usr/bin/env node
// Explicit local managed runner. JSON contains pinned plan/config and reviewed
// provider adapter path; this CLI never loads .env or selects a paid provider.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runManagedDialogue } from './lib/managed-dialogue.mjs';
export { runManagedDialogue };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== '--request' || !process.argv[3]) throw new Error('usage: local-dialogue.mjs --request request.json');
    const request = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const result = await runManagedDialogue(request);
    console.log(JSON.stringify(result));
    process.exitCode = ['uncertain', 'failed', 'state_pending'].includes(result.status) ? 2 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
