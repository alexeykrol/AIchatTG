#!/usr/bin/env python3
"""Measure whether the context sent to the model contains the gold passages."""

import argparse
from collections import defaultdict
from contextlib import closing
import csv
from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
import unicodedata


DEFAULT_CASES = Path("~/Code/agi2claude/evals/golden/cases.jsonl")
KINDS = {"answerable": 1, "conflicting": 2, "unanswerable": 0}
MIN_FRAGMENT = 60
PUNCTUATION = str.maketrans({
    **dict.fromkeys('«»“”„‟‹›', '"'),
    **dict.fromkeys('‘’‚‛', "'"),
    **dict.fromkeys('‐‑‒–—―−', '-'),
    "ё": "е",
})
TSV_FIELDS = (
    "run", "q", "case_id", "kind", "pack_status", "n_chunks", "record_all",
    "passage_all", "supports_covered", "supports_total",
    "best_rank_of_gold_chunk_in_context",
)


def normalize(text):
    text = unicodedata.normalize("NFC", text).lower().translate(PUNCTUATION)
    return " ".join(text.split())


def locate(quote, unit_chunks):
    matches = {chunk_id for chunk_id, content in unit_chunks if quote in content}
    if matches:
        return matches

    # Find the longest matching prefix and suffix independently. A split
    # passage can leave fragments of different lengths in its two chunks.
    for suffix in (False, True):
        for length in range(len(quote) - 1, MIN_FRAGMENT - 1, -1):
            fragment = quote[-length:] if suffix else quote[:length]
            edge_matches = {
                chunk_id for chunk_id, content in unit_chunks if fragment in content
            }
            if edge_matches:
                matches.update(edge_matches)
                break
    return matches


def jsonl(path):
    with path.open(encoding="utf-8") as source:
        for number, line in enumerate(source, 1):
            if not line.strip():
                continue
            location = f"{path}:{number}"
            try:
                row = json.loads(line)
            except ValueError as exc:
                raise ValueError(f"{location}: {exc}") from exc
            if not isinstance(row, dict):
                raise ValueError(f"{location}: expected a JSON object")
            yield location, row


def load_chunks(package):
    path = (package / "ai.db").resolve()
    if not path.is_file():
        raise ValueError(f"missing package database: {path}")
    chunks = {}
    by_unit = defaultdict(list)
    with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as database:
        for chunk_id, unit_id, content in database.execute(
            "SELECT chunk_id, unit_id, content FROM chunks"
        ):
            if not all(isinstance(value, str) for value in (chunk_id, unit_id, content)):
                raise ValueError(f"{path}: expected text chunk_id, unit_id and content")
            if chunk_id in chunks:
                raise ValueError(f"{path}: duplicate chunk id {chunk_id}")
            chunks[chunk_id] = unit_id, len(content)
            by_unit[unit_id].append((chunk_id, normalize(content)))
    return chunks, by_unit


def load_cases(path, by_unit):
    cases = {}
    for location, row in jsonl(path):
        case_id = row.get("id")
        kind = row.get("kind")
        supports = row.get("support")
        if not isinstance(case_id, str) or not case_id:
            raise ValueError(f"{location}: expected a nonempty case id")
        if case_id in cases:
            raise ValueError(f"{location}: duplicate case id {case_id}")
        if (not isinstance(kind, str) or kind not in KINDS
                or not isinstance(supports, list) or len(supports) != KINDS[kind]):
            raise ValueError(f"{location}: invalid kind or support count for case {case_id}")
        located = []
        for support in supports:
            if (not isinstance(support, dict)
                    or not isinstance(support.get("unit_id"), str)
                    or not isinstance(support.get("quote"), str)):
                raise ValueError(f"{location}: support requires a unit_id and quote")
            unit_id = support["unit_id"]
            quote = normalize(support["quote"])
            if not quote:
                raise ValueError(f"{location}: empty support quote for case {case_id}")
            located.append((unit_id, locate(quote, by_unit.get(unit_id, ()))))
        cases[case_id] = kind, located
    return cases


@dataclass
class Question:
    q: str
    case_id: str
    kind: str
    pack_status: str
    n_chunks: int
    record_all: bool | None
    passage_all: bool | None
    supports_covered: int
    supports_total: int
    best_rank_of_gold_chunk_in_context: int | None
    context_chars: int
    unlocated: list


