import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DOMAIN_INDEX = fileURLToPath(new URL('./domains/INDEX.md', import.meta.url));
const INDEX_LIMIT = 25_000;
const KNOWLEDGE_LIMIT = 16_000;
const ID = /^[a-z][a-z0-9-]{0,79}$/;
const FIELDS = new Map([
  ['Title', 'title'], ['Description', 'description'], ['Includes', 'includes'],
  ['Excludes', 'excludes'], ['Examples', 'examples'], ['Negative examples', 'negativeExamples'],
  ['Capability', 'capability'], ['Action', 'action'], ['Source', 'sourceId'],
  ['Source kind', 'sourceKind'], ['Served source', 'servedSourceId'],
  ['Snapshot fallback', 'snapshotFallback'],
  ['Include capabilities', 'includeCapabilities'],
  ['Knowledge', 'knowledgePath'], ['Answer policy', 'answerPolicy'],
]);
const REQUIRED = [...FIELDS.values()].filter((key) => !['action', 'knowledgePath', 'servedSourceId', 'snapshotFallback', 'includeCapabilities'].includes(key));

export class DomainCatalogError extends Error {
  constructor(code) {
    super(`Assistant domain catalog invalid: ${code}`);
    this.name = 'DomainCatalogError';
    this.code = code;
  }
}

