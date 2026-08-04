#!/usr/bin/env node

import { runScenarioTextsCommand } from './scenario-texts.mjs';

const command = process.argv[2];
if (process.argv.length !== 3) {
  throw new Error('Usage: node src/scenario-texts-cli.mjs check|sync');
}

const result = runScenarioTextsCommand(command);
const action = command === 'check'
  ? 'verified'
  : (result.differences.length ? 'synchronized' : 'already synchronized');
process.stdout.write(
  `Scenario texts ${action}: ${result.messageCount} machine messages, `
  + `${result.humanEntryCount} human entries.\n`,
);