def measure_run(directory, chunks, cases):
    results = {}
    for location, row in jsonl(directory / "answers.jsonl"):
        for field in ("q", "case_id", "kind", "pack_status"):
            if not isinstance(row.get(field), str):
                raise ValueError(f"{location}: expected text field {field}")
        for field in ("chunk_ids", "gold_units"):
            values = row.get(field)
            if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
                raise ValueError(f"{location}: expected a list of strings in {field}")
        case_id = row["case_id"]
        if case_id not in cases:
            raise ValueError(f"{location}: unknown case id {case_id}")
        if case_id in results:
            raise ValueError(f"{location}: duplicate case id {case_id}")
        kind, supports = cases[case_id]
        if row["kind"] != kind:
            raise ValueError(f"{location}: kind differs from gold case {case_id}")

        chunk_ids = row["chunk_ids"]
        context_units = set()
        context_chars = 0
        for chunk_id in chunk_ids:
            if chunk_id not in chunks:
                raise ValueError(f"{location}: unknown chunk id {chunk_id}")
            unit_id, length = chunks[chunk_id]
            context_units.add(unit_id)
            context_chars += length

        context_ids = set(chunk_ids)
        covered = sum(bool(ids & context_ids) for _, ids in supports)
        gold_chunks = {chunk_id for _, ids in supports for chunk_id in ids}
        best_rank = next((rank for rank, chunk_id in enumerate(chunk_ids, 1)
                          if chunk_id in gold_chunks), None)
        results[case_id] = Question(
            q=row["q"],
            case_id=case_id,
            kind=kind,
            pack_status=row["pack_status"],
            n_chunks=len(chunk_ids),
            record_all=set(row["gold_units"]) <= context_units if supports else None,
            passage_all=covered == len(supports) if supports else None,
            supports_covered=covered,
            supports_total=len(supports),
            best_rank_of_gold_chunk_in_context=best_rank,
            context_chars=context_chars,
            unlocated=[(number, unit_id) for number, (unit_id, ids)
                       in enumerate(supports, 1) if not ids],
        )
    return results


def print_run(run, results):
    print(f"### {run}\n")
    print("| Kind | Questions | record_all | passage_all | Empty contexts | Mean chunks | Mean context characters |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for kind in KINDS:
        group = [question for question in results.values() if question.kind == kind]
        n = len(group)
        records = sum(question.record_all is True for question in group)
        passages = sum(question.passage_all is True for question in group)
        empty = sum(question.n_chunks == 0 for question in group)
        mean_chunks = f"{sum(question.n_chunks for question in group) / n:.2f}" if n else "—"
        mean_chars = f"{sum(question.context_chars for question in group) / n:.2f}" if n else "—"
        if kind == "unanswerable":
            records = passages = "—"
        print(f"| {kind} | {n} | {records} | {passages} | {empty} | {mean_chunks} | {mean_chars} |")

    missing = [(question, number, unit_id) for question in results.values()
               for number, unit_id in question.unlocated]
    print(f"\nUnlocated supports: {len(missing)}")
    for question, number, unit_id in missing:
        print(f"- {question.q} ({question.case_id}), support {number}, unit `{unit_id}`")
    print()


def print_comparison(base_name, base, run, results):
    shared = base.keys() & results.keys()
    print(f"### {run} vs {base_name}\n")
    print(f"Paired on case_id: {len(shared)} shared, {len(base) - len(shared)} "
          f"baseline only, {len(results) - len(shared)} comparison only.\n")
    print("| Kind | Gained question IDs | Lost question IDs |")
    print("|---|---|---|")
    for kind, count in KINDS.items():
        if not count:
            continue
        gained = []
        lost = []
        for case_id, before in base.items():
            if before.kind != kind or case_id not in shared:
                continue
            after = results[case_id]
            if after.passage_all and not before.passage_all:
                gained.append(after.q)
            if before.passage_all and not after.passage_all:
                lost.append(before.q)
        print(f"| {kind} | {', '.join(gained) or '—'} | {', '.join(lost) or '—'} |")
    print()


def write_tsv(path, runs):
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output, delimiter="\t", lineterminator="\n")
        writer.writerow(TSV_FIELDS)
        for run, results in runs:
            for question in results.values():
                writer.writerow(
                    [run] + [getattr(question, field) for field in TSV_FIELDS[1:]]
                )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dirs", metavar="RUN_DIR", type=Path, nargs="+")
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--tsv", type=Path)
    args = parser.parse_args(argv)

    try:
        chunks, by_unit = load_chunks(args.package.expanduser())
        cases = load_cases(args.cases.expanduser(), by_unit)
        directories = [path.expanduser().resolve() for path in args.run_dirs]
        runs = [
            (directory.name, measure_run(directory, chunks, cases))
            for directory in directories
        ]
        if args.tsv:
            write_tsv(args.tsv.expanduser(), runs)
    except (OSError, ValueError, sqlite3.Error) as exc:
        parser.error(str(exc))

    print("record_all uses unit IDs from the package's chunks.unit_id for the exact context chunk IDs.")
    print("Coverage is undefined for unanswerable questions. TSV rank uses located support chunks.\n")
    for run, results in runs:
        print_run(run, results)
    base_name, base = runs[0]
    for run, results in runs[1:]:
        print_comparison(base_name, base, run, results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
