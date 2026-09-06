/**
 * Спецификация анализатора: загрузка, компиляция промпта, разбор вердикта.
 *
 * Источник истины — `analyzer-spec.json` (данные, не код). Промпт здесь
 * ДЕРИВАТИВ: правка оси или примера меняет данные, и промпт меняется сам.
 * Рукописного промпта анализатора в этом файле нет и быть не должно.
 *
 * Второй экземпляр компилятора (первый — лабораторный `prompt.py`) — известный
 * риск расхождения. Он закрыт не обещанием, а тестом чётности: лаборатория
 * компилирует промпт обоими компиляторами из ОДНОГО файла спецификации и
 * сравнивает побайтно (`tests/test_prompt_parity.py`). Разъехались — красный
 * тест, а не тихо разный диагноз на стенде и в бою.
 */

import { assistantDialogue } from './assistant-dialogue.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Файл спецификации едет вместе с исходниками (образ содержит только `src/`),
 * поэтому путь берётся от модуля, а не от рабочей папки процесса. Доставку
 * держит `analyzer/sync_spec.sh` в лаборатории; здесь — только чтение.
 */
export const RUNTIME_ANALYZER_SPEC_PATH = fileURLToPath(new URL('./analyzer-spec.json', import.meta.url));

const CONFIDENCES = new Set(['low', 'medium', 'high']);
const MAX_SPEC_BYTES = 512 * 1024;
const MAX_RAW_ECHO = 400;

/** Поля надстройки диспетчера. Приходят только при `dispatcher: true`. */
const DISPATCHER_FIELDS = Object.freeze({
  problem: 'формула «я не могу [действие]» СЛОВАМИ ПОЛЬЗОВАТЕЛЯ, без «почему» внутри; '
    + 'нет ясного заблокированного действия — null',
  obstacle: 'заявленное препятствие дословно («нет времени», «дорого»), если названо; иначе null',
  solutionType: 'concept — если человеку нужно понять, что это и как устроено; '
    + 'technology — если нужен порядок действий',
  searchSubject: 'одна фраза: что на самом деле искать в материалах. '
    + 'НЕ заявленное препятствие и не пересказ вопроса',
});

const DISPATCHER_EXTRA = `

## Дополнительно: структура задачи (для диспетчера, наружу не показывается)
Помимо диагноза заполни поля надстройки. Правила жёсткие:
1. \`problem\` — ЕГО слова, не твой пересказ и не диагноз. Внутри формулы не должно быть причины: «я не могу оценить подрядчиков» — да; «я не могу, потому что нет времени» — нет.
2. \`obstacle\` пишется ОТДЕЛЬНО и никогда не попадает в \`searchSubject\`: поиск по заявленному препятствию притащит тайм-менеджмент вместо предмета.
3. Не уверен — \`null\`. Выдуманная структура хуже пустой.
`;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidSpec(code) { return { valid: false, code, spec: null, digest: null }; }

/**
 * Словарь оси обязан быть непустым списком записей с id: пустая ось означает
 * промпт без вариантов ответа, то есть гарантированно невалидный вердикт.
 */
function vocabulary(spec, axis) {
  const block = plainObject(spec) ? spec[axis] : null;
  const list = plainObject(block) ? block.vocabulary : null;
  if (!Array.isArray(list) || list.length === 0) return null;
  const ids = [];
  for (const entry of list) {
    const id = plainObject(entry) && typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) return null;
    ids.push(id);
  }
  return { list, ids };
}

export function analyzerSpecIds(spec, axis) { return vocabulary(spec, axis)?.ids || []; }

