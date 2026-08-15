import { existsSync, readFileSync } from 'node:fs';
import { ASSISTANT_SOURCE_PACKAGES } from '@aichattg/telegram-core';

export const VALUE_SLICE_SCHEMA = 'value_slice.v1';

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
 * Ответ о пользе обязан вести на страницу курса, а не пересказывать её:
 * поэтому ссылки среза, не вошедшие в текст, дописываются к записи — модель
 * может цитировать только то, что снимок ей реально показал.
 */
function entryContent(situation) {
  const answer = trimmedString(situation.answer_text);
  if (!answer) return null;
  const links = Array.isArray(situation.links) ? situation.links.map(httpsUrl).filter(Boolean) : [];
  const extra = links.filter((link) => !answer.includes(link));
  return extra.length ? `${answer}\n${extra.join('\n')}` : answer;
}

function normalizeSituation(situation) {
  if (!plainObject(situation)) return null;
  const id = trimmedString(situation.id);
  // Единственный допустимый kind. Чужая запись (procedure/condition) означает,
  // что в файл попал орг-срез, и она отбрасывается, а не «переосмысляется».
  if (!id || trimmedString(situation.kind) !== 'value') return null;
  const content = entryContent(situation);
  if (!content) return null;
  const title = trimmedString(situation.title);
  const canonicalUrl = httpsUrl(situation.source_url)
    || (Array.isArray(situation.links) ? situation.links.map(httpsUrl).find(Boolean) || null : null);
  return Object.freeze({
    id,
    kind: 'value',
    content,
    ...(title == null ? {} : { title }),
    ...(canonicalUrl == null ? {} : { canonicalUrl }),
  });
}

/**
 * Отдаёт value-срез в той же форме, которую уже ждёт `knowledge.forSource()`
 * для v1-источника: снимок с `sourceId` и списком записей. Контракт повторяет
 * орг-срез — меняется только происхождение снимка, рантайм остаётся нетронутым.
 */
export function createValueSliceKnowledge(
  slicePath,
  { exists = existsSync, readFile = readFileSync } = {},
) {
  const path = trimmedString(slicePath);
  if (!path || !exists(path)) return unavailable('value_slice_missing');
  let parsed;
  try { parsed = JSON.parse(readFile(path, 'utf8')); } catch { return unavailable('value_slice_invalid'); }
  if (!plainObject(parsed) || parsed.schema !== VALUE_SLICE_SCHEMA) return unavailable('value_slice_schema_invalid');
  if (!Array.isArray(parsed.situations)) return unavailable('value_slice_invalid');

  const seen = new Set();
  const entries = [];
  for (const situation of parsed.situations) {
    const entry = normalizeSituation(situation);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  if (!entries.length) return unavailable('value_slice_empty');
  // Снимок уходит в ОДИН запрос модели вместе с вопросом и диалогом; лимит
  // входа провайдера — 60k знаков. Негабаритный срез раньше проваливался в
  // молчаливую пустоту (boundedJson → null) — теперь отказ громкий и на входе.
  const totalChars = entries.reduce((sum, entry) => sum + entry.content.length, 0);
  if (totalChars > 50_000) return unavailable('value_slice_too_large');

  return Object.freeze({
    available: true,
    reason: null,
    identity: Object.freeze({ sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE, slicePath: path }),
    package: null,
    snapshot: Object.freeze({
      sourceId: ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE,
      fetchedAt: trimmedString(parsed.fetched_at),
      entries: Object.freeze(entries),
    }),
  });
}

/**
 * Оборачивает уже собранный адаптер знания, подменяя ровно один источник —
 * value. Остальные (включая операционный и содержательный) проходят насквозь:
 * подключение value-среза не должно давать доступ к чужому источнику.
 */
export function withValueSlice(knowledge, valueSlice) {
  if (!valueSlice) return knowledge;
  return Object.freeze({
    forSource(sourceId) {
      if (sourceId === ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE) return valueSlice;
      return knowledge.forSource(sourceId);
    },
    forPackage(sourceId) { return knowledge.forPackage(sourceId); },
  });
}
