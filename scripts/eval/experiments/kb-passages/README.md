# Book passages by judgement (experiment, 20.11.2026)

Markup of the book package `tcr-59025ab82058` into thought-sized passages, made by four Codex
workers (gpt-6.2-sol, medium), five records each, without access to any evaluation questions.

- Input: `output/kb/tcr-passages-v1/` built by `scripts/eval/kb_atoms.py` (770 numbered atoms).
- `markup-N.passages.jsonl`: one passage per line — `unit_id`, atom range `from`..`to`, `title`, `gist`,
  `questions` (4–6 everyday questions), `phrasings` (6–10), `concepts` (0–4 from the dictionary).
- Build (free, local):

```
python3 scripts/eval/kb_passages_build.py output/eval/tcr-book-v4/packages/tcr-59025ab82058 \
  output/kb/tcr-passages-v1/atoms.jsonl output/kb/tcr-passages-v1/pkg-markup-v1 \
  --markup scripts/eval/experiments/kb-passages/markup-{1,2,3,4}.passages.jsonl
```

Result: 220 passages, median 733 characters (min 170, max 1,805), every record covered exactly once;
text verbatim from atoms. `pkg-markup-v1.applied.json` is the build note with input hashes.

Known soft deviation: one passage of `markup-3` (line 10, map-reading instructions) has only two
questions free of dictionary words; the worker's own stricter check flags it, the build accepts it.

Measurements: `docs/reports/2026-11-20-search-architecture/heldout-and-gate-results.md`.