/** Валидация того, без чего анализатор не может работать. Fail closed. */
export function validateAnalyzerSpec(spec) {
  if (!plainObject(spec)) return invalidSpec('analyzer_spec_invalid');
  if (spec.schema_version !== 'kb_analyzer_spec_v1') return invalidSpec('analyzer_spec_version_unsupported');
  for (const axis of ['topics', 'levels', 'intents']) {
    if (!vocabulary(spec, axis)) return invalidSpec('analyzer_spec_vocabulary_invalid');
  }
  if (!plainObject(spec.output_contract) || !plainObject(spec.output_contract.shape)) {
    return invalidSpec('analyzer_spec_contract_invalid');
  }
  if (!plainObject(spec.routing) || !plainObject(spec.routing.map)) {
    return invalidSpec('analyzer_spec_routing_invalid');
  }
  if (!routingIsRoutable(spec)) return invalidSpec('analyzer_spec_routing_invalid');
  if (!routerPromptIsCompilable(spec)) return invalidSpec('analyzer_spec_router_prompt_invalid');
  return { valid: true, code: null, spec };
}

/**
 * Маршрутная часть обязана быть исполнимой: по ней компилируется промпт
 * боевого роутера и по ней же арбитр слоёв (§2.3а) переводит действие модели в
 * домен. Полудефектная секция дала бы промпт без домена или арбитраж без
 * отказа — то есть тихую потерю маршрута, а не заметный отказ.
 */
function routingIsRoutable(spec) {
  const map = spec.routing.map;
  const topics = Object.keys(map);
  if (topics.length === 0) return false;
  for (const topic of topics) {
    const entry = map[topic];
    if (!plainObject(entry)) return false;
    if (!Array.isArray(entry.actions) || entry.actions.length === 0) return false;
    if (!entry.actions.every((action) => typeof action === 'string' && action.trim())) return false;
    if (!(entry.sourceId === null || (typeof entry.sourceId === 'string' && entry.sourceId.trim()))) return false;
  }
  const arbitration = spec.routing.arbitration;
  if (!plainObject(arbitration) || !map[arbitration.refusal_topic]) return false;
  // Каждая тема словаря обязана иметь маршрут. Тема, которую вердикт может
  // назвать, а диспетчер не может отправить (режим dispatch, Ф4), была бы
  // тихой потерей маршрута на живом вопросе — дефект данных роняет старт.
  if (!vocabulary(spec, 'topics').ids.every((id) => Boolean(map[id]))) return false;
  const hints = spec.hints;
  if (!plainObject(hints) || !Array.isArray(hints.order) || !plainObject(hints.map)) return false;
  return hints.order.every((name) => plainObject(hints.map[name]) && Boolean(map[hints.map[name].topic]));
}

function routerPromptIsCompilable(spec) {
  const cfg = spec.routing.router_prompt;
  if (!plainObject(cfg)) return false;
  for (const key of ['preamble', 'action_line', 'requirement_line', 'hint_line', 'closing', 'null_source']) {
    if (typeof cfg[key] !== 'string' || !cfg[key]) return false;
  }
  if (!plainObject(cfg.requirement_verb) || typeof cfg.requirement_verb.one !== 'string'
    || typeof cfg.requirement_verb.many !== 'string') return false;
  if (!plainObject(cfg.domain_notes) || !plainObject(cfg.hints)) return false;
  if (typeof cfg.hint_include_refusal_action !== 'boolean') return false;
  if (!Array.isArray(cfg.domain_order) || cfg.domain_order.length === 0) return false;
  // Каждый домен словаря обязан попасть в промпт: домен, известный коду и
  // неизвестный модели, — это маршрут, которого модель никогда не выберет.
  const ordered = new Set(cfg.domain_order);
  if (ordered.size !== cfg.domain_order.length) return false;
  if (!cfg.domain_order.every((topic) => Boolean(spec.routing.map[topic]))) return false;
  if (!Object.keys(spec.routing.map).every((topic) => ordered.has(topic))) return false;
  return spec.hints.order.every((name) => plainObject(cfg.hints[name])
    && typeof cfg.hints[name].field === 'string' && cfg.hints[name].field
    && typeof cfg.hints[name].subject === 'string' && cfg.hints[name].subject);
}

