"""Exercise the passage coverage CLI using a synthetic package and runs."""

from contextlib import closing
import csv
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().with_name("passage_coverage.py")


def write_jsonl(path, rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


class PassageCoverageTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(dir=SCRIPT.parents[2])
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.package = self.root / "package"
        self.package.mkdir()
        self.cases = self.root / "cases.jsonl"
        self.baseline = self.root / "baseline"
        self.candidate = self.root / "candidate"
        self.baseline.mkdir()
        self.candidate.mkdir()

        self.normalized_content = 'Всё   ещё\n «свежее» — вкусныи\u0306 хлеб.'
        self.prefix = "p" * 70 + "X"
        self.suffix = "Y" + "s" * 63
        rows = [
            ("a-one", "record-a", self.normalized_content),
            ("a-two", "record-a", f"Начало. {self.normalized_content} Конец."),
            ("a-other", "record-a", "Same record, different passage."),
            ("b-one", "record-b", "The second account disagrees."),
            ("c-left", "record-c", self.prefix),
            ("c-right", "record-c", self.suffix),
            ("c-shorter", "record-c", self.prefix[:-1]),
            ("short", "record-d", "z" * 59),
            ("distractor", "record-e", "z" * 65),
        ]
        with closing(sqlite3.connect(self.package / "ai.db")) as database, database:
            database.execute("CREATE TABLE chunks (chunk_id TEXT, unit_id TEXT, ord INT, content TEXT)")
            database.executemany(
                "INSERT INTO chunks VALUES (?, ?, ?, ?)",
                [(chunk_id, unit_id, index, content)
                 for index, (chunk_id, unit_id, content) in enumerate(rows)],
            )
        first_support = {"quote": 'Все\tеще “свежее” - вкусный хлеб.', "unit_id": "record-a"}
        write_jsonl(self.cases, [
            {"id": "gain", "kind": "answerable", "support": [first_support]},
            {"id": "lose", "kind": "answerable", "support": [
                {"quote": "The second account disagrees.", "unit_id": "record-b"}
            ]},
            {"id": "conflict", "kind": "conflicting", "support": [
                first_support, {"quote": "The second account disagrees.", "unit_id": "record-b"}
            ]},
            {"id": "split", "kind": "answerable", "support": [
                {"quote": self.prefix + " middle " + self.suffix, "unit_id": "record-c"}
            ]},
            {"id": "missing", "kind": "answerable", "support": [
                {"quote": "z" * 65, "unit_id": "record-d"}
            ]},
            {"id": "no-answer", "kind": "unanswerable", "support": []},
        ])
        write_jsonl(self.baseline / "answers.jsonl", [
            self.answer("gain", "q1", ["a-other"], ["record-a"]),
            self.answer("lose", "q2", ["b-one"], ["record-b"]),
            self.answer("conflict", "q3", ["a-other", "b-one"], ["record-a", "record-b"], "conflicting"),
            self.answer("split", "q4", ["c-shorter", "c-left"], ["record-c"]),
            self.answer("missing", "q5", ["short", "distractor"], ["record-d"]),
            self.answer("no-answer", "q6", [], [], "unanswerable"),
        ])
        write_jsonl(self.candidate / "answers.jsonl", [
            self.answer("lose", "q102", [], ["record-b"]),
            self.answer("gain", "q101", ["a-other", "a-two"], ["record-a"]),
            self.answer("conflict", "q103", ["a-one", "b-one"], ["record-a", "record-b"], "conflicting"),
            self.answer("split", "q104", ["c-right"], ["record-c"]),
        ])

    @staticmethod
    def answer(case_id, q, chunk_ids, gold_units, kind="answerable"):
        return {
            "q": q, "case_id": case_id, "kind": kind, "chunk_ids": chunk_ids,
            "gold_units": gold_units, "unit_ids": [], "pack_status": "ok",
        }

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--package", str(self.package),
             "--cases", str(self.cases), *map(str, args)],
            capture_output=True, text=True,
        )

    def test_run_metrics_and_paired_comparison(self):
        tsv = self.root / "coverage.tsv"
        result = self.run_cli(self.baseline, self.candidate, "--tsv", tsv)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("| answerable | 4 | 4 | 2 | 0 | 1.50 |", result.stdout)
        conflict_chars = len("Same record, different passage.The second account disagrees.")
        self.assertIn(f"| conflicting | 1 | 1 | 0 | 0 | 2.00 | {conflict_chars:.2f} |", result.stdout)
        self.assertIn("| unanswerable | 1 | — | — | 1 | 0.00 | 0.00 |", result.stdout)
        self.assertIn("Unlocated supports: 1\n- q5 (missing), support 1, unit `record-d`", result.stdout)
        self.assertIn("Paired on case_id: 4 shared, 2 baseline only, 0 comparison only.", result.stdout)
        self.assertIn("| answerable | q101 | q2 |", result.stdout)
        self.assertIn("| conflicting | q103 | — |", result.stdout)

        with tsv.open(encoding="utf-8", newline="") as source:
            rows = {(r["run"], r["case_id"]): r for r in csv.DictReader(source, delimiter="\t")}
        self.assertEqual(len(rows), 10)
        self.assertEqual(rows["baseline", "gain"]["record_all"], "True")
        self.assertEqual(rows["baseline", "gain"]["passage_all"], "False")
        self.assertEqual(rows["baseline", "gain"]["best_rank_of_gold_chunk_in_context"], "")
        self.assertEqual(rows["candidate", "gain"]["best_rank_of_gold_chunk_in_context"], "2")
        self.assertEqual(rows["baseline", "conflict"]["supports_covered"], "1")
        self.assertEqual(rows["baseline", "conflict"]["supports_total"], "2")
        self.assertEqual(rows["baseline", "split"]["best_rank_of_gold_chunk_in_context"], "2")
        self.assertEqual(rows["candidate", "split"]["best_rank_of_gold_chunk_in_context"], "1")
        self.assertEqual(rows["baseline", "missing"]["supports_covered"], "0")
        self.assertEqual(rows["baseline", "no-answer"]["passage_all"], "")

    def test_missing_answers_file(self):
        result = self.run_cli(self.root / "missing-run")
        self.assertEqual(result.returncode, 2)
        self.assertIn("answers.jsonl", result.stderr)

    def test_unknown_case_id(self):
        write_jsonl(self.baseline / "answers.jsonl", [
            self.answer("unknown", "q1", [], ["record-a"])
        ])
        result = self.run_cli(self.baseline)
        self.assertEqual(result.returncode, 2)
        self.assertIn("unknown case id unknown", result.stderr)


if __name__ == "__main__":
    unittest.main()