function fail(code) { throw new DomainCatalogError(code); }
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function readBounded(file, limit, label) {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}_not_regular`);
    if (stat.size > limit * 4) fail(`${label}_too_large`);
    const bytes = readFileSync(file);
    if (bytes.length > limit * 4) fail(`${label}_too_large`);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail(`${label}_encoding_invalid`); }
    if (text.length > limit) fail(`${label}_too_large`);
    if (text.includes('\0')) fail(`${label}_invalid`);
    return text.replace(/\r\n/g, '\n');
  } catch (error) {
    if (error instanceof DomainCatalogError) throw error;
    fail(`${label}_unavailable`);
  }
}

function knowledgeFile(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\')
    || !path.endsWith('.md') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('knowledge_path_invalid');
  }
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail('knowledge_path_invalid');
  let cursor = root;
  try {
    for (const part of rel.split(sep)) {
      cursor = resolve(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) fail('knowledge_symlink');
    }
    const real = relative(root, realpathSync(target));
    if (!real || real.startsWith(`..${sep}`) || isAbsolute(real)) fail('knowledge_path_invalid');
  } catch (error) {
    if (error instanceof DomainCatalogError) throw error;
    fail('knowledge_unavailable');
  }
  return target;
}

function parseIndex(text) {
  if (!/^# Assistant domain registry\n/.test(text)) fail('index_heading_invalid');
  const domains = [];
  let current = null;
  let field = null;
  for (const line of text.split('\n').slice(1)) {
    if (line.startsWith('## ')) {
      const id = line.slice(3).trim();
      if (!ID.test(id) || id === 'redirect') fail('domain_id_invalid');
      current = { id };
      domains.push(current);
      field = null;
    } else if (line.startsWith('### ')) {
      if (!current) fail('field_without_domain');
      field = FIELDS.get(line.slice(4));
      if (!field) fail('field_unknown');
      if (Object.hasOwn(current, field)) fail('field_duplicate');
      current[field] = '';
    } else if (/^#{1,6}\s/.test(line)) {
      fail('heading_invalid');
    } else if (current) {
      if (field) current[field] += `${line}\n`;
      else if (line.trim()) fail('content_without_field');
    }
  }
  if (!domains.length) fail('registry_empty');
  const ids = new Set();
  const pairs = new Set();
  for (const domain of domains) {
    for (const key of Object.keys(domain)) domain[key] = domain[key].trim();
    if (ids.has(domain.id)) fail('domain_duplicate');
    ids.add(domain.id);
    for (const key of REQUIRED) if (!domain[key]) fail('field_required');
    if (Object.hasOwn(domain, 'action') && !domain.action) fail('action_invalid');
    domain.action ??= domain.id;
    if (!ID.test(domain.action) || domain.action === 'redirect') fail('action_invalid');
    if (!ID.test(domain.sourceId)) fail('source_invalid');
    if (!['retrieval', 'snapshot', 'markdown'].includes(domain.sourceKind)) fail('source_kind_invalid');
    if (Object.hasOwn(domain, 'servedSourceId') && domain.sourceKind !== 'retrieval') fail('served_source_invalid');
    domain.servedSourceId ??= domain.sourceId;
    if (!ID.test(domain.servedSourceId)) fail('served_source_invalid');
    if (Object.hasOwn(domain, 'snapshotFallback') && (domain.sourceKind !== 'retrieval'
      || !['true', 'false'].includes(domain.snapshotFallback))) fail('snapshot_fallback_invalid');
    domain.snapshotFallback = domain.snapshotFallback === 'true';
    if (Object.hasOwn(domain, 'includeCapabilities') && !['true', 'false'].includes(domain.includeCapabilities)) fail('capabilities_invalid');
    domain.includeCapabilities = domain.includeCapabilities === 'true';
    if ((domain.sourceKind === 'markdown') !== Boolean(domain.knowledgePath)) fail('knowledge_binding_invalid');
    if (domain.sourceKind !== 'markdown' && Object.hasOwn(domain, 'knowledgePath')) fail('knowledge_binding_invalid');
    for (const key of ['examples', 'negativeExamples']) {
      const lines = domain[key].split('\n').filter((line) => line.trim());
      if (lines.some((line) => !/^- \S/.test(line))) fail('examples_invalid');
      domain[key] = lines.map((line) => line.slice(2).trim());
    }
    for (const key of ['title', 'capability', 'action', 'sourceId', 'sourceKind', 'servedSourceId', 'knowledgePath']) {
      if (domain[key]?.includes('\n')) fail('scalar_invalid');
    }
    const pair = `${domain.action}\0${domain.sourceId}`;
    if (pairs.has(pair)) fail('route_pair_duplicate');
    pairs.add(pair);
  }
  return domains;
}

/** Deployment data is validated once, before a live question can reach it. */
export function loadDomainCatalog({ indexPath = DEFAULT_DOMAIN_INDEX } = {}) {
  if (typeof indexPath !== 'string' || !indexPath.trim()) fail('index_path_invalid');
  const index = resolve(indexPath);
  const text = readBounded(index, INDEX_LIMIT, 'index');
  let root;
  try { root = realpathSync(dirname(index)); } catch { fail('index_unavailable'); }
  const domains = parseIndex(text);
  const material = new Map();
  const sourceBindings = new Map();
  const digest = createHash('sha256').update(text);
  for (const domain of domains) {
    const binding = `${domain.sourceKind}:${domain.servedSourceId}:${domain.snapshotFallback}:${domain.knowledgePath || ''}`;
    if (sourceBindings.has(domain.sourceId) && sourceBindings.get(domain.sourceId) !== binding) fail('source_binding_conflict');
    sourceBindings.set(domain.sourceId, binding);
    if (domain.sourceKind === 'markdown') {
      const body = readBounded(knowledgeFile(root, domain.knowledgePath), KNOWLEDGE_LIMIT, 'knowledge');
      const match = /^# ([^\n]+)\n+([\s\S]*)$/.exec(body);
      if (!match || !match[1].trim() || !match[2].trim()) fail('knowledge_empty_or_malformed');
      digest.update('\0').update(domain.id).update('\0').update(body);
      material.set(domain.id, freeze({ sourceId: domain.sourceId, entries: [{
        id: `${domain.id}:knowledge`, title: match[1].trim(), content: match[2].trim(),
      }] }));
    }
  }
  freeze(domains);
  const byId = new Map(domains.map((domain) => [domain.id, domain]));
  const byPair = new Map(domains.map((domain) => [`${domain.action}\0${domain.sourceId}`, domain]));
  const route = (domain) => ({ domainId: domain.id, action: domain.action, sourceId: domain.sourceId });
  return Object.freeze({
    domains,
    digest: digest.digest('hex'),
    get(id) { return byId.get(id) || null; },
    routeFor(id) { const domain = byId.get(id); return domain ? route(domain) : null; },
    normalizeRoute(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const hasId = Object.hasOwn(value, 'domainId');
      const hasAction = Object.hasOwn(value, 'action');
      const hasSource = Object.hasOwn(value, 'sourceId');
      if ((hasId && value.domainId === null) || (!hasId && value.action === 'redirect')) {
        if ((hasAction && value.action !== 'redirect') || (hasSource && value.sourceId !== null)) return null;
        if (!hasId && !hasSource) return null;
        return { domainId: null, action: 'redirect', sourceId: null };
      }
      const domain = hasId ? byId.get(value.domainId)
        : (hasAction && hasSource ? byPair.get(`${value.action}\0${value.sourceId}`) : null);
      if (!domain || (hasAction && value.action !== domain.action) || (hasSource && value.sourceId !== domain.sourceId)) return null;
      return route(domain);
    },
    markdownKnowledge(id) {
      if (!byId.has(id)) fail('domain_unknown');
      if (!material.has(id)) fail('domain_knowledge_not_markdown');
      return material.get(id);
    },
  });
}

export const DEFAULT_DOMAIN_CATALOG = loadDomainCatalog();
