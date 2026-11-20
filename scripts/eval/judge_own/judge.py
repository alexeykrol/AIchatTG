#!/usr/bin/env python3
"""AIchatTG's own answer judge: measures the owner's definition of answer quality on all 100 questions.

Definition: docs/proposals/2026-11-19-answer-quality-definition.md (sections 2, 3, 10). The stand's content judge
stays the external ruler for answerable questions; this judge also covers the 10 unanswerable questions (the
assistant never says "no": caveat + marked reasoning) and the 30 conflicting ones (paradox named, all positions,
no reconciliation on the author's behalf).

    python3 scripts/eval/judge_own/judge.py --answers output/eval/runs/<run>/answers.jsonl \\
        --key-env NAME --cap-usd X --already-spent-usd Y [--model claude-sonnet-5-5] [--out DIR] [--mock]
    python3 scripts/eval/judge_own/judge.py --calibrate --key-env NAME --cap-usd X [--mock]

Roles (llm-as-component): the model only judges one reply against one case; the join, the spend guard, the
final `pass` (= correct and no failure code), counts, audit agreement and calibration verdicts are code.

Safety: stdlib only; the key comes only from the environment variable named by --key-env (no .env file is read);
every call reserves a cost ceiling BEFORE the network (same rule as scripts/eval/lib/spend-guard.mjs) and the run
stops when the tranche cap would be exceeded; auth errors stop the whole run, transport errors retry at most 3
times; every call (allowed, refused, failed) goes to journal.jsonl with tokens and cost.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
DONOR = Path.home() / "Code" / "agi2claude"
DEFAULT_CASES = DONOR / "evals" / "golden" / "cases.jsonl"
DEFAULT_ID_MAP = DONOR / "evals" / "baseline" / "id_map.json"
RUBRIC = HERE / "rubric.md"
DEFAULT_BUILD = REPO / "output" / "eval" / "tcr-book-v4" / "build.json"
KNOWN = HERE / "known-bad.jsonl"
SPEND_GUARD_JS = REPO / "scripts" / "eval" / "lib" / "spend-guard.mjs"
API_URL = "https://api.anthropic.com/v1/messages"
KINDS = ("answerable", "unanswerable", "conflicting")
CODES = ("N1", "N2", "N3", "N4", "N5")
OVERHEAD_TOKENS = 64
MAX_TOKENS = 2000  # adaptive thinking can use 600+ tokens before the verdict (calibration 20.11: G01 hit max_tokens)
RETRYABLE = {408, 429, 500, 502, 503, 504, 529}


# ---------------------------------------------------------------- prices and spend guard

def load_prices(path: Path = SPEND_GUARD_JS) -> dict[str, dict[str, float]]:
    """PUBLISHED_PRICES from spend-guard.mjs (single source of the price table)."""
    text = path.read_text("utf-8")
    block = text[text.index("PUBLISHED_PRICES"):]
    block = block[:block.index("});") + 3]
    out = {}
    for m in re.finditer(r"'([\w.-]+)':\s*Object\.freeze\(\{([^}]*)\}\)", block):
        out[m.group(1)] = {k: float(v) for k, v in re.findall(r"(\w+):\s*([\d.]+)", m.group(2))}
    if not out:
        raise ValueError(f"no prices parsed from {path}")
    return out


class SpendCapReached(Exception):
    pass


class AuthError(Exception):
    pass


def input_token_ceiling(request: dict) -> int:
    """UTF-8 bytes of system + messages + overhead: an upper bound (Claude's tokenizer is byte-level)."""
    system = request.get("system") or ""
    if isinstance(system, list):
        system = "".join(b.get("text", "") for b in system)
    parts = [system] + [m["content"] if isinstance(m["content"], str) else json.dumps(m["content"], ensure_ascii=False)
                        for m in request.get("messages", [])]
    return sum(len(str(p).encode("utf-8")) for p in parts) + OVERHEAD_TOKENS


def cost_usd(usage: dict | None, price: dict) -> float:
    u = usage or {}
    return ((u.get("input_tokens") or 0) * price["input"] + (u.get("output_tokens") or 0) * price["output"]
            + (u.get("cache_read_input_tokens") or 0) * price.get("cacheRead", price["input"])
            + (u.get("cache_creation_input_tokens") or 0) * price.get("cacheWrite", price["input"])) / 1e6


class SpendGuard:
    """Reserve a ceiling before each call; refuse when settled + open reservations + ceiling > cap."""

    def __init__(self, cap_usd: float, already_spent_usd: float = 0.0, journal_path: Path | None = None):
        if not cap_usd or cap_usd <= 0:
            raise ValueError("spend_cap_required")
        self.cap = float(cap_usd)
        self.start = float(already_spent_usd or 0.0)
        self.settled = self.start
        self.reserved = 0.0
        self.stopped: dict | None = None
        self.journal: list[dict] = []
        self.journal_path = journal_path
        self.lock = threading.Lock()
        if journal_path:
            journal_path.parent.mkdir(parents=True, exist_ok=True)

    def _write(self, row: dict) -> None:
        line = {"at": datetime.now(UTC).isoformat(timespec="seconds"), **row}
        self.journal.append(line)
        if self.journal_path:
            with self.journal_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")

    def reserve(self, request: dict, price: dict, tag: str | None = None) -> dict:
        with self.lock:
            if self.stopped:
                raise SpendCapReached(self.stopped)
            in_tok = input_token_ceiling(request)
            out_tok = int(request.get("max_tokens") or 0)
            # cache writes cost more than plain input: the ceiling uses the dearer of the two
            in_price = max(price["input"], price.get("cacheWrite", price["input"]))
            ceiling = (in_tok * in_price + out_tok * price["output"]) / 1e6
            if self.settled + self.reserved + ceiling > self.cap:
                self.stopped = {"cap_usd": self.cap, "settled_usd": self.settled,
                                "open_reservations_usd": self.reserved, "next_ceiling_usd": ceiling, "tag": tag}
                self._write({"event": "refused", "tag": tag, "model": request.get("model"),
                             "ceiling_usd": ceiling, "settled_usd": self.settled, "cap_usd": self.cap})
                raise SpendCapReached(self.stopped)
            self.reserved += ceiling
            return {"tag": tag, "ceiling": ceiling, "in_tok": in_tok, "out_tok": out_tok, "price": price,
                    "model": request.get("model")}

    def settle(self, r: dict, usage: dict | None, status, stop_reason=None) -> float:
        with self.lock:
            self.reserved -= r["ceiling"]
            actual = cost_usd(usage, r["price"]) if usage else r["ceiling"]
            self.settled += actual
            self._write({"event": "call", "tag": r["tag"], "model": r["model"], "status": status,
                         "stop_reason": stop_reason, "ceiling_usd": r["ceiling"], "cost_usd": actual,
                         "cost_known": bool(usage), "usage": usage, "settled_usd": self.settled, "cap_usd": self.cap})
            return actual

    def spent_this_run(self) -> float:
        return self.settled - self.start


# ---------------------------------------------------------------- transports

def http_transport(api_key: str, timeout: float = 120.0):
    """Messages API over urllib. Returns (status, body_json_or_None)."""
    def send(request: dict):
        req = urllib.request.Request(API_URL, data=json.dumps(request).encode("utf-8"), method="POST", headers={
            "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.status, json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode("utf-8"))
            except Exception:  # noqa: BLE001
                body = None
            return e.code, body
    return send


def estimate_tokens(text: str) -> int:
    """Rough token estimate for mixed Russian/English text (used by the mock only; the guard uses bytes)."""
    return math.ceil(len(text) / 2.5)


def mock_transport(verdict_fn=None):
    """$0 transport. verdict_fn(request) -> verdict dict; default is a LENIENT judge that passes everything,
    so `--calibrate --mock` must fail: it proves the calibration gate catches a judge that cannot say no.

    Usage imitates prompt caching: the system prefix up to the block with cache_control is written to the cache on
    the first call of a model and read on the following ones; the rest is plain input."""
    seen: set[tuple[str, str]] = set()
    lock = threading.Lock()

    def send(request: dict):
        verdict = (verdict_fn or (lambda _r: {"pass": True, "correct": True, "failures": [], "book_chunks": [],
                                               "reason": "mock"}))(request)
        blocks = request["system"] if isinstance(request["system"], list) else [{"type": "text",
                                                                                   "text": request["system"]}]
        cut = max((i for i, b in enumerate(blocks) if b.get("cache_control")), default=-1)
        cached = "".join(b["text"] for b in blocks[:cut + 1])
        plain = "".join(b["text"] for b in blocks[cut + 1:]) + request["messages"][0]["content"]
        key = (request["model"], hashlib.sha256(cached.encode()).hexdigest())
        with lock:
            hit = key in seen
            seen.add(key)
        text = json.dumps(verdict, ensure_ascii=False)
        usage = {"input_tokens": estimate_tokens(plain), "output_tokens": estimate_tokens(text),
                 "cache_creation_input_tokens": 0 if (hit or not cached) else estimate_tokens(cached),
                 "cache_read_input_tokens": estimate_tokens(cached) if (hit and cached) else 0}
        return 200, {"model": request["model"], "stop_reason": "end_turn", "usage": usage,
                     "content": [{"type": "text", "text": text}]}
    return send


# ---------------------------------------------------------------- data

def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(x) for x in path.read_text("utf-8").splitlines() if x.strip()]


def load_cases(path: Path) -> dict[str, dict]:
    return {c["id"]: c for c in read_jsonl(path)}


def join(answers: list[dict], cases: dict[str, dict], id_map: list[dict]) -> tuple[list[dict], list[str]]:
    """One item per id_map row: the answer (by case_id) with its case. Returns (items, problems).

    Kind and question come from the golden case (the source of truth); an answer whose question differs from the
    case, a case id unknown to the golden set, or a duplicate answer is a problem, and the row is not judged."""
    problems: list[str] = []
    by_case: dict[str, dict] = {}
    for a in answers:
        cid = a.get("case_id")
        if cid in by_case:
            problems.append(f"duplicate answer for {cid}")
            continue
        by_case[cid] = a
    wanted = {r["case_id"] for r in id_map}
    for cid in by_case:
        if cid not in wanted:
            problems.append(f"answer for {cid} is not in the id map")
    items = []
    for row in id_map:
        cid = row["case_id"]
        case = cases.get(cid)
        if case is None:
            problems.append(f"{row['q']}: case {cid} not in cases file")
            continue
        if row.get("kind") and row["kind"] != case["kind"]:
            problems.append(f"{row['q']}: id map kind {row['kind']} != case kind {case['kind']}")
        a = by_case.get(cid)
        item = {"q": row["q"], "case_id": cid, "kind": case["kind"], "question": case["question"],
                "reference": case.get("expected", ""), "support": case.get("support") or [], "answer": None,
                "status": "pending"}
        if a is None:
            item["status"] = "missing_answer"
        elif a.get("question") and a["question"].strip() != case["question"].strip():
            problems.append(f"{row['q']}: answer question differs from case {cid}")
            item["status"] = "question_mismatch"
        else:
            item["answer"] = a.get("answer") or ""
            item["chunk_ids"] = parse_id_list(a.get("chunk_ids"))
            item["unit_ids"] = parse_id_list(a.get("unit_ids"))
        items.append(item)
    return items, problems


def parse_id_list(v) -> list[str]:
    """chunk_ids / unit_ids as written by ask-offline (a JSON list; tolerate a JSON or Python-repr string)."""
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    s = str(v).strip()
    try:
        return [str(x) for x in json.loads(s)]
    except json.JSONDecodeError:
        return re.findall(r"'([^']+)'", s)


# ---------------------------------------------------------------- the book (the package, read-only)

GAP_CLASSES = ("in_base_found", "in_base_missed", "not_in_base")


def resolve_package(arg: Path | None) -> Path:
    """--package as a package dir or an ai.db file; default: `database` of output/eval/tcr-book-v4/build.json."""
    if arg is None:
        build = json.loads(DEFAULT_BUILD.read_text("utf-8"))
        arg = Path(build["database"])
    arg = Path(arg).expanduser()
    db = arg / "ai.db" if arg.is_dir() else arg
    if not db.is_file():
        raise FileNotFoundError(f"package database not found: {db}")
    return db.resolve()


def _order_key(order_path: str | None, unit_id: str):
    try:
        return (json.loads(order_path or "[]"), unit_id)
    except json.JSONDecodeError:
        return ([], unit_id)


class Book:
    """The whole knowledge base as one static text block, plus a chunk index for the gap bookkeeping.

    Every record is headed `=== RECORD <unit_id> — <title> ===`, every chunk `[chunk <chunk_id>] <section>`, so the
    judge can name the exact places that hold an answer; code maps them back to records."""

    def __init__(self, db: Path):
        self.db = db
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            units = sorted(con.execute("SELECT unit_id, order_path, title FROM units").fetchall(),
                           key=lambda u: _order_key(u["order_path"], u["unit_id"]))
            self.chunks: dict[str, dict] = {}
            self.unit_titles: dict[str, str] = {}
            parts = []
            for u in units:
                self.unit_titles[u["unit_id"]] = u["title"]
                parts.append(f"=== RECORD {u['unit_id']} — {u['title']} ===")
                for c in con.execute("SELECT chunk_id, section_path, content FROM chunks WHERE unit_id = ? "
                                     "ORDER BY ord", (u["unit_id"],)):
                    self.chunks[c["chunk_id"]] = {"unit_id": u["unit_id"], "title": u["title"],
                                                  "section": c["section_path"] or ""}
                    parts.append(f"[chunk {c['chunk_id']}]" + (f" {c['section_path']}" if c["section_path"] else "")
                                 + f"\n{c['content'].strip()}")
                parts.append("")
        finally:
            con.close()
        self.text = ("THE BOOK — the complete knowledge base («Теория каст и ролей»), "
                     f"{len(self.unit_titles)} records:\n\n" + "\n\n".join(parts).strip() + "\n")

    def material_list(self, item: dict) -> str:
        """What the assistant had: ids and short titles only (the content is in the book block)."""
        chunk_ids = item.get("chunk_ids") or []
        if chunk_ids:
            lines = []
            for cid in chunk_ids:
                c = self.chunks.get(cid)
                lines.append(f"- {cid} — {c['title']}" + (f" / {c['section']}" if c and c["section"] else "")
                             if c else f"- {cid} — (not in the book index)")
            return "\n".join(lines)
        unit_ids = item.get("unit_ids") or []
        if unit_ids:
            return "\n".join(f"- record {u} — {self.unit_titles.get(u, '(unknown)')}" for u in unit_ids)
        return "(none)"

    def classify_gap(self, cited: list[str], item: dict) -> dict:
        """Code-side bookkeeping: where the answer is in the book vs what the assistant had.

        `cited` are the chunk (or record) ids the judge named as containing the answer. Unknown ids are dropped.
        Assistant coverage is compared at chunk level when the answer row carries chunk ids, else at record level."""
        chunks, units, unknown = [], [], []
        for x in cited:
            if x in self.chunks:
                chunks.append(x)
                units.append(self.chunks[x]["unit_id"])
            elif x in self.unit_titles:
                units.append(x)
            else:
                unknown.append(x)
        chunks, units = sorted(set(chunks)), sorted(set(units))
        had_chunks = set(item.get("chunk_ids") or [])
        had_units = set(item.get("unit_ids") or []) | {self.chunks[c]["unit_id"] for c in had_chunks
                                                         if c in self.chunks}
        if not units:
            cls = "not_in_base"
        elif had_chunks:
            # a record-level citation counts as found only if the assistant had some chunk of that record
            hit = any(c in had_chunks for c in chunks) or any(
                u in had_units for u in units if not any(self.chunks[c]["unit_id"] == u for c in chunks))
            cls = "in_base_found" if hit else "in_base_missed"
        else:
            cls = "in_base_found" if any(u in had_units for u in units) else "in_base_missed"
        return {"gap_class": cls, "gap_records": units, "gap_chunks": chunks, "gap_unknown_ids": unknown}


def user_message(item: dict, book: Book | None = None) -> str:
    quotes = "\n".join(f"- [{s.get('unit_id', '?')}] «{s.get('quote', '')}»" for s in item["support"]) or "(none)"
    had = book.material_list(item) if book else "(not supplied)"
    return (f"Case kind: {item['kind']}\n\nQuestion:\n{item['question']}\n\nReference (what a good answer contains, "
            f"from the book):\n{item['reference']}\n\nSupporting book quotes:\n{quotes}\n\n"
            f"Material the assistant had when answering (ids and titles only; the text is in THE BOOK):\n{had}\n\n"
            f"<reply>\n{item['answer']}\n</reply>\n\nReturn the JSON object only.")


def build_request(rubric: str, item: dict, model: str, book: Book | None = None) -> dict:
    """Static prefix (rubric, then the whole book) is cached; everything per question is in the user message."""
    if book:
        system = [{"type": "text", "text": rubric},
                  {"type": "text", "text": book.text, "cache_control": {"type": "ephemeral"}}]
    else:
        system = [{"type": "text", "text": rubric, "cache_control": {"type": "ephemeral"}}]
    return {"model": model, "max_tokens": MAX_TOKENS, "system": system,
            "messages": [{"role": "user", "content": user_message(item, book)}]}


def normalize_code(c) -> str | None:
    s = str(c).strip().upper().replace("Н", "N").replace("H", "N")  # Cyrillic Н / Latin H look-alikes
    return s if s in CODES else None


def parse_verdict(text: str) -> dict:
    """Strict: pass/correct booleans, failures from the closed list, book_chunks a list of ids, reason string."""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        raise ValueError("no JSON object in judge output")
    v = json.loads(m.group(0))
    if not isinstance(v.get("pass"), bool) or not isinstance(v.get("correct"), bool):
        raise ValueError("pass/correct must be booleans")
    if not isinstance(v.get("failures"), list):
        raise ValueError("failures must be a list")
    codes = [normalize_code(c) for c in v["failures"]]
    if any(c is None for c in codes):
        raise ValueError(f"unknown failure code in {v['failures']}")
    cited = v.get("book_chunks", [])
    if not isinstance(cited, list) or not all(isinstance(x, str) for x in cited):
        raise ValueError("book_chunks must be a list of id strings")
    return {"model_pass": v["pass"], "correct": v["correct"], "failures": sorted(set(codes)),
            "book_chunks": cited, "reason": str(v.get("reason", ""))}


# ---------------------------------------------------------------- judging

def call_judge(send, guard: SpendGuard, request: dict, price: dict, tag: str, sleep=time.sleep) -> dict:
    """One verdict with bounded retry. Raises SpendCapReached / AuthError (run-terminal)."""
    last = None
    for attempt in range(3):
        r = guard.reserve(request, price, tag)
        try:
            status, body = send(request)
        except Exception as e:  # noqa: BLE001 - transport failure
            guard.settle(r, None, "transport_failed")
            last = f"transport: {e}"
            sleep(2 ** (attempt + 1))
            continue
        usage = body.get("usage") if (status == 200 and body) else None
        cost = guard.settle(r, usage, status, (body or {}).get("stop_reason"))
        if status in (401, 403):
            raise AuthError(f"HTTP {status}")
        if status in RETRYABLE:
            last = f"HTTP {status}"
            sleep(2 ** (attempt + 1))
            continue
        if status != 200:
            return {"status": "judge_error", "error": f"HTTP {status}: {json.dumps(body)[:300]}", "cost_usd": cost}
        text = "".join(b.get("text", "") for b in body.get("content", []) if b.get("type") == "text")
        try:
            v = parse_verdict(text)
        except (ValueError, json.JSONDecodeError) as e:
            return {"status": "judge_error", "error": f"parse: {e}", "raw": text[:500], "cost_usd": cost,
                    "usage": usage, "stop_reason": body.get("stop_reason")}
        v["pass"] = v["correct"] and not v["failures"]  # code decides pass from the parts
        return {"status": "judged", **v, "cost_usd": cost, "usage": usage, "model": body.get("model")}
    return {"status": "judge_error", "error": f"retries exhausted ({last})", "cost_usd": 0.0}


def judge_items(items: list[dict], send, guard: SpendGuard, rubric: str, model: str, prices: dict,
                workers: int = 2, sleep=time.sleep, book: Book | None = None) -> tuple[list[dict], str | None]:
    """Judge every pending item; returns (results in item order, stop reason or None).

    The first pending item runs alone so the cached prefix (rubric + book) is written once; the rest then read it."""
    price = prices[model]
    results: list[dict | None] = [None] * len(items)
    stop: dict = {}

    def one(i: int) -> None:
        it = items[i]
        base = {k: it[k] for k in ("q", "case_id", "kind")}
        if it["status"] != "pending":
            results[i] = {**base, "status": it["status"], "pass": False}
            return
        if stop:
            results[i] = {**base, "status": "not_judged", "pass": False, "error": stop["reason"]}
            return
        try:
            res = call_judge(send, guard, build_request(rubric, it, model, book), price, f"{it['q']}:{model}", sleep)
        except SpendCapReached as e:
            stop.setdefault("reason", f"spend cap: {e}")
            res = {"status": "not_judged", "error": "spend cap reached"}
        except AuthError as e:
            stop.setdefault("reason", f"auth error (not retried): {e}")
            res = {"status": "not_judged", "error": str(e)}
        res.setdefault("pass", False)
        if res["status"] == "judged" and book:
            res.update(book.classify_gap(res["book_chunks"], it))
        results[i] = {**base, "judge_model": model, **res}

    pending = [i for i, it in enumerate(items) if it["status"] == "pending"]
    first = pending[:1]
    for i in first:
        one(i)
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        list(ex.map(one, [i for i in range(len(items)) if i not in first]))
    return [r for r in results if r is not None], stop.get("reason")


def audit(items, main, send, guard, rubric, model, prices, every: int, workers, sleep, book=None):
    """Re-judge every `every`-th judged case with a second model; agreement on pass, failure set and gap class."""
    if every <= 0:
        return [], None
    pick = [i for i in range(0, len(items), every) if main[i]["status"] == "judged"]
    sub = [items[i] for i in pick]
    res, stop = judge_items(sub, send, guard, rubric, model, prices, workers, sleep, book)
    rows = []
    for i, r in zip(pick, res):
        m = main[i]
        ok = r["status"] == "judged"
        rows.append({"q": m["q"], "case_id": m["case_id"], "kind": m["kind"], "main_pass": m["pass"],
                     "main_failures": m.get("failures"), "main_gap": m.get("gap_class"),
                     "audit_status": r["status"], "audit_pass": r.get("pass"), "audit_failures": r.get("failures"),
                     "audit_gap": r.get("gap_class"), "audit_reason": r.get("reason"),
                     "agree_pass": ok and r["pass"] == m["pass"],
                     "agree_failures": ok and r.get("failures") == m.get("failures"),
                     "agree_gap": ok and r.get("gap_class") == m.get("gap_class"),
                     "cost_usd": r.get("cost_usd", 0.0)})
    return rows, stop


# ---------------------------------------------------------------- reporting

def cache_stats(guard: SpendGuard) -> dict:
    out = {"calls": 0, "input": 0, "cache_write": 0, "cache_read": 0, "output": 0}
    for j in guard.journal:
        u = j.get("usage") or {}
        if j.get("event") != "call":
            continue
        out["calls"] += 1
        out["input"] += u.get("input_tokens") or 0
        out["cache_write"] += u.get("cache_creation_input_tokens") or 0
        out["cache_read"] += u.get("cache_read_input_tokens") or 0
        out["output"] += u.get("output_tokens") or 0
    return out


def summarize(results: list[dict], audit_rows: list[dict], guard: SpendGuard, meta: dict) -> str:
    lines = [f"# Own judge — {meta['title']}", "",
             f"- answers: `{meta.get('answers')}`", f"- judge: `{meta['model']}`, audit: `{meta.get('audit_model')}` "
             f"every {meta.get('audit_every')}th", f"- rubric sha256: `{meta['rubric_sha256'][:12]}`",
             f"- book: `{meta.get('package_db')}`", f"- mock: {meta['mock']}", ""]
    lines += ["| Kind | Pass | Correct | Judged | Total |", "| --- | --- | --- | --- | --- |"]
    for kind in (*KINDS, None):
        rows = [r for r in results if kind is None or r["kind"] == kind]
        if not rows:
            continue
        judged = [r for r in rows if r["status"] == "judged"]
        lines.append(f"| {kind or 'all'} | {sum(r['pass'] for r in judged)} | "
                     f"{sum(bool(r.get('correct')) for r in judged)} | {len(judged)} | {len(rows)} |")
    lines += ["", "| Failure | " + " | ".join(KINDS) + " | all |", "| --- |" + " --- |" * (len(KINDS) + 1)]
    for code in CODES:
        per = [sum(code in (r.get("failures") or []) for r in results if r["kind"] == k) for k in KINDS]
        lines.append(f"| {code} | " + " | ".join(map(str, per)) + f" | {sum(per)} |")
    if any(r.get("gap_class") for r in results):
        lines += ["", "| Gap class | " + " | ".join(KINDS) + " | all |", "| --- |" + " --- |" * (len(KINDS) + 1)]
        for g in GAP_CLASSES:
            per = [sum(r.get("gap_class") == g for r in results if r["kind"] == k) for k in KINDS]
            lines.append(f"| {g} | " + " | ".join(map(str, per)) + f" | {sum(per)} |")
        missed = [r["q"] for r in results if r.get("gap_class") == "in_base_missed"]
        if missed:
            lines += ["", "Retrieval defects (in_base_missed): " + ", ".join(missed)]
    other = {}
    for r in results:
        if r["status"] != "judged":
            other[r["status"]] = other.get(r["status"], 0) + 1
    if other:
        lines += ["", "Not judged: " + ", ".join(f"{k} {v}" for k, v in sorted(other.items()))]
    if audit_rows:
        ok = [a for a in audit_rows if a["audit_status"] == "judged"]
        lines += ["", f"Audit: pass agreement {sum(a['agree_pass'] for a in ok)}/{len(ok)}, "
                      f"failure-set agreement {sum(a['agree_failures'] for a in ok)}/{len(ok)}, "
                      f"gap-class agreement {sum(a['agree_gap'] for a in ok)}/{len(ok)}"]
    cs = cache_stats(guard)
    lines += ["", f"Tokens: input {cs['input']}, cache write {cs['cache_write']}, cache read {cs['cache_read']}, "
                  f"output {cs['output']} over {cs['calls']} calls",
              f"Spend this run: ${guard.spent_this_run():.4f}; tranche total ${guard.settled:.4f} of cap "
              f"${guard.cap:.2f}" + (f"; STOPPED: {meta['stop']}" if meta.get("stop") else "")]
    return "\n".join(lines) + "\n"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------- calibration

def check_calibration(entries: list[dict], results: list[dict]) -> list[str]:
    """Bad entries must fail with one of their expected codes; good ones must pass; `expect: any` checks only the
    gap class; an `expect_gap` is checked on any entry that has it."""
    errors = []
    by_id = {r["id"]: r for r in results}
    for e in entries:
        r = by_id.get(e["id"])
        if r is None or r["status"] != "judged":
            errors.append(f"{e['id']}: not judged ({r and r.get('status')})")
            continue
        if e["expect"] == "pass":
            if not r["pass"]:
                errors.append(f"{e['id']}: good answer failed {r.get('failures')} correct={r.get('correct')}")
        elif e["expect"] == "fail":
            want = {normalize_code(c) for c in e["expect_codes"]}
            if r["pass"]:
                errors.append(f"{e['id']}: bad answer PASSED (expected {sorted(want)})")
            elif not want & set(r.get("failures") or []):
                errors.append(f"{e['id']}: failed with {r.get('failures')} but expected one of {sorted(want)}")
        if e.get("expect_gap") and r.get("gap_class") != e["expect_gap"]:
            errors.append(f"{e['id']}: gap_class {r.get('gap_class')} (records {r.get('gap_records')}), "
                          f"expected {e['expect_gap']}")
    return errors


def calibration_items(entries: list[dict], cases: dict[str, dict]) -> list[dict]:
    items = []
    for e in entries:
        c = cases[e["case_id"]]
        items.append({"q": e["id"], "case_id": c["id"], "kind": c["kind"], "question": c["question"],
                      "reference": c.get("expected", ""), "support": c.get("support") or [],
                      "answer": e["answer"], "status": "pending", "chunk_ids": list(e.get("assistant_chunks") or [])})
    return items


# ---------------------------------------------------------------- CLI

def parse_args(argv):
    ap = argparse.ArgumentParser(description="AIchatTG own answer judge (owner's definition of answer quality)")
    ap.add_argument("--answers", type=Path, help="answers.jsonl of an ask-offline run")
    ap.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    ap.add_argument("--id-map", type=Path, default=DEFAULT_ID_MAP)
    ap.add_argument("--key-env", help="environment variable holding the Anthropic key (live only)")
    ap.add_argument("--model", default="claude-sonnet-5-5")
    ap.add_argument("--audit-model", default="claude-opus-5-5")
    ap.add_argument("--audit-every", type=int, default=10, help="re-judge every Nth case; 0 = no audit")
    ap.add_argument("--cap-usd", type=float, required=True, help="tranche cap, USD")
    ap.add_argument("--already-spent-usd", type=float, default=0.0, help="money already spent in this tranche")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--workers", type=int, default=2,
                    help="parallel calls after the first (each reserves a ~$0.86/$1.72 ceiling)")
    ap.add_argument("--mock", action="store_true", help="$0 lenient mock transport")
    ap.add_argument("--calibrate", action="store_true", help="judge known-bad.jsonl; non-zero exit unless all hold")
    ap.add_argument("--known", type=Path, default=KNOWN)
    ap.add_argument("--package", type=Path, default=None,
                    help="knowledge package dir or ai.db (read-only); the judge gets the WHOLE book from it; "
                         "default: database of output/eval/tcr-book-v4/build.json")
    ap.add_argument("--no-book", action="store_true",
                    help="no book for the judge (old behaviour; N1 then over-fires and no gap class)")
    return ap.parse_args(argv)


def main(argv=None, send=None, sleep=time.sleep) -> int:
    args = parse_args(argv)
    prices = load_prices()
    for m in (args.model, args.audit_model):
        if m not in prices:
            raise SystemExit(f"no published price for {m}")
    if send is None:
        if args.mock:
            send = mock_transport()
        else:
            if not args.key_env or not os.environ.get(args.key_env):
                raise SystemExit("live judging needs --key-env <ENV NAME> holding an Anthropic key")
            send = http_transport(os.environ[args.key_env])
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    out = args.out or (REPO / "output" / "eval" / "judge-own" /
                       (stamp + ("-calibration" if args.calibrate else "") + ("-mock" if args.mock else "")))
    out.mkdir(parents=True, exist_ok=True)
    guard = SpendGuard(args.cap_usd, args.already_spent_usd, out / "journal.jsonl")
    rubric = RUBRIC.read_text("utf-8")
    cases = load_cases(args.cases)
    book = None if args.no_book else Book(resolve_package(args.package))
    meta = {"model": args.model, "mock": args.mock, "rubric_sha256": sha256(RUBRIC),
            "cases_sha256": sha256(args.cases), "created_at": stamp,
            "package_db": str(book.db) if book else None,
            "package_db_sha256": sha256(book.db) if book else None,
            "book_chars": len(book.text) if book else 0, "book_bytes": len(book.text.encode()) if book else 0}

    if args.calibrate:
        entries = read_jsonl(args.known)
        items = calibration_items(entries, cases)
        results, stop = judge_items(items, send, guard, rubric, args.model, prices, args.workers, sleep, book)
        for r in results:
            r["id"] = r.pop("q")
        errors = check_calibration(entries, results)
        with (out / "results.jsonl").open("w", encoding="utf-8") as f:
            for e, r in zip(entries, results):
                f.write(json.dumps({**r, "expect": e["expect"], "expect_codes": e.get("expect_codes", []),
                                    "expect_gap": e.get("expect_gap")}, ensure_ascii=False) + "\n")
        report = [f"# Own judge calibration ({len(entries)} entries)" + (" — MOCK" if args.mock else ""), "",
                  "| Id | Case | Expect | Got pass | Failures | Gap |", "| --- | --- | --- | --- | --- | --- |"]
        for e, r in zip(entries, results):
            exp = {"pass": "pass", "any": "any"}.get(e["expect"]) or "fail " + "/".join(e["expect_codes"])
            if e.get("expect_gap"):
                exp += f", gap {e['expect_gap']}"
            report.append(f"| {e['id']} | {e['case_id']} | {exp} | {r.get('pass')} | {r.get('failures')} | "
                          f"{r.get('gap_class')} |")
        cs = cache_stats(guard)
        report += ["", "Result: " + ("OK" if not errors else "FAILED"), *[f"- {x}" for x in errors], "",
                   f"Tokens: input {cs['input']}, cache write {cs['cache_write']}, cache read {cs['cache_read']}, "
                   f"output {cs['output']}",
                   f"Spend: ${guard.spent_this_run():.4f} (tranche total ${guard.settled:.4f} of ${guard.cap:.2f})"
                   + (f"; STOPPED: {stop}" if stop else "")]
        (out / "summary.md").write_text("\n".join(report) + "\n", encoding="utf-8")
        (out / "manifest.json").write_text(json.dumps({**meta, "known_sha256": sha256(args.known)}, indent=2) + "\n")
        print("\n".join(report))
        print(json.dumps({"out": str(out), "calibration_ok": not errors, "spent_usd": guard.spent_this_run(),
                          "tranche_total_usd": guard.settled}))
        return 0 if not errors else 3

    if not args.answers:
        raise SystemExit("--answers is required (or --calibrate)")
    answers = read_jsonl(args.answers)
    id_map = json.loads(args.id_map.read_text("utf-8"))
    items, problems = join(answers, cases, id_map)
    if book:
        for it in items:
            unknown = [c for c in it.get("chunk_ids") or [] if c not in book.chunks]
            if unknown:
                problems.append(f"{it['q']}: chunk ids not in the book: {unknown}")
    results, stop = judge_items(items, send, guard, rubric, args.model, prices, args.workers, sleep, book)
    audit_rows, audit_stop = ([], None) if stop else audit(items, results, send, guard, rubric, args.audit_model,
                                                          prices, args.audit_every, args.workers, sleep, book)
    meta.update({"title": f"{len(items)} questions", "answers": str(args.answers),
                 "answers_sha256": sha256(args.answers), "audit_model": args.audit_model,
                 "audit_every": args.audit_every, "stop": stop or audit_stop, "join_problems": problems})
    with (out / "results.jsonl").open("w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with (out / "audit.jsonl").open("w", encoding="utf-8") as f:
        for r in audit_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    summary = summarize(results, audit_rows, guard, meta)
    if problems:
        summary += "\nJoin problems:\n" + "\n".join(f"- {p}" for p in problems) + "\n"
    (out / "summary.md").write_text(summary, encoding="utf-8")
    (out / "manifest.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
    print(summary)
    print(json.dumps({"out": str(out), "spent_usd": guard.spent_this_run(), "tranche_total_usd": guard.settled,
                      "stopped": bool(stop or audit_stop)}))
    return 4 if (stop or audit_stop) else 0


if __name__ == "__main__":
    raise SystemExit(main())