/**
 * Чтение спецификации с диска. Дайджест печатается при старте: копия файла
 * живёт и в лаборатории, и здесь, поэтому расхождение обязано быть ВИДНЫМ.
 */
export function loadAnalyzerSpec(path) {
  let raw;
  try { raw = readFileSync(path); } catch { return invalidSpec('analyzer_spec_unreadable'); }
  if (raw.length > MAX_SPEC_BYTES) return invalidSpec('analyzer_spec_too_large');
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { return invalidSpec('analyzer_spec_malformed'); }
  const validated = validateAnalyzerSpec(parsed);
  if (!validated.valid) return validated;
  return {
    valid: true,
    code: null,
    spec: parsed,
    digest: createHash('sha256').update(raw).digest('hex'),
  };
}

function topicsBlock(spec) {
  const lines = [];
  for (const topic of spec.topics.vocabulary) {
    lines.push(`- \`${topic.id}\` — ${topic.label}: ${topic.theme}`);
    for (const example of topic.examples || []) {
      lines.push(`    пример: «${example.q}» → ${example.match ? 'да' : 'НЕТ'}`);
    }
  }
  return lines.join('\n');
}

function levelsBlock(spec) {
  const lines = [];
  for (const level of spec.levels.vocabulary) {
    lines.push(`- \`${level.id}\` — ${level.label}: ${level.theme}`);
    if (level.example) lines.push(`    пример: «${level.example.q}» — ${level.example.why}`);
  }
  return lines.join('\n');
}

function intentsBlock(spec) {
  return spec.intents.vocabulary.map((intent) => `- \`${intent.id}\` — ${intent.theme}`).join('\n');
}

/**
 * `dispatcher: false` — промпт v0 БАЙТ-В-БАЙТ. Именно на нём замерена базовая
 * точность по осям (0.83–0.84); расширение включается флагом, а не правкой на
 * месте, иначе «мы улучшили» и «мы сломали» выглядят одинаково.
 */
export function compileAnalyzerSystemPrompt(spec, { dispatcher = false } = {}) {
  const shape = { ...spec.output_contract.shape, ...(dispatcher ? DISPATCHER_FIELDS : {}) };
  const extra = dispatcher ? DISPATCHER_EXTRA : '';
  return `Ты — внутренний анализатор вопросов ассистента курса. Твоё суждение никогда не показывается собеседнику: оно только выбирает регистр и источник ответа.

Тебе дают ОДИН текущий ход покупателя и короткий контекст его предыдущих реплик. Диагностируй только текущий ход по трём осям.

## Ось 1. Темы (выбери 1–3, по убыванию главности)
${topicsBlock(spec)}

## Ось 2. Уровень разрыва (что человеку на самом деле не хватает)
${levelsBlock(spec)}

## Ось 3. Намерение (отношение вопроса к настоящей цели)
${intentsBlock(spec)}

## Жёсткие правила
1. Улика — только ДОСЛОВНАЯ цитата из текущего хода. Не перефразируй: цитаты проверяются кодом посимвольно.
2. Недоказанное не утверждается: нет улики уровня → \`none\`; сомнение в намерении → \`explicit\`. Ты диагност, не фантазёр.
3. Реплика с местоимением вместо предмета («а это сколько», «а его можно») — \`context_dependent: true\`, тему бери из контекста предыдущих реплик.
4. \`deceptive\` — только про сознательное выуживание запрещённого или атаку. Законный вопрос в резкой или неудобной форме — НЕ deceptive.
5. \`hidden_premise\` формулируй как убеждение человека одним предложением («компетенцию можно получить без обучения»), не как пересказ вопроса.
${extra}
## Формат ответа — строго один JSON-объект, без пояснений и без markdown
${JSON.stringify(shape, null, 2)}`;
}

/** «teach and navigate», «support». Последний соединяется союзом, а не запятой. */
function joinAnd(items) {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/gu, (match, key) => (key in values ? String(values[key]) : match));
}

