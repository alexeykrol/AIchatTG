#!/usr/bin/env python3
"""Compare judged AIchatTG runs in output/eval/judge.sqlite (free, read-only).

    python3 scripts/eval/compare_runs.py BASE_RUN_ID OTHER_RUN_ID [OTHER_RUN_ID ...]

Prints pass counts by kind for every run, then the cases that flipped versus the base run.
Run ids are eval_runs.id of the "aichattg" side (known-bad runs are skipped on request only).
"""
import json
import sqlite3
import sys
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "output" / "eval" / "judge.sqlite"


def kind(case_id: str) -> str:
    return {"ans": "answerable", "una": "unanswerable", "con": "conflicting"}.get(case_id.split("-")[1], "?")


def load(con, run_id):
    meta = json.loads(con.execute("select metrics_json from eval_runs where id=?", (run_id,)).fetchone()[0])
    rows = dict(con.execute("select case_id, passed from eval_results where eval_run_id=?", (run_id,)).fetchall())
    qs = dict(zip(meta["meta"]["cases"], meta["meta"]["qs"]))
    return meta, rows, qs


def main(argv):
    ids = [int(a) for a in argv]
    if len(ids) < 2:
        sys.exit(__doc__)
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    runs = {i: load(con, i) for i in ids}
    print("| run | answers file | answerable | unanswerable | conflicting | total |")
    print("|---|---|---|---|---|---|")
    for i, (meta, rows, _) in runs.items():
        by = {}
        for c, p in rows.items():
            k = kind(c)
            n, s = by.get(k, (0, 0))
            by[k] = (n + 1, s + (1 if p else 0))
        cell = lambda k: f"{by.get(k, (0, 0))[1]}/{by.get(k, (0, 0))[0]}"
        total = sum(s for _, s in by.values())
        print(f"| {i} | {Path(meta['meta']['answers_file']).parent.name} | {cell('answerable')} | "
              f"{cell('unanswerable')} | {cell('conflicting')} | {total}/{len(rows)} |")
    base = ids[0]
    _, brows, qs = runs[base]
    for i in ids[1:]:
        _, rows, _ = runs[i]
        gained = sorted(qs[c] for c in rows if rows[c] and not brows.get(c))
        lost = sorted(qs[c] for c in rows if not rows[c] and brows.get(c))
        print(f"\nrun {i} vs {base}: +{len(gained)} {' '.join(gained)}\n               -{len(lost)} {' '.join(lost)}")


if __name__ == "__main__":
    main(sys.argv[1:])
