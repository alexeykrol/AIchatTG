import { STATE_CONTEXT_INSTRUCTION } from './assistant-working-state.mjs';
import { createHash } from 'node:crypto';
import { DEFAULT_DOMAIN_CATALOG } from './assistant-domains.mjs';
import { composeDomainAnalyzerSpec } from './assistant-domain-routing.mjs';
/**
 * Анализатор запроса — отдельный модуль-диспетчер. Здесь его рантайм-обёртка:
 * спецификация → промпт → один дешёвый вызов → строгий разбор вердикта.
 *
 * Режимы (`config.analyzer.mode`):
 *   off      — модуль не существует для рантайма: ни вызова, ни записи;
 *   observe  — вердикт считается и ЖУРНАЛИРУЕТСЯ, поведение ассистента не
 *              меняется ни на один символ;
 *   dispatch — этап Ф4: в чатах из списка вердикт ЗАМЕНЯЕТ отдельный вызов
 *              модельного роутера — домен и форму ответа задаёт суждение
 *              анализатора через тот же арбитраж §2.3а. Сам адаптер при этом
 *              не меняется ни на строку: чем ход считать — решает он, что с
 *              вердиктом делать — решает рантайм.
 *
 * Наблюдение шло первым сознательно: сначала данные, потом поведение. Режим
 * dispatch включается после наблюдения и только пер-чатно.
 *
 * Отказ анализатора НИКОГДА не отменяет ответ: любой сбой возвращается кодом,
 * а не исключением, и путь ответа идёт дальше нетронутым (в dispatch — откатом
 * на прежний путь роутера, см. runtime.mjs).
 */

import {
  buildAnalyzerUserPayload,
  compileAnalyzerSystemPrompt,
  parseAnalyzerVerdict,
} from './analyzer-spec.mjs';
// Контракт учёта затрат один на весь рантайм и живёт у транспорта. Свой
// нормализатор здесь означал бы две линейки для одного и того же расхода.
import { providerCallUsage } from './provider-adapter.mjs';

export const ANALYZER_MODES = Object.freeze({ OFF: 'off', OBSERVE: 'observe', DISPATCH: 'dispatch' });

function unavailable(code) {
  return Object.freeze({
    enabled: false, mode: ANALYZER_MODES.OFF, reason: code, digest: null,
    appliesTo: () => false,
    analyze: async () => ({ status: 'error', code, usage: providerCallUsage(null) }),
  });
}

/**
 * Накопление уровня по диалогу — детерминированная бухгалтерия, а не суждение
 * модели (та же граница, что в лаборатории): очки уверенности суммируются по
 * КАЖДОМУ уровню, порог берётся из спецификации. Уровни не конкурируют — ход
 * может нести и L1, и L3; состояние диалога — все уровни, взявшие порог.
 */
export function accumulateLevels(observations, spec) {
  const points = spec?.trajectory?.confidence_points || { low: 1, medium: 2, high: 3 };
  const threshold = Number(spec?.trajectory?.level_threshold) || 3;
  const totals = new Map();
  for (const item of observations || []) {
    const hypothesis = item?.level?.hypothesis;
    if (!hypothesis || hypothesis === 'none') continue;
    const gain = Number(points[item.level.confidence]) || 0;
    totals.set(hypothesis, (totals.get(hypothesis) || 0) + gain);
  }
  const reached = [...totals.entries()].filter(([, score]) => score >= threshold).map(([id]) => id);
  reached.sort();
  return { reached, totals: Object.fromEntries(totals), threshold };
}

export function createAnalyzerAdapter({ config, provider, spec, digest = null, domainCatalog = DEFAULT_DOMAIN_CATALOG } = {}) {
  const mode = String(config?.mode || ANALYZER_MODES.OFF);
  if (mode === ANALYZER_MODES.OFF) return unavailable('analyzer_disabled');
  // Неизвестный режим — это выключенный анализатор, а не «как observe»:
  // конфиг валидирует строку при старте, но прямой вызов фабрики обязан
  // отказывать сам, иначе опечатка режима включала бы поведение молча.
  if (mode !== ANALYZER_MODES.OBSERVE && mode !== ANALYZER_MODES.DISPATCH) {
    return unavailable('analyzer_mode_unsupported');
  }
  if (!spec) return unavailable('analyzer_spec_unavailable');
  if (typeof provider?.analyze !== 'function') return unavailable('analyzer_provider_unavailable');
  spec = composeDomainAnalyzerSpec(spec, domainCatalog);
  digest = createHash('sha256').update(JSON.stringify(spec)).digest('hex');

  // Промпт компилируется ОДИН раз на старте: спецификация — данные выката, а не
  // живая настройка. Заодно дефект компиляции падает при старте, а не на
  // первом же вопросе живого человека.
  const system = compileAnalyzerSystemPrompt(spec, { dispatcher: false });
  // Preserve the shared compiler/legacy prompt; only the new Q/A interface
  // needs explicit attribution of the assistant side of its context.
  const dialogueSystem = `${system}\n\nПоле dialogue содержит предыдущие пары question (покупатель) и answer (ассистент). Слова ассистента — контекст разговора, а не утверждения покупателя. Улики по-прежнему берутся только из current_turn.`;
  const chatIds = new Set((config?.chatIds || []).map((id) => String(id)));

  /** Пустой список чатов означает «нигде», а не «везде»: fail closed. */
  function appliesTo(chatId) { return chatIds.has(String(chatId)); }

  /**
   * Расход возвращается при ЛЮБОМ исходе, включая негодный вердикт и отказ
   * провайдера: битый JSON и HTTP-ошибка приходят ПОСЛЕ того, как вызов
   * состоялся, и квитанция с токенами у такой ошибки есть. Списать их в «ничего
   * не потратили» значило бы занижать учёт ровно на самых дорогих ходах — тех,
   * что не дали результата. Локальный отказ до сети (`analyzer_request_invalid`)
   * расхода не имеет, и там все счётчики остаются null.
   */
  async function analyze({ text, previousTexts = [], dialogue = null, workingState = null } = {}) {
    const turnText = typeof text === 'string' ? text.trim() : '';
    if (!turnText) return { status: 'error', code: 'analyzer_request_invalid', usage: providerCallUsage(null) };
    let raw;
    try {
      raw = await provider.analyze({
        system: `${Array.isArray(dialogue) ? dialogueSystem : system}${workingState ? `\n\n${STATE_CONTEXT_INSTRUCTION}` : ''}`,
        input: buildAnalyzerUserPayload(turnText, previousTexts, dialogue, workingState),
      });
    } catch (error) {
      const usage = providerCallUsage(error?.receipt);
      return {
        status: 'error',
        code: String(error?.code || 'analyzer_provider_failed'),
        modelId: usage.modelId,
        usage,
      };
    }
    const usage = providerCallUsage(raw?.receipt);
    const verdict = parseAnalyzerVerdict(raw?.text, spec, turnText);
    if (verdict.status !== 'ok') {
      return {
        status: 'invalid', error: verdict.error, raw: verdict.raw,
        modelId: raw?.modelId || usage.modelId, usage,
      };
    }
    return { status: 'ok', verdict, modelId: raw?.modelId || usage.modelId, usage };
  }

  return Object.freeze({ enabled: true, mode, reason: null, digest,
    domainCatalogDigest: domainCatalog.digest,
    domainPrimacyRules: spec.routing.main_topic_primacy.rules, appliesTo, analyze });
}
