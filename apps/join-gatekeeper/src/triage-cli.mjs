// Operator CLI for batch triage of old join requests (contract v2 §3).
//   classify: offline, no Telegram, no database.
//   execute:  dry run by default; --confirm = PRODUCTION ACTION (PO approval
//             of the exact list hash + release lease required).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, requireOption } from './cli-args.mjs';
import { loadTriageConfig } from './config.mjs';
import { DEFAULT_SCENARIO_PATH, loadScenario } from './scenario.mjs';
import { TelegramApi } from './telegram-api.mjs';
import { openStore } from './tokens-cli.mjs';
import { classifyFile, executeTriage, writeReceipt } from './triage.mjs';

const USAGE = `usage:
  triage-cli classify --input export.json --out-dir <dir>
  triage-cli execute --list <file> --action reject|accept_restricted --expect-sha256 <sha> [--confirm] [--receipt-dir <dir>]`;

export async function runTriageCli(argv, {
  env = process.env,
  out = console.log,
  telegramFactory = ({ botToken }) => new TelegramApi({ botToken }),
  sleep,
  now,
} = {}) {
  const parsed = parseArgs(argv, {
    flags: ['confirm'],
    options: ['input', 'out-dir', 'list', 'action', 'expect-sha256', 'receipt-dir'],
  });
  if (parsed.command === 'classify') {
    const scenario = loadScenario(env.JOIN_GATEKEEPER_SCENARIO_PATH || DEFAULT_SCENARIO_PATH);
    const summary = classifyFile({
      inputPath: requireOption(parsed, 'input'), outDir: requireOption(parsed, 'out-dir'), scenario, now: now?.() ?? Date.now(),
    });
    out(JSON.stringify(summary, null, 2));
    return summary;
  }
  if (parsed.command !== 'execute') throw new Error(USAGE);

  const listText = fs.readFileSync(requireOption(parsed, 'list'), 'utf8');
  const common = {
    listText,
    action: requireOption(parsed, 'action'),
    expectSha256: requireOption(parsed, 'expect-sha256'),
  };
  if (!parsed.flags.confirm) {
    const plan = await executeTriage({ ...common, confirm: false });
    out(JSON.stringify(plan, null, 2));
    return plan;
  }

  const config = loadTriageConfig(env);
  const store = openStore(env);
  try {
    const logger = { error: (event, data) => console.error(JSON.stringify({ level: 'error', event, ...data })) };
    const receipt = await executeTriage({
      ...common,
      confirm: true,
      store,
      telegram: telegramFactory({ botToken: config.botToken }),
      targetChatIds: config.targetChatIds,
      probationDays: config.scenario.limits.probationDays,
      logger,
      ...(sleep ? { sleep } : {}),
      ...(now ? { now } : {}),
    });
    const file = writeReceipt(parsed.options['receipt-dir'] || 'receipts', receipt);
    out(JSON.stringify({ receipt: file, completed: receipt.completed, counts: receipt.counts, stopped: receipt.stopped }, null, 2));
    return receipt;
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    const result = await runTriageCli(process.argv.slice(2));
    if (result && result.completed === false) process.exit(3);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  }
}
