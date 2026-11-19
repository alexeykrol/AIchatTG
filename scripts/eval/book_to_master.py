#!/usr/bin/env python3
"""Put the donor stand's book (20 records) into an AIchatTG knowledge package, at $0.

Why: the paid comparison asks how the AIchatTG answer pipeline does on the SAME knowledge base the donor
stand (`agi2claude`) used. That base is `kb/tcr-book/kb.sqlite` (table `units`, 20 records). AIchatTG reads
knowledge only as an allcourses package (`ai.db` + contracts), so the book goes through the allcourses
builders unchanged, used as a library/CLI with every output path under `output/eval/tcr-book/`:

  1. read `units` read-only (`mode=ro`), write one `.md` mirror file per record;
  2. `build_master.load_units` -> master.db (unit_id = stand record id, type `lesson`, canonical_url NULL);
  3. `build_chunks.py`, `build_concepts.py` (phase 1, no model), `build_package.py --domain tcr --gold ...`.

Concept phase 2 runs only with `--enrichment <file>`: the offline arbiter's judgment file (versioned at
`scripts/eval/dictionary/tcr.enrichment.jsonl`) goes through the same course tooling, after phase 1 and before
the package: `analyze_concepts.py` (shortlist) -> `enrich_concepts.py merge` (validation, plan) ->
`enrich_concepts.py apply` (designer rows + reviewed aliases into master.db). Without the flag the build is
phase 1 only, exactly as before. Nothing in allcourses or agi2claude is written: both are opened read-only,
and bytecode writing is disabled so no `__pycache__` appears there.

    python3 scripts/eval/book_to_master.py [--donor ~/Code/agi2claude] [--allcourses ~/Code/allcourses]
        [--enrichment scripts/eval/dictionary/tcr.enrichment.jsonl]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "output" / "eval" / "tcr-book"
DOMAIN = "tcr"
COURSE_ID = 1  # the book is one container; the builders need an integer course id


def read_book(kb_path: Path) -> list[dict]:
    con = sqlite3.connect(f"file:{kb_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute("SELECT * FROM units ORDER BY id")]
    finally:
        con.close()


def gold_rows(cases_path: Path, id_map_path: Path) -> list[dict]:
    """Retrieval gold in the allcourses harness format, from the golden cases behind the 100 questions."""
    cases = {c["id"]: c for c in (json.loads(x) for x in cases_path.read_text("utf-8").splitlines() if x.strip())}
    out = []
    for row in json.loads(id_map_path.read_text("utf-8")):
        c = cases[row["case_id"]]
        units = sorted({s["unit_id"] for s in c["support"]})
        answerable = c["kind"] != "unanswerable"
        out.append({
            "query_id": row["q"], "category": "sample" if answerable else "unanswerable",
            "question": c["question"], "answerable": answerable, "gold_units": units if answerable else [],
            "forbidden_units": [], "held_out": False, "note": f"{c['kind']} {c['id']}",
        })
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--donor", type=Path, default=Path.home() / "Code" / "agi2claude")
    ap.add_argument("--allcourses", type=Path, default=Path.home() / "Code" / "allcourses")
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--enrichment", type=Path, default=None,
                    help="phase-2 judgment file; omitted = phase 1 only (previous behaviour)")
    args = ap.parse_args(argv)
    enrichment = args.enrichment.expanduser().resolve() if args.enrichment else None
    if enrichment and not enrichment.is_file():
        print(f"enrichment file not found: {enrichment}", file=sys.stderr)
        return 2
    donor, ac, out = args.donor.expanduser(), args.allcourses.expanduser(), args.out
    knowledge = ac / "code" / "knowledge"
    kb_path = donor / "kb" / "tcr-book" / "kb.sqlite"

    if out.exists():
        shutil.rmtree(out)  # a derivative: rebuilt whole every time
    mirror = out / "mirror"
    mirror.mkdir(parents=True)

    records = read_book(kb_path)
    sys.path.insert(0, str(knowledge))
    from build_master import ensure_db, ensure_domain, load_units  # noqa: E402

    units = []
    for i, r in enumerate(records, 1):
        rel = f"mirror/{r['id']}.md"
        raw = r["text"].encode("utf-8")
        (out / rel).write_bytes(raw)
        units.append({
            "unit_id": r["id"], "unit_type": "lesson", "course_id": COURSE_ID, "parent_id": None,
            "order_path": [i], "title": r["title"], "lang": "ru", "source_path": rel,
            "source_sha256": hashlib.sha256(raw).hexdigest(), "prod_post_id": None, "canonical_url": None,
            "url_state": "unknown", "synced_at": None, "body_word_count": len(r["text"].split()),
        })
    master = out / "master.db"
    con = ensure_db(master)
    try:
        ensure_domain(con, DOMAIN)
        run = load_units(con, units, DOMAIN, None)
    finally:
        con.close()

    gold = out / "tcr-book.gold.jsonl"
    rows = gold_rows(donor / "evals" / "golden" / "cases.jsonl", donor / "evals" / "baseline" / "id_map.json")
    gold.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), "utf-8")

    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    py = sys.executable
    steps = [
        [py, str(knowledge / "build_chunks.py"), "--db", str(master), "--repo-root", str(out),
         "--report", str(out / "reports" / "chunks.md")],
        [py, str(knowledge / "build_concepts.py"), "--db", str(master), "--domain", DOMAIN,
         "--report", str(out / "reports" / "concepts-p1.md")],
    ]
    if enrichment:
        edir = out / "enrichment"
        shortlist, plan = edir / "e3p2-shortlist.jsonl", edir / "enrichment.plan.json"
        steps += [
            [py, str(knowledge / "analyze_concepts.py"), "--db", str(master),
             "--report", str(edir / "e3p2-shortlist.md"), "--jsonl", str(shortlist)],
            [py, str(knowledge / "enrich_concepts.py"), "merge", "--shortlist", str(shortlist),
             "--enrichment", str(enrichment), "--plan", str(plan)],
            [py, str(knowledge / "enrich_concepts.py"), "apply", "--db", str(master), "--plan", str(plan)],
        ]
    steps += [
        [py, str(knowledge / "build_package.py"), "--db", str(master), "--domain", DOMAIN, "--gold", str(gold),
         "--packages-root", str(out / "packages"), "--json"],
    ]
    summary = None
    phase2 = None
    for cmd in steps:
        res = subprocess.run(cmd, cwd=out, env=env, capture_output=True, text=True)
        name = Path(cmd[1]).name
        if name == "enrich_concepts.py":
            name += f" {cmd[2]}"  # merge / apply
        if res.returncode != 0:
            print(f"{name}: exit {res.returncode}\n{res.stdout[-2000:]}\n{res.stderr[-2000:]}", file=sys.stderr)
            return res.returncode
        if name == "build_package.py":
            summary = json.loads(res.stdout)
        if name.startswith("enrich_concepts.py"):
            phase2 = (phase2 or "") + res.stdout
    pkg = Path(summary["package_dir"])
    result = {
        "records": len(records), "inserted": run["inserted"], "blocked": run["blocked"],
        "gold_rows": len(rows), "package_dir": str(pkg), "database": str(pkg / "ai.db"),
        "decision": summary["decision"], "counts": summary["counts"], "metrics": summary["metrics"],
        "source_kb_sha256": hashlib.sha256(kb_path.read_bytes()).hexdigest(),
    }
    if enrichment:
        result["enrichment"] = {"path": str(enrichment),
                                "sha256": hashlib.sha256(enrichment.read_bytes()).hexdigest(),
                                "log": phase2.strip().splitlines()}
    (out / "build.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps({k: result[k] for k in ("records", "inserted", "decision", "database", "counts")},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
