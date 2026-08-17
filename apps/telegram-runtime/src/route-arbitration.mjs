/**
 * Арбитраж слоёв маршрута — правило §2.3а спецификации анализатора, читаемое
 * ИЗ ДАННЫХ (`analyzer-spec.json` → `routing.arbitration`, `routing.map`,
 * `hints`), а не написанное здесь заново прозой.
 *
 * Почему не два `if`-а в маршрутизаторе, как было. Прежняя формулировка
 * звучала как «хинт сильнее модели», то есть как СТАРШИНСТВО СЛОЯ, и в этом
 * виде она противоречила цели «домен выбирает суждение». Владелец снял
 * противоречие подъёмом на продуктовый уровень: старшинства слоёв не
 * существует — существует недопустимый исход для человека. Отсюда три
 * правила, и все три живут в данных вместе с исходом, из которого выведены:
 *
 *   1. `one_voice_is_enough` — домен назначает ОДИН голос: сработал детектор →
 *      туда; детектор молчит, суждение назвало → туда.
 *      Недопустимый исход: ответ не в той форме (содержание вместо ценности).
 *   2. `refusal_needs_universal_silence` — отказ законен, только если домен не
 *      назвал НИ ОДИН слой.
 *      Недопустимый исход: ложное «не уполномочен» на покрытой теме — тот же
 *      класс, что молчание.
 *   3. `conflict_goes_to_proven_layer` — оба назвали разное → берёт слой с
 *      доказанной на голде точностью (сегодня детектор), а расхождение
 *      ЗАПИСЫВАЕТСЯ как долг детектора.
 *      Недопустимый исход: тихий проигрыш замеренной точности.
 *
 * **Молчание слоя голосом не является** — ни в одну сторону. Это и есть та
 * точка, где прежнее чтение ошибалось: молчащий детектор трактовался как
 * аргумент против модели, и уверенно названный судьёй домен мог сползти в
 * содержание по умолчанию.
 *
 * Поведение бота этот модуль не меняет: на сегодняшних данных он выдаёт
 * ровно те же маршруты, что прежние два `if`-а (тест равенства — в
 * `test/route-arbitration.test.mjs`). Меняется место, где правило живёт:
 * данные вместо прозы, и спор слоёв больше не проглатывается молча.
 */

import { RUNTIME_ANALYZER_SPEC_PATH, runtimeAnalyzerSpec } from './analyzer-spec.mjs';

/**
 * Правила, которые исполняет ЭТОТ код. Список сверяется со спецификацией при
 * сборке арбитра: если данные объявят другой набор (Ф4 переименует, добавит
 * четвёртое), сборка упадёт вместо того, чтобы тихо исполнять вчерашнее
 * правило по свежим данным.
 */
const IMPLEMENTED_RULES = Object.freeze([
  'one_voice_is_enough',
  'refusal_needs_universal_silence',
  'conflict_goes_to_proven_layer',
]);

const DEBT_CONFLICT = 'domain_conflict';
const DEBT_REFUSAL_OVERRIDDEN = 'model_refusal_overridden';

/**
 * Условия правил первенства, которые этот код умеет проверять. Совпадает с
 * `KNOWN_CONDITIONS` лабораторного исполнителя (`analyzer/routing.py`): данные,
 * объявившие условие, которого код не исполняет, обязаны ронять сборку — иначе
 * правило исполнится наполовину, и это будет выглядеть как каприз модели.
 */
const KNOWN_PRIMACY_CONDITIONS = Object.freeze(['level', 'intent', 'topic_first', 'topic_listed']);

export class RouteArbitrationSpecError extends Error {
  constructor(code) {
    super(`route arbitration spec invalid: ${code}`);
    this.name = 'RouteArbitrationSpecError';
    this.code = code;
  }
}

function fail(code) { throw new RouteArbitrationSpecError(code); }

