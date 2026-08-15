import { ASSISTANT_SOURCE_PACKAGES } from '@aichattg/telegram-core';
import { createOrgSliceKnowledge, withOrgSlice } from './org-slice.mjs';
import { createValueSliceKnowledge, withValueSlice } from './value-slice.mjs';

/**
 * Склейка срезов с пакетом знания, вынесенная из `server.mjs` отдельной чистой
 * функцией. Мотив ровно один: у боевого сервера импорт с побочными эффектами
 * (открывает базу, слушает порт), и проверить в тесте склейку через него
 * нельзя. Функция ничего не открывает и не пишет — её вызывают и сервер, и
 * тест, поэтому проверяется тот же код, который работает в бою.
 *
 * Порядок повторяет лабораторный стенд (`scripts/local-assistant.mjs`):
 * склеенное знание уходит в ответы, а ретривер по урокам строится от БАЗОВОГО
 * адаптера пакета. Иначе поиск по урокам начал бы видеть срезы — а в них нет ни
 * чанков, ни словаря, и искать там нечего.
 */
export function composeKnowledgeSlices(baseKnowledge, {
  orgSlicePath = null,
  valueSlicePath = null,
  createOrgSlice = createOrgSliceKnowledge,
  createValueSlice = createValueSliceKnowledge,
} = {}) {
  const orgSlice = orgSlicePath ? createOrgSlice(orgSlicePath) : null;
  const valueSlice = valueSlicePath ? createValueSlice(valueSlicePath) : null;
  return Object.freeze({
    // Пакет уроков остаётся отдельной ссылкой: ретривер строится от него, а не
    // от склейки, и вызывающий не должен восстанавливать это по памяти.
    baseKnowledge,
    knowledge: withValueSlice(withOrgSlice(baseKnowledge, orgSlice), valueSlice),
    slices: Object.freeze([
      sliceReport('org', ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS, orgSlicePath, orgSlice),
      sliceReport('value', ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE, valueSlicePath, valueSlice),
    ]),
  });
}

/**
 * Отчёт о допуске одного среза. Содержимое среза сюда не попадает намеренно:
 * в лог старта уходит путь, флаг допуска и код причины — этого хватает, чтобы
 * увидеть на проде, принят срез или нет, и не хватает, чтобы утечь материалом.
 */
function sliceReport(name, sourceId, path, slice) {
  return Object.freeze({
    name,
    sourceId,
    // Незаданная переменная — законная конфигурация, а не отказ: сервер тогда
    // работает как раньше, на одном пакете уроков.
    configured: Boolean(path),
    path: path || null,
    admitted: slice?.available === true,
    reason: slice?.reason || null,
    entries: slice?.snapshot?.entries?.length ?? 0,
  });
}

/**
 * Заданный, но не принятый срез роняет старт. Выбор в пользу fail closed, а не
 * «стартуем и пишем в лог»: у нас уже был класс дефекта «тихая пустота» —
 * негабаритный срез проваливался в null, и клиент получал пустой ответ вместо
 * отказа (см. `value_slice_too_large` в value-slice.mjs). Оператор, прописавший
 * путь к срезу, ждёт домен работающим; молча работающий без него бот выглядит
 * исправным и врёт делом — «я про это не знаю» вместо ответа про оплату или
 * пользу. Дефект конфигурации обязан всплыть на запуске процесса, а не на живом
 * вопросе в чате. Отсутствующая переменная под это правило не подпадает: это
 * решение оператора, а не битый файл.
 */
export function assertSlicesAdmitted(slices) {
  for (const slice of slices) {
    if (slice.configured && !slice.admitted) {
      throw new Error(`${slice.name} knowledge slice is configured but was refused (${slice.reason || 'unknown'})`);
    }
  }
  return slices;
}
