// Operator CLI for access tokens (contract v2 §1). Offline: no Telegram calls.
// Needs only JOIN_GATEKEEPER_DATA_ROOT (and optional DATABASE_PATH).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, requireOption } from './cli-args.mjs';
import { loadDataConfig } from './config.mjs';
import { JoinStore } from './store.mjs';
import { generateTokens, parseIdsCsv, reissueToken, tokenStatus } from './tokens.mjs';

const USAGE = `usage:
  tokens-cli generate --input ids.csv --output tokens.csv --bot-username <bot>
  tokens-cli reissue --site-record-id <id> --output token.csv --bot-username <bot>
  tokens-cli status --site-record-id <id>`;

export function openStore(env) {
  const { databasePath } = loadDataConfig(env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const store = new JoinStore(databasePath);
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${databasePath}${suffix}`)) fs.chmodSync(`${databasePath}${suffix}`, 0o600);
  }
  return store;
}

export function runTokensCli(argv, { env = process.env, now = Date.now(), out = console.log } = {}) {
  const parsed = parseArgs(argv, { options: ['input', 'output', 'bot-username', 'site-record-id'] });
  if (!['generate', 'reissue', 'status'].includes(parsed.command)) throw new Error(USAGE);
  const store = openStore(env);
  try {
    if (parsed.command === 'generate') {
      const ids = parseIdsCsv(fs.readFileSync(requireOption(parsed, 'input'), 'utf8'));
      const result = generateTokens({
        store, ids, outputPath: requireOption(parsed, 'output'), botUsername: parsed.options['bot-username'], now,
      });
      out(JSON.stringify({ ok: true, generated: result.count, output: result.outputPath }));
      return result;
    }
    if (parsed.command === 'reissue') {
      const result = reissueToken({
        store,
        siteRecordId: requireOption(parsed, 'site-record-id'),
        outputPath: requireOption(parsed, 'output'),
        botUsername: parsed.options['bot-username'],
        now,
      });
      out(JSON.stringify({ ok: true, ...result }));
      return result;
    }
    const status = tokenStatus({ store, siteRecordId: requireOption(parsed, 'site-record-id') });
    out(JSON.stringify(status, null, 2));
    return status;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    runTokensCli(process.argv.slice(2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  }
}
