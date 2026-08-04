#!/usr/bin/env node
import { loadRuntimeConfig } from '../../apps/telegram-runtime/src/config.mjs';
import { runTelegramOperation } from '../../apps/telegram-runtime/src/telegram-ops.mjs';

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function usage() {
  return [
    'Usage: node scripts/aichattg/telegram-ops.mjs --action <status|set-webhook|delete-webhook|set-commands> --role <moderator|assistant> [--apply]',
    'Without --apply this prints a redacted dry-run plan and performs no network request.',
  ].join('\n');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
const action = option(args, '--action');
const role = option(args, '--role');
if (!action || !role || args.some((arg) => arg.startsWith('--') && !['--action', '--role', '--apply'].includes(arg))) {
  process.stderr.write(`${usage()}\n`);
  process.exit(2);
}

try {
  const output = await runTelegramOperation({
    action,
    role,
    runtimeConfig: loadRuntimeConfig(process.env),
    publicOrigin: process.env.AICHATTG_PUBLIC_ORIGIN,
    apply: args.includes('--apply'),
  });
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`telegram operations failed: ${error.message}\n`);
  process.exitCode = 1;
}