export function createRouteArbiter(spec) {
  const routing = spec?.routing;
  const arbitration = routing?.arbitration;
  const hints = spec?.hints;
  if (!routing?.map || !arbitration || !hints?.map || !Array.isArray(hints.order)) fail('routing_incomplete');

  // Код реализует ровно то чтение §2.3а, в котором молчание не голос. Другое
  // чтение здесь не реализовано, поэтому оно и не допускается молча.
  if (arbitration.silence_is_not_a_vote !== true) fail('silence_rule_unsupported');

  const declared = new Set((arbitration.rules || []).map((rule) => rule?.id));
  for (const id of IMPLEMENTED_RULES) if (!declared.has(id)) fail(`rule_missing:${id}`);
  for (const id of declared) if (!IMPLEMENTED_RULES.includes(id)) fail(`rule_unimplemented:${id}`);

  const debtKinds = arbitration.debt_ledger?.kinds || {};
  if (!debtKinds[DEBT_CONFLICT] || !debtKinds[DEBT_REFUSAL_OVERRIDDEN]) fail('debt_kinds_missing');

  const refusalTopic = arbitration.refusal_topic;
  if (!routing.map[refusalTopic]) fail('refusal_topic_unknown');
  const provenLayer = arbitration.proven_layer;
  if (provenLayer !== 'detector' && provenLayer !== 'model') fail('proven_layer_unknown');

  // Действие модели → домен. Обратная проекция `routing.map`; неоднозначность
  // (одно действие в двух доменах) сделала бы вывод о домене недоказуемым.
  const topicOfAction = new Map();
  for (const [topic, entry] of Object.entries(routing.map)) {
    for (const action of entry.actions) {
      if (topicOfAction.has(action)) fail(`action_ambiguous:${action}`);
      topicOfAction.set(action, topic);
    }
  }

  // Голос детектора: имя хинта → домен, действие и пакет. Приоритет между
  // детекторами — `hints.order` (операционный раньше value: деньги, доступ и
  // документы сильнее вопроса о пользе).
  const detectorVotes = hints.order.map((name) => {
    const rule = hints.map[name];
    if (!rule) fail(`hint_unknown:${name}`);
    const entry = routing.map[rule.topic];
    if (!entry) fail(`hint_topic_unknown:${rule.topic}`);
    if (!entry.actions.includes(rule.action)) fail(`hint_action_mismatch:${name}`);
    if ((entry.sourceId ?? null) !== (rule.sourceId ?? null)) fail(`hint_source_mismatch:${name}`);
    return Object.freeze({
      name, topic: rule.topic, action: rule.action, sourceId: rule.sourceId ?? null, detector: rule.detector || null,
    });
  });

  function detectorVote(firedHints) {
    return detectorVotes.find((vote) => firedHints?.[vote.name] === true) || null;
  }

  // Правила первенства главной темы. Пустая секция законна — правил нет,
  // главной остаётся первая тема вердикта.
  const levelIds = new Set((spec?.levels?.vocabulary || []).map((item) => item?.id));
  const intentIds = new Set((spec?.intents?.vocabulary || []).map((item) => item?.id));
  const primacyRules = Object.freeze((routing.main_topic_primacy?.rules || []).map((rule) => {
    const id = rule?.id;
    if (!id) fail('primacy_rule_without_id');
    // Правило без недопустимого исхода — правило «от устройства». Ровно тот
    // класс, который запрещён продуктовым первенством: спор реализаций,
    // решённый на своём уровне.
    if (!rule.unacceptable_outcome) fail(`primacy_without_outcome:${id}`);
    const when = rule.when;
    if (!when || typeof when !== 'object' || Object.keys(when).length === 0) fail(`primacy_empty_when:${id}`);
    for (const [key, values] of Object.entries(when)) {
      if (!KNOWN_PRIMACY_CONDITIONS.includes(key)) fail(`primacy_condition_unimplemented:${id}.${key}`);
      if (!Array.isArray(values) || values.length === 0) fail(`primacy_condition_empty:${id}.${key}`);
      const dictionary = key === 'level' ? levelIds
        : key === 'intent' ? intentIds
          : new Set(Object.keys(routing.map));
      for (const value of values) if (!dictionary.has(value)) fail(`primacy_value_unknown:${id}.${key}=${value}`);
    }
    const target = rule.then?.main_topic;
    if (!routing.map[target]) fail(`primacy_target_unknown:${id}`);
    return Object.freeze({ ...rule, when: Object.freeze({ ...when }) });
  }));

  /**
   * Детерминированная проекция §2.2 для режима dispatch (Ф4): главная тема
   * вердикта → {action, sourceId}. Пакет задаёт `routing.map`; действием идёт
   * ПЕРВОЕ действие домена — эталон поведения задан лабораторным диспетчером
   * (`session.py`: `(route.get("actions") or ["teach"])[0]`), и расходиться с
   * ним значило бы иметь два разных отображения одного контракта.
   *
   * Различение teach/navigate внутри content остаётся суждению: код не
   * выводит его из текста вопроса. Сегодняшний контракт вердикта этого
   * различения не несёт, поэтому content уходит действием по умолчанию;
   * расширение контракта — правка данных с замером, не решение на месте.
   *
   * Неизвестная тема — null, а не догадка: вызывающий обязан деградировать к
   * прежнему роутеру. Для валидной спецификации случай недостижим — загрузка
   * требует маршрут на каждую тему словаря (`analyzer-spec.mjs`).
   */
  function routeOfTopic(topic) {
    const entry = routing.map[topic];
    if (!entry) return null;
    return Object.freeze({ action: entry.actions[0], sourceId: entry.sourceId ?? null });
  }

  /**
   * Главная тема вердикта — до проекции §2.2. До правил первенства главной
   * молча считался `topics[0]`, то есть порядок, названный моделью; на
   * пилюльном классе это давало измеренный дефект (уровень распознан верно,
   * форма ответа выбиралась предметная — то есть подтверждала посылку
   * «учиться не надо»).
   *
   * Правило читается ИЗ ДАННЫХ (`routing.main_topic_primacy`) — те же данные
   * исполняет лаборатория (`analyzer/routing.py`). Два потребителя одного
   * правила обязаны читать один файл, иначе это два разных правила.
   *
   * Место в цепочке: главная тема → голос суждения → арбитраж §2.3а. Правило
   * правит голос СУЖДЕНИЯ и потому не может перебить сработавший детектор.
   *
   * Пустая секция обязана не менять ни одного маршрута — это контракт
   * обратной совместимости, и он закреплён тестом.
   */
  function mainTopic({ topics = [], level = null, intent = null } = {}) {
    const list = Array.isArray(topics) ? topics.filter((t) => typeof t === 'string') : [];
    if (list.length === 0) return Object.freeze({ topic: null, applied: null });
    for (const rule of primacyRules) {
      const when = rule.when || {};
      if (when.level && !when.level.includes(level)) continue;
      if (when.intent && !when.intent.includes(intent)) continue;
      if (when.topic_first && !when.topic_first.includes(list[0])) continue;
      if (when.topic_listed && !when.topic_listed.some((t) => list.includes(t))) continue;
      const target = rule.then.main_topic;
      if (target === list[0]) continue;              // правило уже исполнено
      return Object.freeze({
        topic: target,
        applied: Object.freeze({
          rule: rule.id, from: list[0], to: target,
          unacceptableOutcome: rule.unacceptable_outcome,
        }),
      });
    }
    return Object.freeze({ topic: list[0], applied: null });
  }

  /**
   * Один ход: собрать голоса, применить правила, вернуть маршрут и — если был
   * спор — долг детектора. Чистая функция: журналирование не её дело.
   */
  function arbitrate({ hints: firedHints = {}, route = null } = {}) {
    const detector = detectorVote(firedHints);
    const modelTopic = route && topicOfAction.has(route.action) ? topicOfAction.get(route.action) : null;
    const votes = { detector: detector?.topic || null, model: modelTopic };

    if (!detector) {
      // Правило 1: детектор молчит — домен назначает суждение. Молчание не
      // голос, поэтому названный судьёй домен НЕ сползает в содержание по
      // умолчанию. Правило 2: отказ здесь законен ровно потому, что домена не
      // назвал никто — суждение назвало «вне корпуса».
      const refusal = modelTopic === refusalTopic;
      return Object.freeze({
        route,
        topic: modelTopic,
        source: modelTopic ? 'model' : 'none',
        votes,
        refusalLegal: refusal,
        overridden: false,
        debt: null,
      });
    }

    // Детектор высказался. Спор возможен только с ДРУГИМ доменом; совпадение
    // спором не является, и отсутствие суждения — тоже (молчание не голос).
    const conflict = Boolean(modelTopic) && modelTopic !== detector.topic;
    const winner = conflict && provenLayer === 'model'
      ? { topic: modelTopic, action: route.action, sourceId: route.sourceId ?? null }
      : detector;
    const keepsModelAction = routing.map[winner.topic].actions.includes(route?.action);
    const decided = keepsModelAction
      ? { action: route.action, sourceId: route.sourceId ?? null }
      : { action: winner.action, sourceId: winner.sourceId ?? null };

    return Object.freeze({
      route: decided,
      topic: winner.topic,
      source: conflict ? provenLayer : 'detector',
      votes,
      // Отказ на хинтованном вопросе незаконен по правилу 2: домен назван.
      refusalLegal: false,
      overridden: decided.action !== route?.action || (decided.sourceId ?? null) !== (route?.sourceId ?? null),
      debt: conflict ? Object.freeze({
        kind: modelTopic === refusalTopic ? DEBT_REFUSAL_OVERRIDDEN : DEBT_CONFLICT,
        detector: detector.topic,
        detectorName: detector.detector,
        model: modelTopic,
        modelAction: route.action,
        resolvedTo: winner.topic,
        resolvedBy: provenLayer,
      }) : null,
    });
  }

  return Object.freeze({
    arbitrate, routeOfTopic, mainTopic, refusalTopic, provenLayer,
    rules: IMPLEMENTED_RULES, primacyRules,
  });
}

/**
 * Арбитр из спецификации, поехавшей вместе с образом. Как и промпт роутера,
 * собирается на загрузке модуля: дефект данных обязан ронять старт, а не
 * приходить к человеку тишиной в ответ на его вопрос.
 */
const SHIPPED = runtimeAnalyzerSpec();
if (!SHIPPED.valid) {
  throw new Error(`route arbitration unavailable: ${SHIPPED.code} (${RUNTIME_ANALYZER_SPEC_PATH})`);
}
export const ROUTE_ARBITER = createRouteArbiter(SHIPPED.spec);
