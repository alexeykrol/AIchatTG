#!/usr/bin/env python3
"""$0 self-check of judge_with_stand.py (mock judge, FakeLLM). Run with the donor's interpreter:

    MENTOR_BUDGET__BUILD_USD=1 ~/Code/agi2claude/.venv/bin/python scripts/eval/check_judge_driver.py

1. The generic chat's answers (`evals/baseline/kb_plugin_answers.md`) go through OUR driver; for every case the
   reply text we record must equal `scores_json.reply` of the stand's own baseline database
   (`data/eval/exp-baseline-plugin.sqlite`, read-only), and each payload must carry the case's QUESTION,
   REFERENCE and the REPLY.
2. The known-bad answers file builds 8 payloads (judging them is the first paid step).
Prints one JSON line with passed/failed per check; exit 1 on any failure.
"""

from __future__ import annotations

import json
import os
import subprocess
import sqlite3
import sys
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
DONOR = Path(os.environ.get("AICHATTG_EVAL_DONOR", Path.home() / "Code" / "agi2claude")).expanduser()
DRIVER = REPO / "scripts" / "eval" / "judge_with_stand.py"
OUT = REPO / "output" / "eval" / "judge" / "self-check"


def run(side: str, answers: Path, out: Path) -> None:
    cmd = [sys.executable, str(DRIVER), "--donor", str(DONOR), "--answers", str(answers), "--side", side,
           "--mock", "--rejudge", "--out", str(out)]
    res = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    if res.returncode != 0:
        raise SystemExit(f"driver failed for {side}:\n{res.stdout[-1500:]}\n{res.stderr[-3000:]}")


def our_replies(side: str) -> dict[str, str]:
    con = sqlite3.connect(f"file:{REPO / 'output/eval/judge-mock.sqlite'}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        run_id = max(r["id"] for r in con.execute("SELECT id, metrics_json FROM eval_runs")
                     if (json.loads(r["metrics_json"] or "{}").get("meta") or {}).get("side") == side)
        return {r["case_id"]: json.loads(r["scores_json"])["reply"]
                for r in con.execute("SELECT case_id, scores_json FROM eval_results WHERE eval_run_id=?", (run_id,))}
    finally:
        con.close()


def main() -> int:
    sys.path.insert(0, str(DONOR / "src"))
    sys.path.insert(0, str(DONOR / "tools"))
    os.environ.setdefault("MENTOR_EVAL_DB", str(REPO / "output/eval/judge-mock.sqlite"))
    import baseline_compare as bc
    from mentor.eval import datasets as ds

    golden = {c.id: c for c in ds.load("golden")}
    results: dict[str, str] = {}

    # 1. generic answers through our driver == the stand's recorded replies; payload carries the case
    run("generic-rejudge", DONOR / "evals/baseline/kb_plugin_answers.md", OUT / "generic")
    ours = our_replies("generic-rejudge")
    stand = {cid: json.loads(r["scores_json"])["reply"]
             for cid, r in bc._results(DONOR / "data/eval/exp-baseline-plugin.sqlite")}
    common = sorted(set(ours) & set(stand))
    mismatched = [c for c in common if ours[c] != stand[c]]
    results["generic_reply_identical"] = "passed" if len(common) == 100 and not mismatched else (
        f"failed: {len(common)} common, {len(mismatched)} differ: {mismatched[:5]}")
    payloads = json.loads((OUT / "generic" / "payloads.json").read_text())
    bad = []
    for cid, p in payloads.items():
        c = golden[cid]
        if (f"QUESTION: {c.question}\n" not in p or f"REFERENCE (what a correct answer says): {c.expected}\n" not in p
                or f"REPLY:\n{ours[cid]}\n\nCITED RECORDS:" not in p or f"CASE KIND: {c.kind}\n" not in p):
            bad.append(cid)
    results["payload_carries_case"] = "passed" if len(payloads) == 100 and not bad else f"failed: {bad[:5]}"

    # 2. known-bad file: 8 payloads build
    run("known-bad", REPO / "scripts/eval/known-bad-answers.md", OUT / "known-bad")
    kb_payloads = json.loads((OUT / "known-bad" / "payloads.json").read_text())
    results["known_bad_payloads_build"] = "passed" if len(kb_payloads) == 8 else f"failed: {len(kb_payloads)} payloads"

    print(json.dumps(results, ensure_ascii=False))
    return 0 if all(v == "passed" for v in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
