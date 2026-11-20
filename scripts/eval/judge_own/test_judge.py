"""Tests for the own judge. Run: python3 -m unittest discover -s scripts/eval/judge_own -p 'test_*.py'"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import judge as J  # noqa: E402

PRICES = {"claude-sonnet-5-5": {"input": 2.0, "output": 10.0, "cacheRead": 0.1, "cacheWrite": 2.5},
          "claude-opus-5-5": {"input": 4.0, "output": 20.0, "cacheRead": 0.2, "cacheWrite": 5.0}}

CASES = {
    "gold-ans-001": {"id": "gold-ans-001", "kind": "answerable", "question": "Q one?", "expected": "Ref one.",
                     "support": [{"quote": "Quote one.", "unit_id": "u1"}]},
    "gold-una-004": {"id": "gold-una-004", "kind": "unanswerable", "question": "Q two?", "expected": "Not in book.",
                     "support": []},
    "gold-con-001": {"id": "gold-con-001", "kind": "conflicting", "question": "Q three?", "expected": "A vs B.",
                     "support": [{"quote": "A.", "unit_id": "u2"}, {"quote": "B.", "unit_id": "u3"}]},
}
ID_MAP = [{"q": "Q001", "case_id": "gold-ans-001", "kind": "answerable"},
          {"q": "Q061", "case_id": "gold-una-004", "kind": "unanswerable"},
          {"q": "Q071", "case_id": "gold-con-001", "kind": "conflicting"}]


def no_sleep(_s):
    return None


def scripted(by_answer: dict[str, dict]):
    """Mock transport returning a verdict chosen by a marker in the reply text."""
    def fn(request):
        msg = request["messages"][0]["content"]
        for marker, verdict in by_answer.items():
            if marker in msg:
                return verdict
        return {"pass": True, "correct": True, "failures": [], "reason": "default"}
    return J.mock_transport(fn)


class JoinTest(unittest.TestCase):
    def test_join_by_case_id_kind_from_case(self):
        answers = [{"q": "Q001", "case_id": "gold-ans-001", "kind": "WRONG", "question": "Q one?", "answer": "x"},
                   {"q": "Q071", "case_id": "gold-con-001", "question": "Q three?", "answer": "y"}]
        items, problems = J.join(answers, CASES, ID_MAP)
        self.assertEqual([i["q"] for i in items], ["Q001", "Q061", "Q071"])
        self.assertEqual(items[0]["kind"], "answerable")
        self.assertEqual(items[0]["reference"], "Ref one.")
        self.assertEqual(items[0]["support"][0]["unit_id"], "u1")
        self.assertEqual(items[1]["status"], "missing_answer")
        self.assertEqual(items[2]["status"], "pending")
        self.assertEqual(problems, [])

    def test_join_problems(self):
        answers = [{"case_id": "gold-ans-001", "question": "other question", "answer": "x"},
                   {"case_id": "gold-una-004", "answer": "a"}, {"case_id": "gold-una-004", "answer": "b"},
                   {"case_id": "gold-xxx", "answer": "z"}]
        items, problems = J.join(answers, CASES, ID_MAP)
        self.assertEqual(items[0]["status"], "question_mismatch")
        self.assertEqual(items[1]["answer"], "a")
        self.assertTrue(any("duplicate" in p for p in problems))
        self.assertTrue(any("gold-xxx" in p for p in problems))
        self.assertTrue(any("differs" in p for p in problems))

    def test_null_answer_is_judged_as_empty(self):
        items, _ = J.join([{"case_id": "gold-ans-001", "answer": None}], CASES, ID_MAP[:1])
        self.assertEqual(items[0]["answer"], "")


class VerdictTest(unittest.TestCase):
    def test_parse_and_normalize(self):
        v = J.parse_verdict('x {"pass": false, "correct": true, "failures": ["Н2", "n4"], "reason": "r"} y')
        self.assertEqual(v["failures"], ["N2", "N4"])
        with self.assertRaises(ValueError):
            J.parse_verdict('{"pass": "no", "correct": true, "failures": [], "reason": ""}')
        with self.assertRaises(ValueError):
            J.parse_verdict('{"pass": false, "correct": true, "failures": ["N9"], "reason": ""}')

    def test_code_decides_pass(self):
        g = J.SpendGuard(10)
        send = J.mock_transport(lambda r: {"pass": True, "correct": True, "failures": ["N3"], "reason": "x"})
        req = J.build_request("rubric", {**CASES["gold-ans-001"], "reference": "r", "support": [], "answer": "a"},
                              "claude-sonnet-5-5")
        res = J.call_judge(send, g, req, PRICES["claude-sonnet-5-5"], "t", no_sleep)
        self.assertFalse(res["pass"])
        self.assertTrue(res["model_pass"])

    def test_known_prices_parse_from_spend_guard(self):
        p = J.load_prices()
        self.assertEqual(p["claude-sonnet-5-5"]["input"], 2.0)
        self.assertEqual(p["claude-opus-5-5"]["output"], 20.0)


class SpendGuardTest(unittest.TestCase):
    def req(self, n=1000):
        return {"model": "claude-sonnet-5-5", "max_tokens": 600, "system": "s" * n,
                "messages": [{"role": "user", "content": "u"}]}

    def test_refuses_before_cap(self):
        price = PRICES["claude-sonnet-5-5"]
        ceiling = ((1000 + 1 + J.OVERHEAD_TOKENS) * 2.5 + 600 * 10.0) / 1e6
        g = J.SpendGuard(cap_usd=ceiling * 2.5, already_spent_usd=0.0)
        r1 = g.reserve(self.req(), price)
        r2 = g.reserve(self.req(), price)
        with self.assertRaises(J.SpendCapReached):
            g.reserve(self.req(), price)  # third ceiling would exceed the cap even before settling
        g.settle(r1, None, 200)
        g.settle(r2, None, 200)
        self.assertLessEqual(g.settled, g.cap)
        with self.assertRaises(J.SpendCapReached):  # stays stopped
            g.reserve(self.req(1), price)
        self.assertEqual(g.journal[0]["event"], "refused")

    def test_already_spent_counts(self):
        g = J.SpendGuard(cap_usd=1.0, already_spent_usd=0.999)
        with self.assertRaises(J.SpendCapReached):
            g.reserve(self.req(), PRICES["claude-sonnet-5-5"])

    def test_settle_uses_usage(self):
        g = J.SpendGuard(cap_usd=1.0)
        r = g.reserve(self.req(), PRICES["claude-sonnet-5-5"])
        cost = g.settle(r, {"input_tokens": 1000, "output_tokens": 100}, 200)
        self.assertAlmostEqual(cost, (1000 * 2 + 100 * 10) / 1e6)
        self.assertEqual(g.reserved, 0)

    def test_run_stops_at_cap_and_marks_rest_not_judged(self):
        items, _ = J.join([{"case_id": c, "answer": "a" * 200} for c in CASES], CASES, ID_MAP)
        one = J.input_token_ceiling(J.build_request("R" * 500, items[0], "claude-sonnet-5-5"))
        cap = (one * 2.5 + J.MAX_TOKENS * 10) / 1e6 * 1.05  # room for one call only
        g = J.SpendGuard(cap)
        res, stop = J.judge_items(items, J.mock_transport(), g, "R" * 500, "claude-sonnet-5-5", PRICES, 1, no_sleep)
        self.assertEqual([r["status"] for r in res], ["judged", "not_judged", "not_judged"])
        self.assertIn("spend cap", stop)
        self.assertLessEqual(g.settled, cap)

    def test_auth_error_stops_without_retry(self):
        calls = []

        def send(req):
            calls.append(1)
            return 401, {"error": "auth"}
        items, _ = J.join([{"case_id": c, "answer": "a"} for c in CASES], CASES, ID_MAP)
        res, stop = J.judge_items(items, send, J.SpendGuard(5), "R", "claude-sonnet-5-5", PRICES, 1, no_sleep)
        self.assertEqual(len(calls), 1)
        self.assertIn("auth", stop)

    def test_retryable_bounded(self):
        calls = []

        def send(req):
            calls.append(1)
            return 529, None
        items, _ = J.join([{"case_id": "gold-ans-001", "answer": "a"}], CASES, ID_MAP[:1])
        res, stop = J.judge_items(items, send, J.SpendGuard(5), "R", "claude-sonnet-5-5", PRICES, 1, no_sleep)
        self.assertEqual(len(calls), 3)
        self.assertEqual(res[0]["status"], "judge_error")
        self.assertIsNone(stop)


class EndToEndTest(unittest.TestCase):
    def test_mock_run_writes_results_summary_audit(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            cases = d / "cases.jsonl"
            cases.write_text("".join(json.dumps(c) + "\n" for c in CASES.values()))
            idm = d / "id_map.json"
            idm.write_text(json.dumps(ID_MAP))
            ans = d / "answers.jsonl"
            ans.write_text("".join(json.dumps({"case_id": c, "question": CASES[c]["question"], "answer": t}) + "\n"
                                   for c, t in [("gold-ans-001", "good"), ("gold-una-004", "REFUSE"),
                                                ("gold-con-001", "ONESIDED")]))
            send = scripted({"REFUSE": {"pass": False, "correct": False, "failures": ["N2"], "reason": "r"},
                             "ONESIDED": {"pass": False, "correct": False, "failures": ["N4"], "reason": "o"}})
            out = d / "out"
            rc = J.main(["--answers", str(ans), "--cases", str(cases), "--id-map", str(idm), "--cap-usd", "1",
                         "--already-spent-usd", "0.5", "--out", str(out), "--audit-every", "2", "--workers", "2"],
                        send=send, sleep=no_sleep)
            self.assertEqual(rc, 0)
            rows = [json.loads(x) for x in (out / "results.jsonl").read_text().splitlines()]
            self.assertEqual([r["pass"] for r in rows], [True, False, False])
            self.assertEqual(rows[1]["failures"], ["N2"])
            audit = [json.loads(x) for x in (out / "audit.jsonl").read_text().splitlines()]
            self.assertEqual([a["q"] for a in audit], ["Q001", "Q071"])
            self.assertTrue(all(a["agree_pass"] for a in audit))
            summary = (out / "summary.md").read_text()
            self.assertIn("| answerable | 1 | 1 | 1 | 1 |", summary)
            self.assertIn("| N2 | 0 | 1 | 0 | 1 |", summary)
            self.assertIn("Audit: pass agreement 2/2", summary)
            journal = [json.loads(x) for x in (out / "journal.jsonl").read_text().splitlines()]
            self.assertEqual(len(journal), 5)  # 3 main + 2 audit
            self.assertTrue(all(j["cost_usd"] > 0 for j in journal))
            self.assertEqual({j["model"] for j in journal}, {"claude-sonnet-5-5", "claude-opus-5-5"})


class CalibrationTest(unittest.TestCase):
    def entries(self):
        return J.read_jsonl(J.KNOWN)

    def test_known_file_covers_every_code_and_real_cases(self):
        entries = self.entries()
        cases = J.load_cases(J.DEFAULT_CASES) if J.DEFAULT_CASES.exists() else None
        bad = [e for e in entries if e["expect"] == "fail"]
        good = [e for e in entries if e["expect"] == "pass"]
        self.assertGreaterEqual(len(bad), 10)
        self.assertGreaterEqual(len(good), 3)
        self.assertEqual({c for e in bad for c in e["expect_codes"]}, set(J.CODES))
        if cases:
            for e in entries:
                self.assertIn(e["case_id"], cases)
            self.assertEqual({cases[e["case_id"]]["kind"] for e in good}, set(J.KINDS))

    def oracle(self, entries, flip=None):
        """Verdict = what the entry expects (an ideal judge), optionally wrong for one id."""
        def fn(request):
            msg = request["messages"][0]["content"]
            e = next(x for x in entries if x["answer"] in msg)
            if e["expect"] == "pass":
                v = {"pass": True, "correct": True, "failures": [], "reason": "ok"}
            else:
                v = {"pass": False, "correct": False, "failures": [e["expect_codes"][0]], "reason": "bad"}
            if flip == e["id"]:
                v = {"pass": True, "correct": True, "failures": [], "reason": "fooled"}
            return v
        return J.mock_transport(fn)

    def run_cal(self, send):
        with tempfile.TemporaryDirectory() as d:
            return J.main(["--calibrate", "--cap-usd", "5", "--out", str(Path(d) / "cal")], send=send, sleep=no_sleep)

    @unittest.skipUnless(J.DEFAULT_CASES.exists(), "donor cases file not present")
    def test_ideal_judge_passes_calibration(self):
        self.assertEqual(self.run_cal(self.oracle(self.entries())), 0)

    @unittest.skipUnless(J.DEFAULT_CASES.exists(), "donor cases file not present")
    def test_lenient_judge_fails_calibration(self):
        self.assertEqual(self.run_cal(J.mock_transport()), 3)

    @unittest.skipUnless(J.DEFAULT_CASES.exists(), "donor cases file not present")
    def test_one_fooled_verdict_fails_calibration(self):
        self.assertEqual(self.run_cal(self.oracle(self.entries(), flip="KB03")), 3)

    def test_check_calibration_wrong_code(self):
        entries = [{"id": "A", "expect": "fail", "expect_codes": ["N4"]},
                   {"id": "B", "expect": "pass", "expect_codes": []}]
        results = [{"id": "A", "status": "judged", "pass": False, "failures": ["N5"]},
                   {"id": "B", "status": "judged", "pass": True, "failures": []}]
        errs = J.check_calibration(entries, results)
        self.assertEqual(len(errs), 1)
        self.assertIn("expected one of ['N4']", errs[0])
        results[0]["failures"] = ["N4", "N5"]
        self.assertEqual(J.check_calibration(entries, results), [])


if __name__ == "__main__":
    unittest.main()
