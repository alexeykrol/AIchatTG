import { createHash } from 'node:crypto';
import { labSafetyVerdict } from './lab-safety.mjs';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalAssistantSession } from '../local-assistant.mjs';
import { emptyWorkingState, projectWorkingState } from '../../src/assistant-working-state.mjs';
import { createWorkingStateUpdater } from '../../src/working-state-updater.mjs';
import { openDialogueStore } from './local-dialogue-store.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (v) => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
export function tree(path) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('managed_pin_symlink');
  if (lstatSync(path).isFile()) return { '.': hash(readFileSync(path)) };
  const files = {};
  function visit(current) {
    for (const entry of readdirSync(current).sort()) {
      const file = join(current, entry);
      if (lstatSync(file).isSymbolicLink()) throw new Error('managed_pin_symlink');
      if (lstatSync(file).isDirectory()) visit(file);
      else if (lstatSync(file).isFile()) files[relative(path, file)] = hash(readFileSync(file));
    }
  }
  visit(path); return files;
}
export function inside(root, path) { const rel = relative(root, path); return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function id(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('managed_identity_invalid'); }

export function buildManagedManifest({ runId, identity, plan, packageDir, methodologyDir, adapterFile, config, maxTurns = plan?.length }) {
  id(runId); id(identity?.conversationId); id(identity?.participantId);
  if (Object.keys(identity).sort().join(',') !== 'chatId,conversationId,participantId,userId'
    || !/^-[1-9]\d*$/.test(identity.chatId) || !/^[1-9]\d*$/.test(identity.userId)
    || !Number.isSafeInteger(Number(identity.chatId)) || !Number.isSafeInteger(Number(identity.userId))) throw new Error('managed_identity_invalid');
  if (!Array.isArray(plan) || !plan.length || plan.length > 1000) throw new Error('managed_plan_invalid');
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 0 || maxTurns > plan.length) throw new Error('managed_turn_limit_invalid');
  const ids = new Set();
  for (const item of plan) {
    id(item.id);
    if (Object.keys(item).sort().join(',') !== 'id,text' || ids.has(item.id)
      || typeof item.text !== 'string' || item.text !== item.text.trim() || !item.text
      || item.text.startsWith('/ask') || Buffer.byteLength(item.text) > 8000) throw new Error('managed_plan_invalid');
    ids.add(item.id);
  }
  if (Object.keys(config).some((key) => key !== 'analyzerMode') || !['off', 'observe', 'dispatch'].includes(config.analyzerMode)) throw new Error('managed_config_invalid');
  const methodologyRoot = realpathSync(methodologyDir);
  const adapter = realpathSync(adapterFile);
  if (!inside(methodologyRoot, adapter)) throw new Error('managed_adapter_outside_methodology');
  const actualCore = realpathSync(fileURLToPath(import.meta.resolve('@aichattg/telegram-core')));
  if (actualCore !== realpathSync(join(repo, 'packages/telegram-core/src/index.mjs'))) throw new Error('managed_core_location_mismatch');
  const code = {};
  for (const name of ['apps/telegram-runtime/src', 'apps/telegram-runtime/scripts', 'packages/telegram-core/src',
    'package.json', 'package-lock.json', 'apps/telegram-runtime/package.json', 'packages/telegram-core/package.json']) {
    if (existsSync(join(repo, name))) code[name] = tree(join(repo, name));
  }
  return { schema_version: 1, run_id: runId, identity, plan, turn_limit: maxTurns,
    pins: { code, config, knowledge: tree(realpathSync(packageDir)), methodology: tree(methodologyRoot),
      adapter: relative(methodologyRoot, adapter), node: process.version },
    plan_fingerprints: plan.map((item, index) => ({ id: item.id, event_id: `assistant:${index * 2 + 2}`, fingerprint: hash(canonical({ identity, item, index })) })),
  };
}

/** Explicit managed local mode. Adapter modules are reviewed trusted code, not a sandbox.
 * No env loading, service startup, implicit provider or second chatbot. */
