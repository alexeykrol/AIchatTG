/**
 * Арбитраж слоёв маршрута (ANALYZER-SPEC §2.3а), исполняемый из данных.
 *
 * Главный контракт файла — НЕ «арбитр работает», а «арбитр решает ровно то же,
 * что решали прежние два `if`-а». Этап Ф3 переносит правило из прозы в код,
 * читающий спецификацию, и не имеет права по дороге изменить хоть один
 * маршрут: изменение поведения, приехавшее вместе с рефакторингом, невозможно
 * ни отличить от улучшения, ни откатить отдельно.
 *
 * Второй контракт — молчание слоя голосом не является. Именно здесь прежнее
 * чтение ошибалось: молчащий детектор трактовался как аргумент против
 * суждения, и уверенно названный доменом ответ мог сползти в содержание.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_ROLE_ACTIONS,
  ASSISTANT_SOURCE_PACKAGES,
} from '@aichattg/telegram-core';
import { loadAnalyzerSpec, runtimeAnalyzerSpec } from '../src/analyzer-spec.mjs';
import {
  ROUTE_ARBITER,
  RouteArbitrationSpecError,
  createRouteArbiter,
} from '../src/route-arbitration.mjs';

const SPEC = runtimeAnalyzerSpec();
const NO_HINTS = { operations: false, value: false, pill: false };

function route(action, sourceId) { return { action, sourceId }; }

/**
 * Прежняя реализация, снятая с боевого кода до этапа Ф3 (`runtime.mjs`,
 * два `if`-а плюс обработка redirect). Она остаётся здесь эталоном сравнения:
 * пока таблица ниже совпадает, «поведение бота не меняется» — проверенное
 * утверждение, а не намерение.
 */
function legacyRoute(hints, initial) {
  let result = initial;
  if (hints.operations && result.action !== ASSISTANT_ROLE_ACTIONS.SUPPORT) {
    result = route(ASSISTANT_ROLE_ACTIONS.SUPPORT, ASSISTANT_SOURCE_PACKAGES.COURSE_OPERATIONS);
  }
  if (hints.value && result.action !== ASSISTANT_ROLE_ACTIONS.ADVISE) {
    result = route(ASSISTANT_ROLE_ACTIONS.ADVISE, ASSISTANT_SOURCE_PACKAGES.COURSE_VALUE);
  }
  return result;
}

const ALL_ROUTES = [
  route('teach', 'course-content-v1'),
  route('navigate', 'course-content-v1'),
  route('support', 'course-operations-v1'),
  route('advise', 'course-value-v1'),
  route('redirect', null),
];
// Детекторы взаимно исключают друг друга по построению (`assistantQuestionHints`:
// value считается только при молчащем операционном), поэтому пара «оба сработали»
// в таблицу не входит — её не бывает.
const ALL_HINTS = [
  { operations: false, value: false, pill: false },
  { operations: true, value: false, pill: false },
  { operations: false, value: true, pill: false },
  { operations: false, value: true, pill: true },
];

test('the arbiter decides exactly what the two legacy ifs decided', () => {
  for (const hints of ALL_HINTS) {
    for (const initial of ALL_ROUTES) {
      const decided = ROUTE_ARBITER.arbitrate({ hints, route: initial });
      assert.deepEqual(decided.route, legacyRoute(hints, initial),
        `хинты ${JSON.stringify(hints)} + ${initial.action}`);
    }
  }
});

// Правило 1. Одного голоса достаточно. Недопустимый исход, из которого правило
// выведено: ответ не в той форме — содержание вместо ценности.
test('a silent detector is not a vote: the domain the judgement named survives', () => {
  for (const initial of ALL_ROUTES) {
    const decided = ROUTE_ARBITER.arbitrate({ hints: NO_HINTS, route: initial });
    assert.deepEqual(decided.route, initial, 'молчание детектора не переписывает маршрут');
    assert.equal(decided.overridden, false);
    assert.equal(decided.debt, null, 'спора не было — долга нет');
  }
  const advised = ROUTE_ARBITER.arbitrate({ hints: NO_HINTS, route: route('advise', 'course-value-v1') });
  assert.equal(advised.topic, 'value');
  assert.equal(advised.source, 'model', 'домен назвало суждение, и он остаётся за ним');
});

