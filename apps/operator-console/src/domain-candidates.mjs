import { randomUUID } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_DOMAIN_INDEX, loadDomainCatalog } from '../../telegram-runtime/src/assistant-domains.mjs';

const BUNDLE_NAME = /^\d{13}-[a-f0-9]{12}-[a-f0-9-]{36}$/u;
const MAX_TEXT_CHARS = 16_000;
const MAX_TEXT_BYTES = MAX_TEXT_CHARS * 4;

export class DomainCandidateError extends Error {
  constructor(code, statusCode = 409) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function regularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DomainCandidateError('candidate_file_invalid', 503);
}

function directory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DomainCandidateError('candidate_directory_invalid', 503);
}

function markdownDomains(catalog) {
  return catalog.domains.filter((domain) => domain.sourceKind === 'markdown');
}

function readManifest(path) {
  regularFile(path);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest?.kind !== 'assistant-domain-markdown-candidate-v1'
    || !/^[a-f0-9]{64}$/u.test(manifest?.sourceDigest || '')
    || !/^[a-f0-9]{64}$/u.test(manifest?.baseDigest || '')
    || !/^[a-f0-9]{64}$/u.test(manifest?.digest || '')
    || !Number.isFinite(Date.parse(manifest?.createdAt))
    || !/^[a-z][a-z0-9-]*$/u.test(manifest?.modifiedDomain || '')
    || manifest?.state !== 'prepared' || manifest?.runtimeApplied !== false) {
    throw new DomainCandidateError('candidate_manifest_invalid', 503);
  }
  return manifest;
}

function latestBundle(root) {
  if (!root) return null;
  if (!existsSync(root)) return null;
  directory(root);
  const names = readdirSync(root).filter((name) => BUNDLE_NAME.test(name)).sort();
  if (!names.length) return null;
  const path = join(root, names.at(-1));
  directory(path);
  const manifest = readManifest(join(path, 'manifest.json'));
  const catalog = loadDomainCatalog({ indexPath: join(path, 'INDEX.md') });
  if (catalog.digest !== manifest.digest) throw new DomainCandidateError('candidate_digest_mismatch', 503);
  return { name: names.at(-1), path, manifest, catalog };
}

function validateText(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS
    || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES || text.includes('\0')
    || !/^# [^\n]+\n+[\s\S]*\S/u.test(text)) {
    throw new DomainCandidateError('markdown_invalid', 400);
  }
  return text.replace(/\r\n/gu, '\n');
}

/** Versioned copies only. The running Telegram image and its domain files remain untouched. */
export function createDomainCandidateStore({
  domainIndexPath = DEFAULT_DOMAIN_INDEX, candidateRoot = null,
} = {}) {
  const indexPath = resolve(domainIndexPath);
  const root = candidateRoot ? resolve(candidateRoot) : null;
  const current = () => loadDomainCatalog({ indexPath });
  const activeFile = (domain) => join(dirname(indexPath), domain.knowledgePath);

  function state() {
    const released = current();
    const latest = latestBundle(root);
    return { released, latest, stale: Boolean(latest && latest.manifest.sourceDigest !== released.digest) };
  }

  return {
    list() {
      const { released, latest, stale } = state();
      return {
        sourceDigest: released.digest,
        candidateDigest: latest?.manifest.digest || null,
        candidateCreatedAt: latest?.manifest.createdAt || null,
        stale,
        editingEnabled: Boolean(root),
        domains: released.domains.map((domain) => ({
          id: domain.id, title: domain.title, sourceKind: domain.sourceKind,
          sourceId: domain.sourceId,
          knowledgeFile: domain.sourceKind === 'markdown' ? domain.knowledgePath : null,
          editable: domain.sourceKind === 'markdown' && Boolean(root),
        })),
      };
    },
    read(id) {
      const { released, latest, stale } = state();
      const domain = released.get(id);
      if (!domain) throw new DomainCandidateError('domain_unknown', 404);
      if (domain.sourceKind !== 'markdown') throw new DomainCandidateError('domain_not_markdown', 400);
      regularFile(activeFile(domain));
      const releasedText = readFileSync(activeFile(domain), 'utf8');
      const candidateFile = latest ? join(latest.path, domain.knowledgePath) : null;
      if (candidateFile) regularFile(candidateFile);
      return {
        id, title: domain.title, knowledgeFile: domain.knowledgePath,
        releasedText,
        candidateText: candidateFile ? readFileSync(candidateFile, 'utf8') : null,
        sourceDigest: released.digest,
        candidateDigest: latest?.manifest.digest || null,
        candidateCreatedAt: latest?.manifest.createdAt || null,
        baseDigest: latest?.manifest.digest || released.digest,
        stale, editingEnabled: Boolean(root),
      };
    },
    save(id, { text, baseDigest } = {}) {
      if (!root) throw new DomainCandidateError('candidate_storage_disabled', 409);
      const body = validateText(text);
      const { released, latest, stale } = state();
      if (stale) throw new DomainCandidateError('released_source_changed', 409);
      const domain = released.get(id);
      if (!domain) throw new DomainCandidateError('domain_unknown', 404);
      if (domain.sourceKind !== 'markdown') throw new DomainCandidateError('domain_not_markdown', 400);
      if (baseDigest !== (latest?.manifest.digest || released.digest)) {
        throw new DomainCandidateError('candidate_stale', 409);
      }
      const priorPath = latest ? join(latest.path, domain.knowledgePath) : activeFile(domain);
      regularFile(priorPath);
      if (readFileSync(priorPath, 'utf8') === body) throw new DomainCandidateError('candidate_unchanged', 409);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      directory(root);
      const staging = mkdtempSync(join(root, '.staging-'));
      try {
        const sourceDirectory = latest?.path || dirname(indexPath);
        copyFileSync(latest ? join(sourceDirectory, 'INDEX.md') : indexPath, join(staging, 'INDEX.md'));
        chmodSync(join(staging, 'INDEX.md'), 0o600);
        for (const entry of markdownDomains(released)) {
          const target = join(staging, entry.knowledgePath);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          if (entry.id === id) writeFileSync(target, body, { mode: 0o600, flag: 'wx' });
          else {
            copyFileSync(join(sourceDirectory, entry.knowledgePath), target);
            chmodSync(target, 0o600);
          }
        }
        const candidate = loadDomainCatalog({ indexPath: join(staging, 'INDEX.md') });
        const createdAt = new Date().toISOString();
        const manifest = {
          kind: 'assistant-domain-markdown-candidate-v1', sourceDigest: released.digest,
          baseDigest, digest: candidate.digest, modifiedDomain: id, createdAt,
          state: 'prepared', runtimeApplied: false,
        };
        writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
          mode: 0o600, flag: 'wx',
        });
        // Directory order is the revision order, including two saves in one millisecond.
        const nextTime = Math.max(Date.now(), latest ? Number(latest.name.slice(0, 13)) + 1 : 0);
        const name = `${nextTime}-${candidate.digest.slice(0, 12)}-${randomUUID()}`;
        renameSync(staging, join(root, name));
        return { id, candidateDigest: candidate.digest, createdAt, state: 'prepared', runtimeApplied: false };
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
