import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const FILE_NAME = /^\d{13}-[a-f0-9-]{36}\.json$/u;
const LIMITS = Object.freeze({
  cooldownSec: [0, 86_400], dailyPerUser: [0, 10_000],
  syntheticDailyPerUser: [0, 10_000], answerMaxTokens: [1, 4_096],
  dialogueTurnLimit: [1, 100],
});

export class SettingsCandidateError extends Error {
  constructor(code, statusCode = 409) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function digest(value) {
  const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function currentValues(config) {
  return {
    cooldownSec: config.assistantPolicy.cooldownSec,
    dailyPerUser: config.assistantPolicy.dailyPerUser,
    syntheticDailyPerUser: config.assistantPolicy.syntheticDailyPerUser,
    answerMaxTokens: config.runtimeModels.answerMaxTokens,
    dialogueTurnLimit: config.assistantPolicy.dialogueTurnLimit,
    pausedChatIds: [],
  };
}

function validate(values, allowedChatIds) {
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || Object.keys(values).sort().join(',') !== [...Object.keys(LIMITS), 'pausedChatIds'].sort().join(',')) {
    throw new SettingsCandidateError('settings_shape_invalid', 400);
  }
  for (const [name, [min, max]] of Object.entries(LIMITS)) {
    if (!Number.isSafeInteger(values[name]) || values[name] < min || values[name] > max) {
      throw new SettingsCandidateError(`settings_${name}_invalid`, 400);
    }
  }
  if (!Array.isArray(values.pausedChatIds)
    || values.pausedChatIds.some((id) => typeof id !== 'string' || !allowedChatIds.includes(id))
    || new Set(values.pausedChatIds).size !== values.pausedChatIds.length) {
    throw new SettingsCandidateError('settings_pausedChatIds_invalid', 400);
  }
  return { ...values, pausedChatIds: [...values.pausedChatIds].sort() };
}

function latest(root, allowedChatIds) {
  if (!root || !existsSync(root)) return null;
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SettingsCandidateError('settings_store_invalid', 503);
  const names = readdirSync(root).filter((name) => FILE_NAME.test(name)).sort();
  if (!names.length) return null;
  const file = join(root, names.at(-1));
  const fileStat = lstatSync(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new SettingsCandidateError('settings_candidate_invalid', 503);
  const candidate = JSON.parse(readFileSync(file, 'utf8'));
  let normalized;
  try { normalized = validate(candidate?.values, allowedChatIds); }
  catch { throw new SettingsCandidateError('settings_candidate_invalid', 503); }
  if (candidate?.kind !== 'assistant-settings-candidate-v1'
    || !/^[a-f0-9]{64}$/u.test(candidate?.sourceDigest || '')
    || candidate?.candidateDigest !== digest(normalized)
    || !Number.isFinite(Date.parse(candidate?.createdAt))
    || candidate?.state !== 'prepared'
    || candidate?.runtimeApplied !== false) throw new SettingsCandidateError('settings_candidate_invalid', 503);
  return { ...candidate, fileName: names.at(-1) };
}

/** The Console saves candidate revisions; a separate exact release applies runtime settings. */
export function createSettingsCandidateStore(config) {
  const root = config.candidateRoot ? resolve(config.candidateRoot, 'settings') : null;
  const allowedChatIds = config.assistantPolicy.chatIds || [];
  const released = currentValues(config);
  const sourceDigest = digest(released);
  return {
    read() {
      const candidate = latest(root, allowedChatIds);
      return {
        released, candidate: candidate?.values || null,
        sourceDigest, candidateDigest: candidate?.candidateDigest || null,
        baseDigest: candidate?.candidateDigest || sourceDigest,
        candidateCreatedAt: candidate?.createdAt || null,
        stale: Boolean(candidate && candidate.sourceDigest !== sourceDigest),
        allowedChatIds, editingEnabled: Boolean(root), runtimeApplied: false,
      };
    },
    save({ values, baseDigest } = {}) {
      if (!root) throw new SettingsCandidateError('candidate_storage_disabled');
      const next = validate(values, allowedChatIds);
      const current = latest(root, allowedChatIds);
      if (current && current.sourceDigest !== sourceDigest) {
        throw new SettingsCandidateError('released_settings_changed');
      }
      if (baseDigest !== (current?.candidateDigest || sourceDigest)) {
        throw new SettingsCandidateError('candidate_stale');
      }
      if (digest(next) === (current?.candidateDigest || sourceDigest)) {
        throw new SettingsCandidateError('candidate_unchanged');
      }
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new SettingsCandidateError('settings_store_invalid', 503);
      }
      const candidate = {
        kind: 'assistant-settings-candidate-v1', sourceDigest,
        candidateDigest: digest(next), values: next, createdAt: new Date().toISOString(),
        state: 'prepared', runtimeApplied: false,
      };
      const nextTime = Math.max(Date.now(), current ? Number(current.fileName.slice(0, 13)) + 1 : 0);
      const file = join(root, `${nextTime}-${randomUUID()}.json`);
      const staging = join(root, `.staging-${randomUUID()}.json`);
      try {
        writeFileSync(staging, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(staging, file);
      } catch (error) {
        rmSync(staging, { force: true });
        throw error;
      }
      return { candidateDigest: candidate.candidateDigest, createdAt: candidate.createdAt,
        state: 'prepared', runtimeApplied: false };
    },
  };
}