// Правило 2. Отказ законен, только если домен не назвал НИ ОДИН слой.
// Недопустимый исход: ложное «не уполномочен» на покрытой теме — тот же класс,
// что молчание, только вежливее.
test('a refusal is legal only when no layer named a domain', () => {
  const alone = ROUTE_ARBITER.arbitrate({ hints: NO_HINTS, route: route('redirect', null) });
  assert.equal(alone.refusalLegal, true);
  assert.equal(alone.route.action, 'redirect');

  // Живой прогон skep-10: пилюльный ход «пусть ваш ИИ сам всё соберёт» —
  // ядро домена ценности, а роутер отправил его в redirect.
  const overridden = ROUTE_ARBITER.arbitrate({
    hints: { operations: false, value: true, pill: true }, route: route('redirect', null),
  });
  assert.equal(overridden.refusalLegal, false);
  assert.deepEqual(overridden.route, route('advise', 'course-value-v1'));
  assert.equal(overridden.debt.kind, 'model_refusal_overridden');
});

// Правило 3. Спор разрешается слоем с доказанной на голде точностью, но
// расхождение ПИШЕТСЯ. Недопустимый исход: тихий проигрыш замеренной точности.
test('a domain conflict is resolved by the proven layer and recorded as detector debt', () => {
  const decided = ROUTE_ARBITER.arbitrate({
    hints: { operations: true, value: false, pill: false }, route: route('teach', 'course-content-v1'),
  });
  assert.deepEqual(decided.route, route('support', 'course-operations-v1'));
  assert.equal(decided.source, 'detector');
  assert.deepEqual(decided.votes, { detector: 'operations', model: 'content' });
  assert.deepEqual(decided.debt, {
    kind: 'domain_conflict',
    detector: 'operations',
    detectorName: 'isCourseOperationsSupportQuestion',
    model: 'content',
    modelAction: 'teach',
    resolvedTo: 'operations',
    resolvedBy: 'detector',
  });

  // Согласие спором не является: одинаковый домен долга не порождает, иначе
  // журнал наполнится шумом и настоящий пробел детектора в нём утонет.
  const agreed = ROUTE_ARBITER.arbitrate({
    hints: { operations: true, value: false, pill: false }, route: route('support', 'course-operations-v1'),
  });
  assert.equal(agreed.debt, null);
  assert.equal(agreed.overridden, false);
});

// Приоритет детекторов — данные (`hints.order`), а не порядок строк в коде:
// деньги, доступ и документы сильнее вопроса о пользе.
test('detector priority comes from the spec order', () => {
  const decided = ROUTE_ARBITER.arbitrate({
    hints: { operations: true, value: true, pill: false }, route: route('teach', 'course-content-v1'),
  });
  assert.deepEqual(decided.route, route('support', 'course-operations-v1'));
  assert.deepEqual(SPEC.spec.hints.order, ['operations', 'value']);
});

// Тот же арбитр на перевёрнутых данных обязан решать иначе — иначе «правило
// живёт в данных» было бы декорацией поверх зашитой логики.
test('flipping the proven layer in the data flips the winner of a conflict', () => {
  const flipped = JSON.parse(JSON.stringify(SPEC.spec));
  flipped.routing.arbitration.proven_layer = 'model';
  const arbiter = createRouteArbiter(flipped);
  const decided = arbiter.arbitrate({
    hints: { operations: true, value: false, pill: false }, route: route('teach', 'course-content-v1'),
  });
  assert.deepEqual(decided.route, route('teach', 'course-content-v1'));
  assert.equal(decided.source, 'model');
  assert.equal(decided.debt.resolvedBy, 'model');
});

// ── Отображение §2.2 для режима dispatch (Ф4) ───────────────────────────────