/**
 * Системный промпт БОЕВОГО роутера `{action, sourceId}` — дериватив
 * `routing`, а не константа в коде.
 *
 * WHY. До этапа Ф3 текст жил строкой в `provider-adapter.mjs` и мог молча
 * разойтись со словарём маршрутов: правка `routing.map` не меняла ни символа
 * в промпте, и модель продолжала слышать прежний контракт — при том, что код
 * уже считал иначе. Теперь источник один: правка словаря автоматически
 * меняет то, что читает модель.
 *
 * Второй экземпляр компилятора (первый — лабораторный `prompt.py`) закрыт
 * тестом чётности, как и промпт анализатора: расхождение обязано быть
 * красным тестом, а не разной инструкцией на стенде и в бою.
 */
export function compileRouterSystemPrompt(spec) {
  const routing = spec.routing;
  const cfg = routing.router_prompt;
  const map = routing.map;
  const refusal = routing.arbitration.refusal_topic;
  const parts = [cfg.preamble];

  const actions = cfg.domain_order.flatMap((topic) => map[topic].actions);
  parts.push(fill(cfg.action_line, { actions: actions.join(', ') }));

  for (const topic of cfg.domain_order) {
    const entry = map[topic];
    parts.push(fill(cfg.requirement_line, {
      actions: joinAnd(entry.actions),
      verb: entry.actions.length === 1 ? cfg.requirement_verb.one : cfg.requirement_verb.many,
      sourceId: entry.sourceId === null ? cfg.null_source : entry.sourceId,
      note: cfg.domain_notes[topic] || '',
    }));
  }

  for (const name of spec.hints.order) {
    const allowed = [...map[spec.hints.map[name].topic].actions];
    // Право модели на отказ поверх сработавшего детектора — ДАННЫЕ, а не код.
    // По §2.3а (правило 2) такой отказ незаконен: домен уже назван, и код
    // перебивает redirect. Флаг оставлен включённым, потому что снятие меняет
    // поведение и требует замера, а не решения на месте.
    if (cfg.hint_include_refusal_action) allowed.push(...map[refusal].actions);
    parts.push(fill(cfg.hint_line, {
      field: cfg.hints[name].field,
      subject: cfg.hints[name].subject,
      actions: allowed.join(' or '),
    }));
  }

  parts.push(cfg.closing);
  return parts.join(' ');
}

/**
 * Спецификация, поехавшая вместе с образом. Читается один раз: это данные
 * выката, а не живая настройка.
 *
 * Отдельно от `config.analyzer.specPath` намеренно. Тот путь — настройка
 * НАБЛЮДАТЕЛЬНОГО режима и может быть выключен; маршрут же нужен на каждом
 * вопросе, и ставить его в зависимость от флага телеметрии значило бы, что
 * выключенный анализатор лишает людей ответа.
 */
let shippedSpec = null;
export function runtimeAnalyzerSpec() {
  if (shippedSpec === null) shippedSpec = loadAnalyzerSpec(RUNTIME_ANALYZER_SPEC_PATH);
  return shippedSpec;
}

/** Legacy user context plus an optional bounded, explicitly attributed Q/A tail. */
export function buildAnalyzerUserPayload(turnText, contextTexts = [], dialogue = null, workingState = null) {
  const previous = (Array.isArray(contextTexts) ? contextTexts : [])
    .map((text) => (typeof text === 'string' ? text : ''))
    .filter((text) => text.trim())
    .slice(-5);
  return JSON.stringify({
    // Do not duplicate the user side in both fields: three maximum-sized
    // pairs plus duplicate questions would exceed the provider input budget.
    ...(Array.isArray(dialogue)
      ? { dialogue: assistantDialogue(dialogue) } : { previous_user_turns: previous }),
    ...(workingState ? { working_state: workingState } : {}),
    current_turn: turnText,
  }, null, 2);
}

