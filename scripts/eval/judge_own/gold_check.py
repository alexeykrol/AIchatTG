#!/usr/bin/env python3
"""Check the test's own reference for multi-position questions, before judging answers against it.

For every case of the chosen kind (default: conflicting) a model other than the answer judge reads the whole book
(cached), the question, the supporting quotes and the test's expected answer, and says what relation the book's
places actually have. The case kind label is NOT shown. Output: results.jsonl + summary.md.

  python3 scripts/eval/judge_own/gold_check.py --key-env EVAL_ANTHROPIC_KEY --model claude-opus-5-5 \
      --package output/kb/tcr-passages-v1/pkg-markup-v1-links --cap-usd 79.6 --already-spent-usd 59.61 \
      --out output/eval/judge-own/gold-check-conflicting
"""
import argparse, json, os, sys, time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import judge as J  # noqa: E402

RELATIONS = ("direct_contradiction", "tension_unresolved", "author_qualification", "author_resolved",
             "different_subject", "no_tension")
FAIRNESS = ("fair", "overstated", "understated", "wrong")

SYSTEM = """You check one item of a test for a book-based assistant. You are given the whole book, a reader's \
question, quotes the test treats as the places that answer it, and the answer the test expects.

First, on your own, read the quoted places in the book together with their surroundings and decide what relation \
the book's places have with respect to the question. Exactly one of:
- direct_contradiction: two places say opposite things about the same subject, and the author does not reconcile them.
- tension_unresolved: the places pull in different directions about the same subject; not strictly opposite, \
the author leaves it open.
- author_qualification: one place states a rule, another narrows it (an exception, a condition, a limit); the book \
itself makes the second a qualification of the first.
- author_resolved: the places look opposite, but the book itself explains how both hold.
- different_subject: the places speak about different things (different caste, role, period, scope), so there is \
no tension between them; the question conflates them.
- no_tension: there is one consistent position in the book.

Then compare with the test's expected answer and say whether it is fair to the book: fair; overstated (it claims \
more conflict or certainty than the book has); understated (it hides a real conflict); wrong (it misreads the book).

List what a faithful answer must say (2–4 short points, each tied to a chunk id), and the chunk ids you used.
Answer in Russian inside the JSON strings. Return only this JSON object:
{"relation": "...", "expected_fair": "...", "must_say": ["..."], "book_chunks": ["..."], "reason": "..."}"""


def user_message(case: dict) -> str:
    quotes = "\n".join(f"- [{s.get('unit_id', '?')}] «{s.get('quote', '')}»" for s in case.get("support") or [])
    return (f"Question:\n{case['question']}\n\nQuotes the test treats as the answer's places:\n{quotes}\n\n"
            f"The test's expected answer:\n{case.get('expected', '')}\n\nReturn the JSON object only.")


