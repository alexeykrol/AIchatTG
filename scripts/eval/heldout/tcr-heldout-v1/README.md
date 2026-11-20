# tcr-heldout-v1 — independent question set for the book package

50 questions written on 2026-11-20 by a Codex worker (gpt-6.2-sol) from the full text of package
`tcr-59025ab82058`, without access to the donor stand's 100 questions, the reports or the eval scripts.
30 answerable (10 in the book's terms, 20 in everyday words; 8 of the everyday ones need two records),
12 conflicting, 8 unanswerable. 62 support quotes were checked verbatim against the package.

Shape: the donor stand's (`evals/golden/cases.jsonl`, `evals/baseline/id_map.json`, ids H001–H050), so
`node scripts/eval/ask-offline.mjs --donor scripts/eval/heldout/tcr-heldout-v1 …` and
`python3 scripts/eval/passage_coverage.py … --cases scripts/eval/heldout/tcr-heldout-v1/evals/golden/cases.jsonl` work as is.

Hygiene: a task that builds or enriches a knowledge base must not read this directory
(`docs/codex-worker-protocol.md`, rule 8). The original worker output and its validator stay in the
untracked `output/codex/heldout-questions/`.
