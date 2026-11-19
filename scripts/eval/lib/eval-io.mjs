/** Inputs and outputs of the offline comparison: the donor's 100 questions, the answers file, the report. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const KINDS = Object.freeze(['answerable', 'unanswerable', 'conflicting']);

/** The 100 questions in the donor's order: `evals/baseline/id_map.json` -> `evals/golden/cases.jsonl`. */
export function loadQuestions(donorRoot) {
  const cases = new Map(readFileSync(join(donorRoot, 'evals/golden/cases.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).map((c) => [c.id, c]));
  return JSON.parse(readFileSync(join(donorRoot, 'evals/baseline/id_map.json'), 'utf8')).map((row) => {
    const c = cases.get(row.case_id);
    if (!c) throw new Error(`id_map names unknown case ${row.case_id}`);
    if (c.kind !== row.kind) throw new Error(`${row.q}: kind differs between id_map and case`);
    return { q: row.q, case_id: c.id, kind: c.kind, question: c.question,
      gold_units: [...new Set(c.support.map((s) => s.unit_id))] };
  });
}

/**
 * The stand's answers format, as parsed by agi2claude `tools/baseline_compare.py` `parse_answers`:
 * `## Qnnn`, then `**Вопрос.** <one line>`, then `**Ответ.**` and the reply up to the next section.
 * The reply is the model's text exactly; nothing is appended (AIchatTG does not print record ids).
 */
export function renderAnswersMarkdown(rows, { title = 'AIchatTG assistant answers' } = {}) {
  const parts = [`# ${title}`, ''];
  for (const r of rows) {
    const question = String(r.question).replace(/\s*\n\s*/g, ' ').trim();
    const answer = String(r.answer ?? '').replace(/^(## Q\d{3})/gm, ' $1').trim();
    parts.push(`## ${r.q}`, '', `**Вопрос.** ${question}`, '', `**Ответ.** ${answer}`, '');
  }
  return `${parts.join('\n')}\n`;
}

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);

/** Recall@12 of gold records by kind, refusals, both sides of conflicting cases. */
export function retrievalReport(rows) {
  const byKind = {};
  for (const kind of KINDS) {
    const ks = rows.filter((r) => r.kind === kind);
    const withGold = ks.filter((r) => r.gold_units.length);
    const recalls = withGold.map((r) => r.gold_units.filter((u) => r.unit_ids.includes(u)).length / r.gold_units.length);
    const abstained = ks.filter((r) => r.status === 'abstained');
    byKind[kind] = {
      n: ks.length,
      recall_at_12_mean: recalls.length ? Math.round((1000 * recalls.reduce((a, b) => a + b, 0)) / recalls.length) / 1000 : null,
      all_gold_retrieved: withGold.filter((r) => r.gold_units.every((u) => r.unit_ids.includes(u))).length,
      any_gold_retrieved: withGold.filter((r) => r.gold_units.some((u) => r.unit_ids.includes(u))).length,
      abstained: abstained.length,
      abstained_qs: abstained.map((r) => r.q),
      errors: ks.filter((r) => r.status === 'error').map((r) => `${r.q}:${r.error}`),
      route_reasons: count(ks.map((r) => r.route_reason ?? 'grounded')),
      pack_status: count(ks.map((r) => r.pack_status ?? 'none')),
      confidence: count(ks.map((r) => r.confidence ?? 'none')),
      domain_signal: count(ks.map((r) => r.domain_signal ?? 'none')),
      mean_records_in_context: ks.length ? Math.round((10 * ks.reduce((n, r) => n + r.unit_ids.length, 0)) / ks.length) / 10 : null,
      mean_chunks_in_context: ks.length ? Math.round((10 * ks.reduce((n, r) => n + r.chunk_ids.length, 0)) / ks.length) / 10 : null,
    };
  }
  const missed = rows.filter((r) => r.gold_units.length && !r.gold_units.every((u) => r.unit_ids.includes(u)))
    .map((r) => ({ q: r.q, kind: r.kind, status: r.status, missing: r.gold_units.filter((u) => !r.unit_ids.includes(u)) }));
  const a = byKind.answerable; const u = byKind.unanswerable; const c = byKind.conflicting;
  return {
    summary: {
      answerable_recall_at_12: a.recall_at_12_mean, answerable_all_gold: `${a.all_gold_retrieved}/${a.n}`,
      answerable_false_refusals: `${a.abstained}/${a.n}`,
      unanswerable_refusal_rate: `${u.abstained}/${u.n} (${pct(u.abstained, u.n)}%)`,
      conflicting_both_sides: `${c.all_gold_retrieved}/${c.n}`, conflicting_recall_at_12: c.recall_at_12_mean,
      conflicting_refusals: `${c.abstained}/${c.n}`,
    },
    by_kind: byKind,
    missed,
  };
}

function count(values) { return values.reduce((m, v) => ({ ...m, [v]: (m[v] || 0) + 1 }), {}); }

export function renderRetrievalMarkdown(report, manifest) {
  const s = report.summary;
  const lines = [
    '# Retrieval at $0: AIchatTG retriever over the stand book (20 records)', '',
    `Database: \`${manifest.database}\` (sha256 ${manifest.database_sha256.slice(0, 12)}), retrieval`
      + ` ${manifest.retrieval.maxEntries} entries / ${manifest.retrieval.maxContextTokens} tokens, rewrite off.`,
    'Unit of recall: a stand record id (`unitOfChunkId` of the chunk ids handed to the answer model).', '',
    '| Measure | Value |', '| --- | --- |',
    `| Answerable: mean recall@12 of gold records | ${s.answerable_recall_at_12} |`,
    `| Answerable: all gold records in context | ${s.answerable_all_gold} |`,
    `| Answerable: refused (false refusal) | ${s.answerable_false_refusals} |`,
    `| Unanswerable: refused | ${s.unanswerable_refusal_rate} |`,
    `| Conflicting: both sides in context | ${s.conflicting_both_sides} |`,
    `| Conflicting: mean recall@12 | ${s.conflicting_recall_at_12} |`,
    `| Conflicting: refused | ${s.conflicting_refusals} |`, '',
    '## By kind', '',
  ];
  for (const [kind, k] of Object.entries(report.by_kind)) {
    lines.push(`### ${kind} (n=${k.n})`, '',
      `- route reasons: ${JSON.stringify(k.route_reasons)}`,
      `- pack status: ${JSON.stringify(k.pack_status)}; confidence: ${JSON.stringify(k.confidence)}`,
      `- domain veto signal: ${JSON.stringify(k.domain_signal)}`,
      `- mean records / chunks in context: ${k.mean_records_in_context} / ${k.mean_chunks_in_context}`,
      `- refused: ${k.abstained_qs.join(', ') || 'none'}`,
      ...(k.errors.length ? [`- errors: ${k.errors.join(', ')}`] : []), '');
  }
  lines.push('## Questions with a gold record missing from context', '');
  for (const m of report.missed) lines.push(`- ${m.q} (${m.kind}, ${m.status}): missing ${m.missing.join(', ')}`);
  return `${lines.join('\n')}\n`;
}