// Детерминированная проекция «главная тема вердикта → {action, sourceId}».
// Пакет задаёт routing.map; действием идёт первое действие домена — эталон
// поведения задан лабораторным диспетчером (session.py). Различение
// teach/navigate внутри content остаётся суждению: код не выводит его из
// текста, а сегодняшний контракт вердикта его не несёт.
test('the §2.2 projection maps every vocabulary topic and invents nothing', () => {
  assert.deepEqual({ ...ROUTE_ARBITER.routeOfTopic('content') }, { action: 'teach', sourceId: 'course-content-v1' });
  assert.deepEqual({ ...ROUTE_ARBITER.routeOfTopic('value') }, { action: 'advise', sourceId: 'course-value-v1' });
  assert.deepEqual({ ...ROUTE_ARBITER.routeOfTopic('operations') }, { action: 'support', sourceId: 'course-operations-v1' });
  assert.deepEqual({ ...ROUTE_ARBITER.routeOfTopic('out_of_corpus') }, { action: 'redirect', sourceId: null });
  // Неизвестная тема — null, не догадка: вызывающий деградирует к роутеру.
  assert.equal(ROUTE_ARBITER.routeOfTopic('nonsense'), null);
  // Полнота по словарю: каждая тема спецификации отображается. Для валидной
  // спеки это гарантировано загрузкой (см. тест ниже), здесь — фактом.
  for (const topic of SPEC.spec.topics.vocabulary) {
    assert.ok(ROUTE_ARBITER.routeOfTopic(topic.id), `тема ${topic.id} без маршрута`);
  }
});

// Данные, объявляющие правило, которого код не исполняет, — худший вид
// расхождения: спецификация выглядит применённой, а применена вчерашняя.
test('the arbiter fails closed when the data declares rules it does not implement', () => {
  const renamed = JSON.parse(JSON.stringify(SPEC.spec));
  renamed.routing.arbitration.rules[0].id = 'one_voice_is_enough_v2';
  assert.throws(() => createRouteArbiter(renamed), RouteArbitrationSpecError);

  const silent = JSON.parse(JSON.stringify(SPEC.spec));
  silent.routing.arbitration.silence_is_not_a_vote = false;
  assert.throws(() => createRouteArbiter(silent), /silence_rule_unsupported/u);

  const ambiguous = JSON.parse(JSON.stringify(SPEC.spec));
  ambiguous.routing.map.value.actions = ['advise', 'teach'];
  assert.throws(() => createRouteArbiter(ambiguous), /action_ambiguous:teach/u);

  const mismatched = JSON.parse(JSON.stringify(SPEC.spec));
  mismatched.hints.map.value.sourceId = 'course-content-v1';
  assert.throws(() => createRouteArbiter(mismatched), /hint_source_mismatch:value/u);
});

