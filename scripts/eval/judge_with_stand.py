#!/usr/bin/env python3
"""Judge an answers file with the donor stand's content judge, and put it in one table with the stand's sides.

Run with the donor's interpreter, which has its dependencies:

    MENTOR_BUDGET__BUILD_USD=<owner-approved total> \\
    ~/Code/agi2claude/.venv/bin/python scripts/eval/judge_with_stand.py \\
        --answers output/eval/runs/<run>/answers.md --side aichattg [--mock] [--key-env ANTHROPIC_API_KEY]

What is reused from the donor (imported, never copied): `parse_answers` and `select` from
`tools/baseline_compare.py`, `open_run` (harness), `judges.judge`, `suites.content_payload`,
`simulator.cited_records`. The judge sees exactly the payload the stand built for its own two sides
(case kind, question, reference, supporting quotes, the reply, the records the reply cites).

Other sides are NOT paid for again: the stand's bot and the generic chat (kb plugin) verdicts are read from the
donor's databases `data/eval/exp-baseline-{bot,plugin}.sqlite` read-only (`mode=ro`), merged per case exactly as
the donor's report does (`_results`: a later run replaces an earlier one). `--rejudge` sends a file through the
judge anyway (used at $0 in mock mode to prove our driver builds the same payload as the stand).

Safety: the judge database is `output/eval/judge.sqlite` (`MENTOR_EVAL_DB`), never a donor file; the run cap is
`MENTOR_BUDGET__EVAL_RUN_USD` (default 3); `MENTOR_BUDGET__BUILD_USD` must be given by the caller, because the
donor's live ledger is already above its own build cap and only the owner may raise it. No `.env` file of any
project is read: settings get an explicit non-existent env file and the key only from `--key-env`.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

sys.dont_write_bytecode = True

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "output" / "eval"
TAG = "aichattg-compare-2026-11-19"
KINDS = ("answerable", "unanswerable", "conflicting")
NO_ENV_FILE = REPO / "output" / "eval" / ".no-env-file-on-purpose"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Judge an answers file with the donor stand's content judge")
    ap.add_argument("--donor", type=Path, default=Path.home() / "Code" / "agi2claude")
    ap.add_argument("--answers", type=Path, help="answers file in the stand format (## Qnnn / Вопрос / Ответ)")
    ap.add_argument("--side", default="aichattg", help="label of the judged side")
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--mock", action="store_true", help="FakeLLM judge, $0")
    ap.add_argument("--key-env", help="environment variable holding the Anthropic key (live only)")
    ap.add_argument("--rejudge", action="store_true", help="judge the file even if it is a stand side")
    ap.add_argument("--report-only", action="store_true", help="no judging: table from existing verdicts")
    ap.add_argument("--out", type=Path, default=None)
    return ap.parse_args(argv)


def prepare_env(args: argparse.Namespace) -> dict[str, str]:
    """Process environment for the donor library, set BEFORE it is imported (harness reads it at import)."""
    if not os.environ.get("MENTOR_BUDGET__BUILD_USD"):
        raise SystemExit(
            "refusing to start: MENTOR_BUDGET__BUILD_USD is not set. The donor's live eval ledger is above its "
            "own build cap; the total allowed spend is the owner's decision and must be passed by the caller."
        )
    OUT.mkdir(parents=True, exist_ok=True)
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.environ["MENTOR_EVAL_DB"] = str(OUT / ("judge-mock.sqlite" if args.mock else "judge.sqlite"))
    os.environ.setdefault("MENTOR_BUDGET__EVAL_RUN_USD", "3")
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    if args.mock:
        env["MENTOR_MODE"] = "mock"
    else:
        if not args.key_env or not os.environ.get(args.key_env):
            raise SystemExit("live judging needs --key-env <ENV NAME> holding an Anthropic key")
        env["ANTHROPIC_API_KEY"] = os.environ[args.key_env]
        env["MENTOR_MODE"] = "live"
    return env


def settings_for(env: dict[str, str]):
    from mentor.config import load_settings
    from mentor.eval.harness import CONCURRENCY

    s = load_settings(env=env, env_file=NO_ENV_FILE)  # never the donor's .env
    budget = s.budget.model_copy(update={"per_user_daily_usd": 10_000.0})
    runtime = s.runtime.model_copy(update={"max_live_sessions": max(s.runtime.max_live_sessions, CONCURRENCY)})
    return s.model_copy(update={"budget": budget, "runtime": runtime})


async def judge_file(args, env, donor: Path, bc) -> dict:
    """Judge every answer of the file on the stand's sample of n (same job as the stand's plugin side)."""
    from mentor.eval import datasets as ds
    from mentor.eval import judges, suites
    from mentor.eval.harness import BuildBudgetExhausted, RunBudgetExceeded, open_run
    from mentor.eval.simulator import citation_counts, cited_records

    answers = bc.parse_answers(args.answers.read_text(encoding="utf-8"))
    sel = [r for r in bc.select(args.n) if r["q"] in answers]
    golden = {c.id: c for c in ds.load("golden")}
    cases = [golden[r["case_id"]] for r in sel]
    q_of = {r["case_id"]: r["q"] for r in sel}
    meta = {"experiment": TAG, "side": args.side, "n": len(cases), "cases": [c.id for c in cases],
            "qs": [r["q"] for r in sel], "answers_file": str(args.answers), "answers_sha256": sha256(args.answers)}
    try:
        env_run = open_run("content", mock=args.mock, settings=settings_for(env), meta=meta)
    except BuildBudgetExhausted as e:
        raise SystemExit(f"not started: {e}") from e
    payloads: dict[str, str] = {}
    started = time.monotonic()

    async def job(c):
        a = answers[q_of[c.id]]
        if a.question.strip() != c.question.strip():
            raise ValueError(f"{a.q}: question differs from golden case {c.id}")
        payload = suites.content_payload(c, a.reply, cited_records(env_run, a.reply))
        payloads[c.id] = payload
        j = await judges.judge(env_run, "content", payload)
        tc, tv = citation_counts(env_run, [a.reply])
        claims = max(0, int(j.get("claims", 0)))
        out = {"case": c, "pass": bool(j.get("pass")), "claims": claims,
               "supported": max(0, min(int(j.get("supported", 0)), claims)), "tc": tc, "tv": tv}
        env_run.record_result(
            c.id,
            {"claims": claims, "supported": out["supported"], "reason": j.get("reason", ""), "kind": c.kind,
             "reply": a.reply, "q": a.q, "correct": bool(j.get("correct"))},
            out["pass"],
        )
        return out

    metrics: dict = {}
    try:
        res = await suites.run_cases(cases, job)
        metrics = {"n_planned": len(cases), "n": len(res)}
        for kind in KINDS:
            metrics[f"{kind}_n"] = sum(1 for r in res if r["case"].kind == kind)
            metrics[f"{kind}_pass"] = sum(1 for r in res if r["case"].kind == kind and r["pass"])
    except RunBudgetExceeded as e:
        metrics = {"reason": str(e), "budget_stop": True}
    metrics["aborted"] = True  # a limited trial, never a gate run (same convention as the stand)
    metrics["wall_s"] = round(time.monotonic() - started, 1)
    env_run.finish(metrics)
    spent = env_run.spent()
    await env_run.app.close()
    return {"run_id": env_run.run_id, "metrics": metrics, "spent_usd": spent, "payloads": payloads}


def verdicts_from_db(path: Path, results_fn, want: set[str]) -> dict[str, dict]:
    """case id -> {pass, kind, claims, supported, reply} from a stand database (read-only)."""
    out = {}
    for cid, row in results_fn(path):
        if cid not in want:
            continue
        s = json.loads(row["scores_json"] or "{}")
        out[cid] = {"pass": bool(row["passed"]), "kind": s.get("kind"), "claims": int(s.get("claims", 0)),
                    "supported": int(s.get("supported", 0)), "reply": s.get("reply", "")}
    return out


def verdicts_from_our_db(path: Path, side: str, want: set[str]) -> dict[str, dict]:
    """Latest verdict per case of `side` in our judge database."""
    import sqlite3

    if not path.exists():
        return {}
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    out: dict[str, dict] = {}
    try:
        for run in con.execute("SELECT * FROM eval_runs WHERE suite='content' AND finished_at IS NOT NULL ORDER BY id"):
            meta = (json.loads(run["metrics_json"] or "{}").get("meta")) or {}
            if meta.get("experiment") != TAG or meta.get("side") != side:
                continue
            for r in con.execute("SELECT case_id, passed, scores_json FROM eval_results WHERE eval_run_id=?",
                                 (run["id"],)):
                if r["case_id"] in want:
                    s = json.loads(r["scores_json"] or "{}")
                    out[r["case_id"]] = {"pass": bool(r["passed"]), "kind": s.get("kind"),
                                         "claims": int(s.get("claims", 0)), "supported": int(s.get("supported", 0)),
                                         "reply": s.get("reply", "")}
    finally:
        con.close()
    return out


def table(sides: dict[str, dict[str, dict]], sel: list[dict]) -> list[str]:
    names = list(sides)
    lines = ["| Measure | " + " | ".join(names) + " |", "| --- |" + " --- |" * len(names)]

    def cell(v: dict, kind: str | None) -> str:
        rows = [v[r["case_id"]] for r in sel if r["case_id"] in v and (kind is None or r["kind"] == kind)]
        n = len([r for r in sel if kind is None or r["kind"] == kind])
        p = sum(1 for x in rows if x["pass"])
        return f"{p}/{n}" + ("" if len(rows) == n else f" (judged {len(rows)})")

    lines.append("| Overall pass | " + " | ".join(cell(sides[s], None) for s in names) + " |")
    for k in KINDS:
        lines.append(f"| {k} | " + " | ".join(cell(sides[s], k) for s in names) + " |")
    grounded = []
    for s in names:
        v = sides[s].values()
        c, sp = sum(x["claims"] for x in v), sum(x["supported"] for x in v)
        grounded.append(f"{sp}/{c}" if c else "-")
    lines.append("| Supported claims / claims | " + " | ".join(grounded) + " |")
    return lines


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    donor = args.donor.expanduser().resolve()
    env = prepare_env(args)
    sys.path.insert(0, str(donor / "src"))
    sys.path.insert(0, str(donor / "tools"))
    import baseline_compare as bc  # parse_answers, select, _results, db_path

    sel = bc.select(args.n)
    want = {r["case_id"] for r in sel}
    out_dir = args.out or (OUT / "judge" / (datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
                                             + ("-mock" if args.mock else "")))
    out_dir.mkdir(parents=True, exist_ok=True)

    judged = None
    if args.answers and not args.report_only:
        judged = asyncio.run(judge_file(args, env, donor, bc))
        (out_dir / "payloads.json").write_text(json.dumps(judged.pop("payloads"), ensure_ascii=False, indent=1))

    sides: dict[str, dict] = {}
    stand_db = donor / "data" / "eval"
    sides["generic chat + kb plugin (stand verdicts)"] = verdicts_from_db(
        stand_db / "exp-baseline-plugin.sqlite", bc._results, want)
    sides["stand bot (stand verdicts)"] = verdicts_from_db(stand_db / "exp-baseline-bot.sqlite", bc._results, want)
    ours = verdicts_from_our_db(Path(os.environ["MENTOR_EVAL_DB"]), args.side, want)
    if ours:
        sides[f"{args.side}" + (" (MOCK judge)" if args.mock else "")] = ours

    def git_sha(path: Path) -> str | None:
        try:
            return subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True,
                                  check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            return None

    manifest = {
        "experiment": TAG, "created_at": datetime.now(UTC).isoformat(timespec="seconds"), "mock": args.mock,
        "side": args.side, "n": args.n, "judge_db": os.environ["MENTOR_EVAL_DB"],
        "eval_run_cap_usd": os.environ["MENTOR_BUDGET__EVAL_RUN_USD"],
        "build_cap_usd_from_caller": os.environ["MENTOR_BUDGET__BUILD_USD"],
        "donor": {"root": str(donor), "git_sha": git_sha(donor)},
        "aichattg_git_sha": git_sha(REPO),
        "references_sha256": {
            "golden/cases.jsonl": sha256(donor / "evals/golden/cases.jsonl"),
            "baseline/id_map.json": sha256(donor / "evals/baseline/id_map.json"),
            "kb/tcr-book/kb.sqlite": sha256(donor / "kb/tcr-book/kb.sqlite"),
            "prompts/judges/content.md": sha256(donor / "prompts/judges/content.md"),
            "config.yaml": sha256(donor / "config.yaml"),
        },
        "answers_sha256": sha256(args.answers) if args.answers else None,
        "judged": judged,
        "stand_sides_source": "read-only verdicts, data/eval/exp-baseline-{plugin,bot}.sqlite",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2, default=str) + "\n")
    report = [f"# Content judge, {len(sel)} questions, three sides" + (" (MOCK judge: fixtures only)" if args.mock else ""),
              "", *table(sides, sel), ""]
    (out_dir / "report.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    print("\n".join(report))
    print(json.dumps({"out": str(out_dir), "judged": judged and {k: judged[k] for k in ("run_id", "spent_usd")}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