export async function runManagedDialogue({ storageRoot, runId, identity, plan, packageDir,
  methodologyDir, adapterFile, config = { analyzerMode: 'off' }, resume = false,
  repairState = false, maxTurns = plan?.length, maxSteps = 2,
  now = () => Math.floor(Date.now() / 1000), testHooks = null } = {}) {
  if (typeof storageRoot !== 'string' || !isAbsolute(storageRoot)) throw new Error('managed_storage_root_required');
  for (const [value, max] of [[maxTurns, 1000], [maxSteps, 2000]]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('managed_budget_invalid');
  }
  const manifest = buildManagedManifest({ runId, identity, plan, packageDir, methodologyDir, adapterFile, config, maxTurns });
  mkdirSync(storageRoot, { recursive: true });
  const directory = join(realpathSync(storageRoot), runId);
  if (inside(resolve(packageDir), directory) || inside(resolve(methodologyDir), directory)
    || inside(repo, directory) || directory === repo || directory === realpathSync(packageDir) || directory === realpathSync(methodologyDir)) throw new Error('managed_storage_overlaps_pins');
  const sidecar = openDialogueStore(directory, resume);
  let session;
  try {
    let checkpoint = sidecar.read();
    if (resume) {
      if (!checkpoint || canonical(checkpoint.manifest) !== canonical(manifest)) throw new Error('managed_manifest_mismatch');
    } else {
      checkpoint = { manifest, cursor: 0, status: maxTurns === 0 ? 'completed' : 'paused', state: emptyWorkingState(), pairs: [], attempts: [], observations: [], pending: null };
      sidecar.write(checkpoint);
    }
    const save = () => sidecar.write(checkpoint);
    const result = () => structuredClone({ ...checkpoint, usable_state: projectWorkingState(checkpoint.state, now()), directory });
    if (checkpoint.status === 'completed' || checkpoint.status === 'uncertain' || checkpoint.status === 'failed') return result();
    if (checkpoint.pending?.phase === 'state_updating') {
      checkpoint.status = 'uncertain'; checkpoint.error = 'updater_interrupted_unknown_outcome'; save(); return result();
    }
    if (checkpoint.pending?.phase === 'state_pending' && !repairState) return result();
    if (!maxTurns || !maxSteps) return result();
    const record = (event) => { checkpoint.observations.push(structuredClone(event)); save(); };
    const { createManagedProviders } = await import(pathToFileURL(realpathSync(adapterFile)).href);
    const adapters = await createManagedProviders({ record, config: structuredClone(config) });
    const providerPins = { assistant: adapters.provider?.configurationFingerprint, updater: adapters.stateProvider?.configurationFingerprint };
    if (Object.values(providerPins).some((value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw new Error('managed_provider_configuration_required');
    if (checkpoint.provider_pins && canonical(checkpoint.provider_pins) !== canonical(providerPins)) throw new Error('managed_provider_configuration_mismatch');
    checkpoint.provider_pins = providerPins; save();
    const updater = createWorkingStateUpdater(adapters.stateProvider);
    const provider = { moderate: labSafetyVerdict };
    for (const stage of ['routeAssistant', 'answer', 'analyze']) {
      if (typeof adapters.provider?.[stage] !== 'function') continue;
      provider[stage] = async (input) => {
        const attempt = { stage, pair_id: plan[checkpoint.cursor].id, status: 'calling', usage: null };
        checkpoint.attempts.push(attempt); save();
        try {
          const raw = await adapters.provider[stage](input);
          attempt.status = 'returned'; attempt.usage = raw?.receipt ?? raw?.usage ?? null; save(); return raw;
        } catch (error) { attempt.status = 'uncertain'; attempt.usage = error?.receipt ?? error?.usage ?? null; save(); throw error; }
      };
    }
    session = createLocalAssistantSession({ databasePath: join(directory, 'runtime.db'), packageDir, provider,
      identity, analyzerMode: config.analyzerMode, now, durableAnswerReceipts: true,
      workingStateProvider({ chatId, userId }) {
        if (chatId !== identity.chatId || userId !== identity.userId) throw new Error('managed_context_identity_mismatch');
        return projectWorkingState(checkpoint.state, now());
      },
    });
    if (!session.contentRetrieval.available) {
      checkpoint.status = 'failed'; checkpoint.error = session.contentRetrieval.reason; save(); return result();
    }
    let steps = 0;
    while (checkpoint.cursor < manifest.turn_limit && steps < maxSteps) {
      const item = plan[checkpoint.cursor];
      const pairId = `${identity.conversationId}:${identity.participantId}:${item.id}`;
      if (checkpoint.pending?.phase === 'answer_pending') {
        const pair = session.completedPair(checkpoint.cursor, pairId, item.text);
        if (!pair) { checkpoint.status = 'uncertain'; checkpoint.error = 'runtime_answer_outcome_unknown'; save(); break; }
        checkpoint.pending = { ...checkpoint.pending, phase: 'state_pending', pair }; save();
      }
      if (!checkpoint.pending) {
        checkpoint.status = 'running';
        checkpoint.pending = { phase: 'answer_pending', ...manifest.plan_fingerprints[checkpoint.cursor] }; save();
        steps += 1;
        const outcome = await session.ask(checkpoint.cursor, item.text);
        await testHooks?.afterRuntimeAnswer?.();
        const pair = session.completedPair(checkpoint.cursor, pairId, item.text);
        if (!pair) { checkpoint.status = 'uncertain'; checkpoint.error = `runtime_answer_unconfirmed:${outcome.kind}`; save(); break; }
        checkpoint.pending = { ...checkpoint.pending, phase: 'state_pending', pair };
        checkpoint.status = 'state_pending'; save();
      }
      if (steps >= maxSteps) break;
      const pair = checkpoint.pending.pair;
      checkpoint.pending.phase = 'state_updating';
      const attempt = { stage: 'state', pair_id: pair.id, status: 'calling', usage: null };
      checkpoint.attempts.push(attempt); save(); steps += 1;
      const update = await updater.update({ state: checkpoint.state, pair, now: now() });
      attempt.status = update.status; attempt.usage = update.usage; attempt.error = update.error ?? null;
      if (update.status !== 'ok') {
        checkpoint.pending.phase = update.status === 'uncertain' ? 'state_updating' : 'state_pending';
        checkpoint.status = update.status; checkpoint.error = update.error; save(); break;
      }
      await testHooks?.beforeStateCommit?.();
      // One sidecar commit includes the pair, revision, usage, cursor and pending removal.
      checkpoint.state = update.state; checkpoint.pairs.push({ ...pair, fingerprint: checkpoint.pending.fingerprint });
      checkpoint.cursor += 1; checkpoint.pending = null; checkpoint.error = null;
      checkpoint.status = checkpoint.cursor === manifest.turn_limit ? 'completed' : 'paused'; save();
    }
    if (checkpoint.pending?.phase === 'state_pending') checkpoint.status = 'state_pending';
    else if (checkpoint.status === 'running') checkpoint.status = 'paused';
    save(); return result();
  } finally { session?.close(); sidecar.close(); }
}