// Спецификация без маршрутной части не даёт ни промпта роутера, ни арбитража.
// Она обязана отвергаться при загрузке: неисполнимый маршрут — это отсутствие
// ответа у всех, и он должен быть виден как упавший старт, а не как тишина.
test('a spec without a compilable routing section is refused at load', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = mkdtempSync(join(tmpdir(), 'aichattg-routing-'));
  try {
    const noPrompt = join(folder, 'no-prompt.json');
    const stripped = JSON.parse(JSON.stringify(SPEC.spec));
    delete stripped.routing.router_prompt;
    writeFileSync(noPrompt, JSON.stringify(stripped));
    assert.equal(loadAnalyzerSpec(noPrompt).code, 'analyzer_spec_router_prompt_invalid');

    const noArbitration = join(folder, 'no-arbitration.json');
    const withoutArbitration = JSON.parse(JSON.stringify(SPEC.spec));
    delete withoutArbitration.routing.arbitration;
    writeFileSync(noArbitration, JSON.stringify(withoutArbitration));
    assert.equal(loadAnalyzerSpec(noArbitration).code, 'analyzer_spec_routing_invalid');

    // Домен, известный коду и не названный модели, — маршрут, который модель
    // никогда не выберет.
    const unlisted = join(folder, 'unlisted.json');
    const missingDomain = JSON.parse(JSON.stringify(SPEC.spec));
    missingDomain.routing.router_prompt.domain_order = ['content', 'operations', 'value'];
    writeFileSync(unlisted, JSON.stringify(missingDomain));
    assert.equal(loadAnalyzerSpec(unlisted).code, 'analyzer_spec_router_prompt_invalid');

    // Тема, которую вердикт может назвать, а диспетчер не может отправить, —
    // тихая потеря маршрута в режиме dispatch. Дефект данных роняет загрузку,
    // а не ход живого человека.
    const orphan = join(folder, 'orphan-topic.json');
    const withOrphan = JSON.parse(JSON.stringify(SPEC.spec));
    withOrphan.topics.vocabulary = [
      ...withOrphan.topics.vocabulary,
      { id: 'orphan', label: 'сирота', theme: 'тема без маршрута' },
    ];
    writeFileSync(orphan, JSON.stringify(withOrphan));
    assert.equal(loadAnalyzerSpec(orphan).code, 'analyzer_spec_routing_invalid');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

// ── Голд-190: ноль ложных «не уполномочен» ──────────────────────────────────

// Приёмка этапа, посчитанная кодом, а не заявленная словами. 190 заведомо
// содержательных вопросов проходят через арбитраж: ни один не имеет права
// превратиться в отказ и ни один — сменить домен. Ложное «не уполномочен» на
// покрытой теме относится к тому же классу, что молчание: человек уходит с
// ответом «это не ко мне» на вопрос, ради которого бот и существует.
//
// Замеряется здесь слой КОДА. Промпт роутера этап Ф3 оставил побайтно прежним
// (см. `analyzer.test.mjs`), поэтому слой суждения не мог измениться, и общий
// вывод «согласие не хуже сегодняшнего» держится на двух проверенных половинах.
test('the gold set of content questions produces zero false refusals through arbitration', async (t) => {
  const { existsSync, readFileSync } = await import('node:fs');
  const core = await import('@aichattg/telegram-core');
  const goldPath = process.env.AICHATTG_CONTENT_GOLD_PATH
    || '/Users/alexeykrolmini/Code/allcourses/code/data/knowledge/packages/ai-140310bf9472/gold/ai.gold.jsonl';
  if (!existsSync(goldPath)) {
    t.skip(`gold set is not available at ${goldPath}`);
    return;
  }
  const questions = readFileSync(goldPath, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line).question).filter(Boolean);
  assert.ok(questions.length >= 150, `gold set looks truncated: ${questions.length} questions`);

  const refused = [];
  const rerouted = [];
  for (const question of questions) {
    const operations = core.isCourseOperationsSupportQuestion(question);
    const hints = { operations, value: !operations && core.isCourseValueQuestion(question), pill: core.isNoTimeToLearnSignal(question) };
    const decided = ROUTE_ARBITER.arbitrate({ hints, route: route('teach', 'course-content-v1') });
    if (decided.route.action === 'redirect' || decided.refusalLegal) refused.push(question);
    if (decided.topic !== 'content') rerouted.push(`${question} → ${decided.topic}`);
  }
  assert.deepEqual(refused, [], `ложных отказов: ${refused.length}`);
  assert.deepEqual(rerouted, [], `угнанных из содержания: ${rerouted.length}`);
});

// ── Голд-190 через dispatch-путь (приёмка Ф4) ───────────────────────────────

// Тот же голд, но маршрут рождается так, как рождается в режиме dispatch:
// вердикт-заглушка с главной темой content → детерминированное отображение
// §2.2 (routeOfTopic) → тот же арбитр. Ни один содержательный вопрос не имеет
// права превратиться в отказ («не уполномочен») или сменить домен. Слой
// суждения здесь заглушен намеренно: приёмка меряет слой КОДА — отображение и
// арбитраж, — а точность самого вердикта замеряется лабораторией на своём
// голде (0.83–0.84 по осям).
test('the gold set through the dispatch mapping yields zero refusals and zero domain thefts', async (t) => {
  const { existsSync, readFileSync } = await import('node:fs');
  const core = await import('@aichattg/telegram-core');
  const goldPath = process.env.AICHATTG_CONTENT_GOLD_PATH
    || '/Users/alexeykrolmini/Code/allcourses/code/data/knowledge/packages/ai-140310bf9472/gold/ai.gold.jsonl';
  if (!existsSync(goldPath)) {
    t.skip(`gold set is not available at ${goldPath}`);
    return;
  }
  const questions = readFileSync(goldPath, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line).question).filter(Boolean);
  assert.ok(questions.length >= 150, `gold set looks truncated: ${questions.length} questions`);

  const mapped = ROUTE_ARBITER.routeOfTopic('content');
  assert.deepEqual({ ...mapped }, { action: 'teach', sourceId: 'course-content-v1' });
  const refused = [];
  const rerouted = [];
  for (const question of questions) {
    const operations = core.isCourseOperationsSupportQuestion(question);
    const hints = { operations, value: !operations && core.isCourseValueQuestion(question), pill: core.isNoTimeToLearnSignal(question) };
    const decided = ROUTE_ARBITER.arbitrate({ hints, route: mapped });
    if (decided.route.action === 'redirect' || decided.refusalLegal) refused.push(question);
    if (decided.topic !== 'content') rerouted.push(`${question} → ${decided.topic}`);
  }
  assert.deepEqual(refused, [], `ложных «не уполномочен»: ${refused.length}`);
  assert.deepEqual(rerouted, [], `украденных из содержания: ${rerouted.length}`);
});

