"""Tests for the eval unit economics CLI and statistics."""

from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import unit_economics as U


def write_rows(path, *rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


class StatisticsTest(unittest.TestCase):
    def test_nearest_rank(self):
        self.assertIsNone(U.nearest_rank([], 90))
        self.assertEqual(U.nearest_rank([7], 90), 7)
        self.assertEqual(U.nearest_rank([7, 3], 90), 7)
        self.assertEqual(U.nearest_rank(list(range(10, 0, -1)), 90), 9)

    def test_null_and_string_numbers(self):
        answers = [
            U.parse_answer({
                "answer": "é🙂", "cost_usd": "0.01", "rewrite_cost_usd": "0.02",
                "latency_ms": "500", "input_tokens": "100", "output_tokens": None,
            }),
            U.parse_answer({
                "answer": "abcdef", "cost_usd": None, "rewrite_cost_usd": None,
                "latency_ms": None, "input_tokens": None, "output_tokens": "25",
            }),
        ]
        stats = U.summarize(answers)
        self.assertEqual(stats["n"], 2)
        self.assertAlmostEqual(stats["cost_mean_usd"], 0.015)
        self.assertAlmostEqual(stats["cost_median_usd"], 0.015)
        self.assertAlmostEqual(stats["cost_p90_usd"], 0.03)
        self.assertEqual(stats["answer_chars_mean"], 4)
        self.assertAlmostEqual(stats["usd_per_1000_chars"], 3.75)
        self.assertEqual(stats["latency_mean_s"], 0.5)
        self.assertEqual(stats["latency_p90_s"], 0.5)
        self.assertEqual(stats["input_tokens_mean"], 100)
        self.assertEqual(stats["output_tokens_mean"], 25)
        self.assertAlmostEqual(stats["cost_per_1000_answers_usd"], 15)

    def test_missing_and_empty_lengths(self):
        for rows in ([{}], [{"answer": ""}], [{"answer": "x"}, {"answer": None}]):
            with self.subTest(rows=rows):
                stats = U.summarize([U.parse_answer(row) for row in rows])
                self.assertIsNone(stats["usd_per_1000_chars"])
                self.assertIsNone(stats["latency_mean_s"])


class RunTest(unittest.TestCase):
    def test_status_and_malformed_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "answers.jsonl"
            write_rows(
                path,
                {"status": "answered", "answer": "ok"},
                {"status": "timeout", "cost_usd": 999},
                {"status": "timeout"},
                {"status": "provider_error"},
                {"status": "answered", "cost_usd": "garbage"},
                {"status": "answered", "latency_ms": "NaN"},
                {"status": "answered", "knowledge_gap": "false"},
                {"answer": "no status"},
                [],
            )
            with path.open("ab") as output:
                output.write(b"{invalid json}\n\xff\n")
            run = U.summarize_run(path)

        self.assertEqual(run["groups"]["all"]["n"], 1)
        self.assertEqual(run["groups"]["all"]["cost_mean_usd"], 0)
        self.assertEqual(run["not_answered"], 3)
        self.assertEqual(run["statuses"], {"provider_error": 1, "timeout": 2})
        self.assertEqual(run["skipped"], 7)
        table = U.markdown_table(run)
        self.assertIn("not answered: 3 (provider_error: 1, timeout: 2)", table)
        self.assertIn("skipped: 7", table)
        self.assertIn("n/a", table)

    def test_cli_judge_groups_and_json_for_multiple_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first-run"
            second = root / "second-run"
            first.mkdir()
            second.mkdir()
            write_rows(
                first / "answers.jsonl",
                {"status": "answered", "q": "Q1", "kind": "answerable", "knowledge_gap": False},
                {"status": "answered", "q": "Q2", "kind": "unanswerable", "knowledge_gap": True},
                {"status": "answered", "q": "Q3", "kind": "conflicting", "knowledge_gap": None},
                {"status": "provider_error", "q": "Q4"},
            )
            second_file = second / "answers.jsonl"
            write_rows(second_file, {"status": "answered", "q": "Q1"})
            judge = root / "results.jsonl"
            write_rows(
                judge,
                {"q": "Q2", "gap_class": "out_of_base"},
                {"q": "Q1", "gap_class": "in_base_missed"},
                {"q": "Q3", "gap_class": None},
                {"q": "Q4", "gap_class": "out_of_base"},
                {"q": "Q5", "gap_class": []},
            )
            output = root / "summary.json"
            stdout = StringIO()
            with redirect_stdout(stdout):
                U.main([str(first), str(second_file), "--judge", str(judge), "--json", str(output)])
            runs = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual([run["run"] for run in runs], ["first-run", "second-run"])
        self.assertEqual(runs[0]["judge_skipped"], 1)
        self.assertEqual(
            {name: stats["n"] for name, stats in runs[0]["groups"].items()},
            {
                "all": 3,
                "gap_class=in_base_missed": 1,
                "gap_class=out_of_base": 1,
                "kind=answerable": 1,
                "kind=unanswerable": 1,
                "kind=conflicting": 1,
                "knowledge_gap=false": 1,
                "knowledge_gap=true": 1,
            },
        )
        self.assertEqual(set(runs[1]["groups"]), {"all", "gap_class=in_base_missed"})
        self.assertIsNone(runs[1]["groups"]["all"]["latency_p90_s"])
        self.assertIn("## first-run\n", stdout.getvalue())
        self.assertIn("## second-run\n", stdout.getvalue())
        self.assertIn("| gap_class=in_base_missed | 1 |", stdout.getvalue())

    def test_no_answered_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "answers.jsonl"
            write_rows(path, {"status": "timeout"})
            run = U.summarize_run(path)
        self.assertEqual(set(run["groups"]), {"all"})
        self.assertEqual(run["groups"]["all"]["n"], 0)
        self.assertIsNone(run["groups"]["all"]["cost_mean_usd"])


if __name__ == "__main__":
    unittest.main()
