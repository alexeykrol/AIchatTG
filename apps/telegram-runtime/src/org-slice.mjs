import { existsSync, readFileSync } from 'node:fs';
import { ASSISTANT_SOURCE_PACKAGES } from '@aichattg/telegram-core';

export const ORG_SLICE_SCHEMA = 'org_slice.v1';

/**
 * Условия (цены, тарифы, размеры скидок, сроки возврата) формулирует сайт, а не
 * бот: у сайта есть Terms, у бота нет. Поэтому запись kind='condition' отдаётся
 * как есть — отсылкой со ссылкой, — а любая цифра в ней означает, что срез
 * собран неверно, и такая запись до модели не доходит.
 */
const CONDITION_FIGURE = /(?:\d|процент|%)/u;

function unavailable(reason) {
  return Object.freeze({ available: false, reason, snapshot: null, identity: null, package: null });
}

function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function trimmedString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function httpsUrl(value) {
  const raw = trimmedString(value);
  if (!raw) return null;
  try { return new URL(raw).protocol === 'https:' ? raw : null; } catch { return null; }
}

/**
 * Текст процедуры отдаётся как есть, а у условия к отсылке добавляются только
 * ссылки: читателю нужна страница, где условие названо, а не пересказ.
 */
function entryContent(situation) {
  const answer = trimmedString(situation.answer_text);
  if (!answer) return null;
  if (situation.kind !== 'condition') return answer;
  const links = Array.isArray(situation.links) ? situation.links.map(httpsUrl).filter(Boolean) : [];
  const extra = links.filter((link) => !answer.includes(link));
  return extra.length ? `${answer}\n${extra.join('\n')}` : answer;
}

function normalizeSituation(situation) {
  if (!plainObject(situation)) return null;
  const id = trimmedString(situation.id);
  const kind = trimmedString(situation.kind);
  if (!id || (kind !== 'procedure' && kind !== 'condition')) return null;
  const content = entryContent(situation);
  if (!content) return null;
  // Инвариант владельца: условие без цифр. Нарушение — дефект среза, и запись
  // отбрасывается, а не «чинится» пересказом.
  if (kind === 'condition' && CONDITION_FIGURE.test(content.replace(/https?:\/\/\S+/gu, ''))) return null;
  const title = trimmedString(situation.title);
  const canonicalUrl = httpsUrl(situation.source_url)
    || (Array.isArray(situation.links) ? situation.links.map(httpsUrl).find(Boolean) || null : null);
  return Object.freeze({
    id,
    kind,
    content,
    ...(title == null ? {} : { title }),
    ...(canonicalUrl == null ? {} : { canonicalUrl }),
  });
}

/**
 * Отдаёт орг-срез в той же форме, которую уже ждёт `knowledge.forSource()` для
 * v1-источника: снимок с `sourceId` и списком записей. Контракт не меняется —
 * меняется только происхождение снимка, поэтому рантайм остаётся нетронутым.
 */
export function createOrgSliceKnowledge(
  slicePath,
  { exists = existsSync, readFile = readFileSync } = {},
) {
  const path = trimmedString(slicePath);
  if (!path || !exists(path)) return unavailable('org_slice_missing');
  let parsed;
  try { parsed = JSON.parse(readFile(path, 'utf8')); } catch { return unavailable('org_slice_invalid'); }
  if (!plainObject(parsed) || parsed.schema !== ORG_SLICE_SCHEMA) return unavailable('org_slice_schema_invalid');
  if (!Array.isArray(parsed.situations)) return unavailable('org_slice_invalid');

  const seen = new Set();
  const entries = [];
  for (const situation of parsed.situations) {
    const entry = normalizeSituation(situation);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  if (!entries.length) return unavailable('org_slice_empty');

  return Object.freeze({
    available: true,
    reason: null,
    identity: Object.freeze({ sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS, slicePath: path }),
    package: null,
    snapshot: Object.freeze({
      sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS,
      fetchedAt: trimmedString(parsed.fetched_at),
      entries: Object.freeze(entries),
    }),
  });
}

/**
 * Оборачивает уже собранный адаптер знания, подменяя ровно один источник —
 * операционный. Остальные (включая содержательный пакет) проходят насквозь:
 * подключение орг-среза не должно давать доступ к чужому источнику.
 */
export function withOrgSlice(knowledge, orgSlice) {
  if (!orgSlice) return knowledge;
  return Object.freeze({
    forSource(sourceId) {
      if (sourceId === ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS) return orgSlice;
      return knowledge.forSource(sourceId);
    },
    forPackage(sourceId) { return knowledge.forPackage(sourceId); },
  });
}
