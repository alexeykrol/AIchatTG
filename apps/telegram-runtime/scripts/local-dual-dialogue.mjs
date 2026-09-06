#!/usr/bin/env node
// Explicit local runner for a two-instance dialogue (wave3). The request JSON
// names the scenario, both participant records, the expert package and the two
// reviewed provider adapters (each inside its methodology directory). This CLI
// never loads .env, starts no service and selects no provider by itself.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDualDialogue } from './lib/dual-dialogue.mjs';
export { runDualDialogue };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== '--request' || !process.argv[3]) throw new Error('usage: local-dual-dialogue.mjs --request request.json');
    const request = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const result = await runDualDialogue(request);
    console.log(JSON.stringify(result));
    process.exitCode = ['uncertain', 'failed', 'state_pending'].includes(result.status) ? 2 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