// ── Первенство главной темы ─────────────────────────────────────────────────

test('the pill rule moves the main topic from content to value at L3', () => {
  const pill = ROUTE_ARBITER.mainTopic({ topics: ['content', 'value'], level: 'L3', intent: 'latent' });
  assert.equal(pill.topic, 'value');
  assert.equal(pill.applied.rule, 'pill_is_never_answered_with_content');
  assert.ok(pill.applied.unacceptableOutcome, 'правило обязано нести недопустимый исход');

  // Намерение в условие не входит: если бы входило, произнесённая вслух
  // посылка разрешала бы отвечать содержанием — тот же исход, только в виде
  // разрешения.
  assert.equal(ROUTE_ARBITER.mainTopic({ topics: ['content'], level: 'L3', intent: 'explicit' }).topic, 'value');

  // Предметный ход не задет: правило адресует пилюльный класс, а не
  // «содержание вообще».
  const subject = ROUTE_ARBITER.mainTopic({ topics: ['content'], level: 'L1', intent: 'explicit' });
  assert.equal(subject.topic, 'content');
  assert.equal(subject.applied, null);

  // Правило уже исполнено моделью — менять нечего, долга нет.
  assert.equal(ROUTE_ARBITER.mainTopic({ topics: ['value', 'content'], level: 'L3' }).applied, null);
  assert.equal(ROUTE_ARBITER.mainTopic({ topics: [] }).topic, null);
});

test('with no primacy rules the main topic is the first one — proof it is data, not an if', () => {
  const bare = JSON.parse(JSON.stringify(SPEC.spec));
  bare.routing.main_topic_primacy = { rules: [] };
  const arbiter = createRouteArbiter(bare);
  for (const level of ['L1', 'L2', 'L3']) {
    assert.equal(arbiter.mainTopic({ topics: ['content', 'value'], level, intent: 'latent' }).topic, 'content');
  }
  delete bare.routing.main_topic_primacy;
  assert.equal(createRouteArbiter(bare).mainTopic({ topics: ['content'], level: 'L3' }).topic, 'content');
});

test('primacy data the code cannot execute fails the build instead of half-running', () => {
  const withRule = (rule) => {
    const spec = JSON.parse(JSON.stringify(SPEC.spec));
    spec.routing.main_topic_primacy = { rules: [rule] };
    return () => createRouteArbiter(spec);
  };
  const good = { id: 'r', when: { level: ['L3'] }, then: { main_topic: 'value' }, unacceptable_outcome: 'x' };

  assert.throws(withRule({ ...good, when: { trajectory_depth: [3] } }), /primacy_condition_unimplemented/u);
  assert.throws(withRule({ ...good, when: { level: ['L9'] } }), /primacy_value_unknown/u);
  assert.throws(withRule({ ...good, when: {} }), /primacy_empty_when/u);
  assert.throws(withRule({ ...good, then: { main_topic: 'nowhere' } }), /primacy_target_unknown/u);
  // Правило без недопустимого исхода — правило «от устройства»: запрещено.
  assert.throws(withRule({ id: 'r', when: { level: ['L3'] }, then: { main_topic: 'value' } }),
    /primacy_without_outcome/u);
});