function stripFences(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned.startsWith('```')) return cleaned;
  return cleaned.split('\n').filter((line) => !line.trim().startsWith('```')).join('\n').trim();
}

function collapse(value) { return String(value || '').split(/\s+/).filter(Boolean).join(' ').toLowerCase(); }

function quoteIn(quote, text) {
  const needle = collapse(quote);
  return Boolean(needle) && collapse(text).includes(needle);
}

/**
 * Разбор одного суждения. Модель может вернуть мусор, markdown-обёртку, чужие
 * id или выдуманную цитату — всё это становится `status: 'invalid'`. Диагноз не
 * чинится молча: неверный вердикт обязан быть виден как неверный.
 */
export function parseAnalyzerVerdict(text, spec, turnText) {
  const cleaned = stripFences(text);
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch {
    return { status: 'invalid', error: 'не JSON', raw: cleaned.slice(0, MAX_RAW_ECHO) };
  }
  if (!plainObject(parsed)) {
    return { status: 'invalid', error: 'верхний уровень не объект', raw: cleaned.slice(0, MAX_RAW_ECHO) };
  }

  const problems = [];
  const knownTopics = new Set(analyzerSpecIds(spec, 'topics'));
  const topics = parsed.topics;
  if (!Array.isArray(topics) || topics.length < 1 || topics.length > 3
    || !topics.every((topic) => knownTopics.has(topic))) {
    problems.push(`topics ${JSON.stringify(topics)} вне контракта`);
  }

  const level = plainObject(parsed.level) ? parsed.level : {};
  if (!analyzerSpecIds(spec, 'levels').includes(level.hypothesis)) {
    problems.push(`level.hypothesis ${JSON.stringify(level.hypothesis)} вне словаря`);
  }
  if (!CONFIDENCES.has(level.confidence)) {
    problems.push(`level.confidence ${JSON.stringify(level.confidence)} вне шкалы`);
  }

  const intent = plainObject(parsed.intent) ? parsed.intent : {};
  if (!analyzerSpecIds(spec, 'intents').includes(intent.kind)) {
    problems.push(`intent.kind ${JSON.stringify(intent.kind)} вне словаря`);
  }
  if (!CONFIDENCES.has(intent.confidence)) {
    problems.push(`intent.confidence ${JSON.stringify(intent.confidence)} вне шкалы`);
  }

  if (typeof parsed.context_dependent !== 'boolean') problems.push('context_dependent не bool');

  if (problems.length) {
    return { status: 'invalid', error: problems.join('; '), raw: cleaned.slice(0, MAX_RAW_ECHO) };
  }

  const verdict = {
    status: 'ok',
    topics,
    topicsEvidence: String(parsed.topics_evidence || ''),
    contextDependent: parsed.context_dependent,
    level: {
      hypothesis: level.hypothesis,
      confidence: level.confidence,
      evidence: String(level.evidence || ''),
    },
    intent: {
      kind: intent.kind,
      confidence: intent.confidence,
      evidence: String(intent.evidence || ''),
      hiddenPremise: intent.hidden_premise || null,
    },
  };

  const patch = {};
  for (const name of ['problem', 'obstacle', 'solutionType', 'searchSubject']) {
    const value = parsed[name];
    if (value !== undefined && value !== null && value !== '') patch[name] = value;
  }
  if (Object.keys(patch).length) verdict.dispatcher = patch;

  // Улики проверяются дословно. Провал НЕ рушит диагноз, но остаётся в журнале:
  // недоказанная цитата понижает доверие к ходу, а не прячется.
  verdict.quotesUnverified = [
    ['topics', verdict.topicsEvidence],
    ['level', verdict.level.evidence],
    ['intent', verdict.intent.evidence],
  ].filter(([, quote]) => quote && !quoteIn(quote, turnText)).map(([name]) => name);
  return verdict;
}

export { DISPATCHER_FIELDS };
