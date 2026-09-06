// Fixture participant records (shape of agi participant/records/*.json) and a
// scenario per CONTRACT wave3 §5. Texts are anchored on the token "prompting"
// so both role banks retrieve; none of them fires the operations/value hints.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EXPERT_RECORD = Object.freeze({
  participant_key: 'assistant', label: 'Ассистент', kind: 'assistant', version: '0.1',
  intent: { state: 'explicit_goal', wants: 'Помочь спрашивающему: дать ответ из материалов домена и назвать границу, когда материала нет',
    hides: [], trust_breakers: [], exit_conditions: [] },
  knowledge: { life_experience: [], professional_context: ['домены знания: кластеры материалов, из которых собирается ответ'],
    past_disappointments: [], assistant_internals: true },
  voice: { literacy: 'standard', length: 'medium', punctuation: 'normal', emotion: 'ровная доброжелательность' },
});

export const SKEPTIC_RECORD = Object.freeze({
  participant_key: 'skeptic', label: 'Скептик', kind: 'synthetic', version: '0.1',
  intent: { state: 'deceptive_goal', wants: 'На самом деле хочет купить, но сначала должен убедиться, что его не обманут',
    hides: ['что курс ему нужен', 'что деньги есть'],
    trust_breakers: ['уклончивый ответ про prompting', 'обещания без механики'],
    exit_conditions: ['ответ окажется формальной отпиской'], patience_turns: 3 },
  knowledge: { life_experience: ['два неудачных захода в инфобизнес про prompting'], professional_context: [],
    past_disappointments: ['обещали prompting, дали пересказ чужих слайдов'],
    vocabulary: ['как крыло от самолёта', 'пересказ чужих слайдов'], assistant_internals: false },
  voice: { literacy: 'low', length: 'short', punctuation: 'sparse', emotion: 'обвиняющая настороженность', max_chars: 700 },
});

export function buildScenario({ expertId = 'assistant', syntheticId = 'skeptic', turnLimit = 6 } = {}) {
  return {
    scenario_id: 'wave3-fixture-prompting',
    case: 'prompting: скептик проверяет, учат ли тут prompting по-настоящему',
    scenario_class: 'content_trust',
    participants: [
      { participant_id: expertId, record: 'assistant', role: 'expert', label: 'Ассистент' },
      { participant_id: syntheticId, record: 'skeptic', role: 'synthetic', label: 'Скептик' },
    ],
    opening: { to: syntheticId, text: 'Ты зашёл в чат курса. Дважды обжигался: обещали prompting, дали пересказ. Спроси, чему тут учат по prompting, и не выдавай, что курс тебе нужен.' },
    turn_limit: turnLimit,
    // Поведение берётся из закрытого списка судей (allcourses
    // dialogue_eval/behaviors.py → BEHAVIORS). Выдуманное имя проходит наши тесты и
    // падает у валидатора стенограмм — ровно на том стыке, который строит этот пакет.
    expectations: [{ participant_id: expertId, turn: 1, expectation: { behavior: 'grounded_answer', note: 'Ответ по prompting из материалов.' } }],
  };
}

/** Writes records and scenario into `directory`; returns absolute paths. */
export function writeDualFixtures(directory, scenarioOverrides = {}) {
  mkdirSync(directory, { recursive: true });
  const paths = { expertRecord: join(directory, 'assistant.json'), syntheticRecord: join(directory, 'skeptic.json'), scenario: join(directory, 'scenario.json') };
  writeFileSync(paths.expertRecord, `${JSON.stringify(EXPERT_RECORD, null, 2)}\n`);
  writeFileSync(paths.syntheticRecord, `${JSON.stringify(SKEPTIC_RECORD, null, 2)}\n`);
  writeFileSync(paths.scenario, `${JSON.stringify(buildScenario(scenarioOverrides), null, 2)}\n`);
  return paths;
}