def build_request(book: J.Book, case: dict, model: str) -> dict:
    return {"model": model, "max_tokens": J.MAX_TOKENS,
            "system": [{"type": "text", "text": SYSTEM},
                       {"type": "text", "text": book.text, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": user_message(case)}]}


def parse(text: str) -> dict:
    import re
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        raise ValueError("no JSON object")
    v = json.loads(m.group(0))
    if v.get("relation") not in RELATIONS or v.get("expected_fair") not in FAIRNESS:
        raise ValueError(f"bad labels: {v.get('relation')} / {v.get('expected_fair')}")
    return {"relation": v["relation"], "expected_fair": v["expected_fair"],
            "must_say": [str(x) for x in v.get("must_say") or []],
            "book_chunks": [str(x) for x in v.get("book_chunks") or []], "reason": str(v.get("reason", ""))}


def call(send, guard, request, price, tag, sleep=time.sleep) -> dict:
    last = None
    for attempt in range(3):
        r = guard.reserve(request, price, tag)
        try:
            status, body = send(request)
        except Exception as e:  # noqa: BLE001
            guard.settle(r, None, "transport_failed")
            last = f"transport: {e}"
            sleep(2 ** (attempt + 1))
            continue
        usage = body.get("usage") if (status == 200 and body) else None
        cost = guard.settle(r, usage, status, (body or {}).get("stop_reason"))
        if status in (401, 403):
            raise J.AuthError(f"HTTP {status}")
        if status in J.RETRYABLE:
            last = f"HTTP {status}"
            sleep(2 ** (attempt + 1))
            continue
        if status != 200:
            return {"status": "error", "error": f"HTTP {status}", "cost_usd": cost}
        text = "".join(b.get("text", "") for b in body.get("content", []) if b.get("type") == "text")
        try:
            return {"status": "checked", **parse(text), "cost_usd": cost, "usage": usage}
        except (ValueError, json.JSONDecodeError) as e:
            return {"status": "error", "error": f"parse: {e}", "raw": text[:500], "cost_usd": cost}
    return {"status": "error", "error": f"retries exhausted ({last})", "cost_usd": 0.0}


def main(argv=None, send=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cases", type=Path, default=J.DEFAULT_CASES)
    ap.add_argument("--id-map", type=Path, default=J.DEFAULT_ID_MAP)
    ap.add_argument("--kind", default="conflicting")
    ap.add_argument("--only", default="", help="comma-separated q ids")
    ap.add_argument("--package", type=Path, required=True)
    ap.add_argument("--model", default="claude-opus-5-5")
    ap.add_argument("--key-env")
    ap.add_argument("--cap-usd", type=float, required=True)
    ap.add_argument("--already-spent-usd", type=float, default=0.0)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    prices = J.load_prices()
    if args.model not in prices:
        raise SystemExit(f"no published price for {args.model}")
    if send is None:
        if not args.key_env or not os.environ.get(args.key_env):
            raise SystemExit("needs --key-env <ENV NAME> holding an Anthropic key")
        send = J.http_transport(os.environ[args.key_env])
    args.out.mkdir(parents=True, exist_ok=True)
    guard = J.SpendGuard(args.cap_usd, args.already_spent_usd, args.out / "journal.jsonl")
    cases = J.load_cases(args.cases)
    only = {x.strip() for x in args.only.split(",") if x.strip()}
    rows = [r for r in json.loads(args.id_map.read_text("utf-8"))
            if r["kind"] == args.kind and (not only or r["q"] in only)]
    book = J.Book(J.resolve_package(args.package))
    results, stop = [], None
    for row in rows:
        case = cases[row["case_id"]]
        try:
            res = call(send, guard, build_request(book, case, args.model), prices[args.model], row["q"])
        except J.SpendCapReached as e:
            stop = e.args[0] if e.args else "cap"
            break
        results.append({"q": row["q"], "case_id": row["case_id"], "question": case["question"], **res})
        with (args.out / "results.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(results[-1], ensure_ascii=False) + "\n")
    rel = Counter(r.get("relation") for r in results if r["status"] == "checked")
    fair = Counter(r.get("expected_fair") for r in results if r["status"] == "checked")
    lines = [f"# Gold check ({args.kind}, {len(results)} of {len(rows)}, model {args.model})", "",
             "Relations: " + ", ".join(f"{k} {v}" for k, v in rel.most_common()),
             "Expected answer: " + ", ".join(f"{k} {v}" for k, v in fair.most_common()), "",
             "| Q | relation | expected | reason |", "| --- | --- | --- | --- |"]
    for r in results:
        lines.append(f"| {r['q']} | {r.get('relation', r['status'])} | {r.get('expected_fair', '')} | "
                     f"{(r.get('reason') or r.get('error') or '').replace('|', '/')[:300]} |")
    lines += ["", f"Spend: ${guard.spent_this_run():.4f} (tranche total ${guard.settled:.4f} of ${guard.cap:.2f})"
              + (f"; STOPPED: {stop}" if stop else "")]
    (args.out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(args.out), "checked": len(results), "spent_usd": guard.spent_this_run(),
                      "tranche_total_usd": guard.settled, "stopped": stop}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
