# Deep read — 2nd/3rd pass for hard questions (2026-11-21)

Owner's method: the plugin wins because it searches several times and reads around the hits; we do the
same only for hard questions, test only on the losing questions, write the result to the case base.

## What was built

`apps/telegram-runtime/src/deep-read.mjs` — a decorator over `createKnowledgeRetrieval`, switched by
`TELEGRAM_RUNTIME_ASSISTANT_DEEP_READ=off|on` (default `off` returns the same retrieval object).

- **Pass 1** — current retrieval (hybrid, links) unchanged.
- **Gate (code, $0)** — three signals on the first 6 passages: *tension* (a `contradicts`/`qualifies`
  link touches passage 1–2), *spread* (≥ 4 chapters, none ≥ 34 %), *coverage* (< 50 % of the question's
  significant stems found). **Hard = all three.** Any single signal fired on 91/100 questions, two of
  three on 49/100, all three on 16/100 — the rule was chosen for rarity, not tuned on outcomes.
- **Pass 2** — neighbours ±1 in the same unit and every link type of the top 4 passages, plus one
  re-search whose query is the 6 key terms (tf×idf) of those passages; deduped, ≤ 4 500 tokens, total
  knowledge ≤ 48 000 chars.
- **Pass 3** — only if tension was present or coverage is still < 50 % after pass 2: one Sonnet call,
  low effort, ≤ 200 output tokens, returns ≤ 3 queries; up to 3 new passages each; total extra ≤ 6 000
  tokens. Never more than one extra model call.
- **Receipt** — `routing.trace.deepRead`; runtime attaches `deepReadReceipt()` (deep_read, gate_reasons,
  passes, added ids/tokens, extra calls/usage) to the answer receipt.
- **Case base** — `caseRecord()` + `createJsonlCaseSink(path)` (`TELEGRAM_RUNTIME_ASSISTANT_CASE_BASE_PATH`,
  empty = off): question sha256 + normalized text, passage ids, passes, gate reasons. Local file only.
- Harness: `ask-offline.mjs` gained the production search levers (`--retrieval-mode`, `--hybrid-max-context-tokens`,
  `--link-types`, `--link-max`) and `--deep-read off|on|force` (`force` = experiment only: read deeply on
  every grounded question, gate still recorded). The runtime prompt already holds v2-cited; ask-offline
  never adds it by default (do not pass `--prompt-addendum answer-discipline-v2-cited.md`).

## Experiment

Production retrieval (pkg-hybrid-36b8db92318b, hybrid, 24 entries, links contradicts+qualifies ×4),
Sonnet 5.5 low, judge `judge_own/judge.py` Sonnet + rubric v4 against `gold-v3`. Losing set L = 25
questions where the plugin passed and we failed in at least one parity run. Because the gate fires on
only 3/25 of L, deep read was run in `force` mode to measure the mechanism; the gate verdict is shown.

| q | gate | base g1 | base g2 | deep g1 |
|---|---|---|---|---|
| Q008 | . | −N1 | −N1 | + |
| Q047 | . | −N4 | −N4 | + |
| Q083 | . | −N4 | −N4 | + |
| Q076 | . | −N4 | + | + |
| Q088 | . | −N1N2N4N5 | not judged | + |
| Q023 | . | + | + | −N1 |
| Q062 | . | + | + | −N1 |
| Q030 | . | −N5 | — | −N4 |
| Q094 | . | −N4 | — | −N4 |
| Q099 | H | −N4 | — | −N1N4 |
| other 15 (incl. Q084, Q090 = H) | | + | — | + |

- Totals on L: base 17/25, deep (force) 20/25. Paired: deep better 5, worse 2, equal 18 (p ≈ 0.45, sign test).
- Regression to the mean: L was selected on losses, yet the base passes 17/25 on regeneration.
- Base second generation on the 7 discordant: 3 of the 5 "deep better" stay failing in base (Q008, Q047,
  Q083) — the cleanest signal; both "deep worse" pass twice in base (Q023, Q062 — N1, more text → more
  misattribution).
- Gate on the losing set: 3/25 (Q084, Q090, Q099); on all 100: 16/100; on the 15-question winning sample: 2/15.
  The 5 questions deep read helped were **not** flagged by the gate: the pack-shape signals do not
  predict our losses (single signals fire at the same rate on L and on wins).
- Cost: base answer $0.034; forced deep answer $0.046 + pass 3 $0.0023 → +$0.014 per deep-read question
  (+41 %). At the gate rate 16 % → ≈ +$0.002 per average question.

Not run / inconclusive: deep second generation on the discordant 7, base g2 for Q088, judge of the
15-question winning-sample deep answers (`runs/DR-W-deep-1`, generated) — stopped by the $6 cap (the
judge reserves ~$0.91 per call and one call failed in transport, counted at its ceiling).

Runs: `output/eval/runs/DR-L-base-1`, `DR-L-deep-1`, `DR-L-base-2d`, `DR-L-deep-2d` (generated, not
judged), `DR-W-deep-1` (generated, not judged); judges `output/eval/judge-own/DR-L-base-1`, `DR-L-deep-1`,
`DR-L-base-2d-w1`.
