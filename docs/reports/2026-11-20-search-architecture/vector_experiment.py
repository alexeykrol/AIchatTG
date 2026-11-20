#!/usr/bin/env python3
"""Vector (semantic) retrieval vs the current lexical retrieval — free, local, offline.

Reads (read-only):
  * a knowledge package `ai.db` (SQLite: units, chunks, FTS5);
  * `answers.jsonl` of a $0 lexical retrieval run (fields q, kind, question, gold_units,
    unit_ids, chunk_ids, pack_status, confidence, domain_signal, diagnostics);
  * optionally a wider lexical run and a paid run (lexical + LLM rewrite) for comparison.

Writes only what you point it at: `--tsv` (per-question table) and `--json` (all numbers).
`--show Q044` prints a question with its three nearest text windows (eyeball check).

What is measured:
  1. index variants: whole chunks as they are (model limit, and a raised limit) and small
     sentence windows mapped back to their chunk and record;
  2. vector top-k chunks -> set of records: "all gold records found" / "at least one";
  3. hybrids with the lexical run: union, RRF into a common top-12, 6+6 split;
  4. controls: chance level (random k chunks) and an ungated raw FTS5 BM25 query;
  5. free signals "the lexical result is weak" as triggers for the vector step;
  6. best cosine for answerable vs unanswerable questions ("not in the book");
  7. indexing / query time and index size, with a synthetic scale-up of the search step.

No network, no paid calls: the embedding model must already be in the Hugging Face cache.
Run with the offline flags (the script also sets them itself):

  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 python vector_experiment.py \
      --db .../ai.db --lexical .../retrieval-fixed-w12/answers.jsonl \
      --lexical-wide .../retrieval-fixed-w64/answers.jsonl \
      --paid .../20261120T222036Z-live/answers.jsonl \
      --model sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 \
      --tsv out.tsv --json out.json

For e5-style models pass `--query-prefix "query: " --passage-prefix "passage: "`.

Role split (llm-as-component): the model only produces vectors; every count, rank, union,
fusion and threshold below is plain deterministic code.
"""
import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import argparse
import ast
import itertools
import json
import math
import platform
import random
import re
import sqlite3
import statistics
import sys
import time

import numpy as np

PRIMARY_VARIANT = "win3"   # fixed BEFORE looking at results: 3-sentence windows, overlap 1
PRIMARY_K = 12
KS = (6, 9, 12, 24)
RRF_K = 60
MIN_SENT_CHARS = 25
JUDGE_MISSED = ["Q009", "Q030", "Q035", "Q037", "Q042", "Q043", "Q044", "Q045", "Q046",
                "Q084", "Q090", "Q092"]

STOP_RU = set("""и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по
только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть
был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней
для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому
этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда
можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много
разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда
конечно всю между это очень просто почему""".split())


# ----------------------------------------------------------------------------- loading

def as_list(value):
    """A list field may be a real list, a JSON string or a python-repr string."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    text = str(value).strip()
    if not text:
        return []
    try:
        return list(json.loads(text))
    except Exception:
        return list(ast.literal_eval(text))


def load_run(path):
    rows = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            row = json.loads(line)
            row["gold_units"] = as_list(row.get("gold_units"))
            row["unit_ids"] = as_list(row.get("unit_ids"))
            row["chunk_ids"] = as_list(row.get("chunk_ids"))
            rows[row["q"]] = row
    return rows


def load_chunks(db_path):
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT c.chunk_id, c.unit_id, c.section_path, c.ord, c.content, c.token_count
             FROM chunks c JOIN units u ON u.unit_id = c.unit_id
            WHERE c.state = 'canonical' AND u.state = 'canonical'
            ORDER BY c.unit_id, c.ord""").fetchall()
    return conn, [dict(r) for r in rows]


# ----------------------------------------------------------------------------- windows

RE_SENT_SPLIT = re.compile(r"(?<=[.!?…])\s+(?=[«\"(—–-]?\s*[A-ZА-ЯЁ0-9])")


def split_sentences(text):
    out = []
    for line in text.split("\n"):
        line = line.strip()
        if not line or set(line) <= set("-|: *_"):      # blank, md rule, table separator
            continue
        line = re.sub(r"^#{1,6}\s*", "", line)
        out.extend(p.strip() for p in RE_SENT_SPLIT.split(line) if p.strip())
    merged, carry = [], ""
    for sent in out:                                     # glue headings / tiny fragments forward
        sent = f"{carry} {sent}".strip() if carry else sent
        if len(sent) < MIN_SENT_CHARS:
            carry = sent
            continue
        merged.append(sent)
        carry = ""
    if carry:
        if merged:
            merged[-1] = f"{merged[-1]} {carry}"
        else:
            merged.append(carry)
    return merged


def make_windows(chunks, size, stride, with_head=False):
    texts, owner = [], []
    for ci, chunk in enumerate(chunks):
        sents = split_sentences(chunk["content"])
        if not sents:
            sents = [chunk["content"].strip() or chunk["chunk_id"]]
        starts = list(range(0, max(len(sents) - size, 0) + 1, stride))
        if starts[-1] + size < len(sents):
            starts.append(len(sents) - size)
        head = ""
        if with_head and chunk.get("section_path"):
            head = chunk["section_path"].split(" > ")[-1].strip() + ". "
        for start in starts:
            texts.append(head + " ".join(sents[start:start + size]))
            owner.append(ci)
    return texts, np.array(owner, dtype=np.int64)


# ----------------------------------------------------------------------------- embedding

def encode(model, texts, max_seq, prefix="", batch_size=32):
    model.max_seq_length = max_seq
    started = time.perf_counter()
    vecs = model.encode([prefix + t for t in texts], batch_size=batch_size,
                        normalize_embeddings=True, convert_to_numpy=True,
                        show_progress_bar=False)
    return np.asarray(vecs, dtype=np.float32), time.perf_counter() - started


def token_lengths(model, texts):
    tok = model.tokenizer
    return [len(tok(t, add_special_tokens=True, truncation=False)["input_ids"]) for t in texts]


# ----------------------------------------------------------------------------- ranking

def rank_chunks(qvec, vecs, owner, chunk_ids):
    sims = vecs @ qvec
    scores = np.full(len(chunk_ids), -2.0, dtype=np.float32)
    np.maximum.at(scores, owner, sims)
    order = sorted(range(len(chunk_ids)), key=lambda i: (-float(scores[i]), chunk_ids[i]))
    return order, scores


def units_of(chunk_idx_list, chunks):
    seen = []
    for i in chunk_idx_list:
        unit = chunks[i]["unit_id"]
        if unit not in seen:
            seen.append(unit)
    return seen


def all_gold(gold, units):
    return bool(gold) and set(gold) <= set(units)


def any_gold(gold, units):
    return bool(set(gold) & set(units))


def first_gold_rank(gold, order, chunks):
    for pos, i in enumerate(order, start=1):
        if chunks[i]["unit_id"] in gold:
            return pos
    return None


def last_gold_unit_rank(gold, order, chunks):
    """Chunk rank at which ALL gold units have appeared (the k needed for all-gold)."""
    need = set(gold)
    for pos, i in enumerate(order, start=1):
        need.discard(chunks[i]["unit_id"])
        if not need:
            return pos
    return None


def rrf(lists, k=RRF_K, top=12):
    score = {}
    for lst in lists:
        for rank, item in enumerate(lst, start=1):
            score[item] = score.get(item, 0.0) + 1.0 / (k + rank)
    return [item for item, _ in sorted(score.items(), key=lambda kv: (-kv[1], kv[0]))][:top]


# ----------------------------------------------------------------------------- chance level

def p_random_cover(need_units, chunks_per_unit, n_chunks, k):
    """P(a uniformly random k-subset of chunks touches every unit in need_units)."""
    need = list(need_units)
    if not need:
        return 1.0
    if k >= n_chunks:
        return 1.0
    total = math.comb(n_chunks, k)
    prob = 0.0
    for r in range(len(need) + 1):
        for subset in itertools.combinations(need, r):
            excluded = sum(chunks_per_unit[u] for u in subset)
            ways = math.comb(n_chunks - excluded, k) if n_chunks - excluded >= k else 0
            prob += (-1) ** r * ways / total
    return prob


# ----------------------------------------------------------------------------- raw BM25 control

def crude_stem(token):
    if not re.fullmatch(r"[а-яё-]+", token) or len(token) < 5:
        return None
    return token[:max(4, len(token) - 2)]


def raw_bm25(conn, question, limit=60):
    """Ungated FTS5 BM25 over the package (my own OR-query of word stems). This is NOT the
    project retriever: no concept dictionary, no coverage gate, no domain veto."""
    tokens = [t for t in re.findall(r"[\w-]+", question.lower().replace("ё", "е"))
              if len(t) >= 3 and t not in STOP_RU and not t.isdigit()]
    parts, seen = [], set()
    for token in tokens:
        stem = crude_stem(token)
        expr = f'"{stem}"*' if stem else f'"{token}"'
        if expr not in seen:
            seen.add(expr)
            parts.append(expr)
    if not parts:
        return []
    rows = conn.execute(
        "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? "
        "ORDER BY bm25(chunks_fts) LIMIT ?", (" OR ".join(parts), limit)).fetchall()
    return [r[0] for r in rows]


# ----------------------------------------------------------------------------- stats helpers

def auc(pos, neg):
    """P(random pos > random neg), ties count 0.5."""
    if not pos or not neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def auc_ci(pos, neg, rng, rounds=2000):
    vals = []
    for _ in range(rounds):
        vals.append(auc([rng.choice(pos) for _ in pos], [rng.choice(neg) for _ in neg]))
    vals.sort()
    return vals[int(0.025 * rounds)], vals[int(0.975 * rounds)]


def dist(values):
    if not values:
        return None
    values = sorted(values)
    q = lambda p: values[min(len(values) - 1, int(round(p * (len(values) - 1))))]
    return {"n": len(values), "min": round(values[0], 4), "p25": round(q(0.25), 4),
            "median": round(q(0.5), 4), "p75": round(q(0.75), 4), "max": round(values[-1], 4),
            "mean": round(statistics.fmean(values), 4)}


def sign_test(wins, losses):
    """Two-sided exact sign test on discordant pairs (fixed vs broken questions)."""
    n = wins + losses
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(0, min(wins, losses) + 1)) / 2 ** n
    return round(min(1.0, 2 * tail), 4)


def rss_mb():
    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(peak / (1e6 if sys.platform == "darwin" else 1e3))


def best_threshold(pos, neg):
    """Threshold t ('pos if value >= t') maximising balanced accuracy."""
    best = None
    for t in sorted(set(pos) | set(neg)):
        tpr = sum(p >= t for p in pos) / len(pos)
        tnr = sum(n < t for n in neg) / len(neg)
        bal = (tpr + tnr) / 2
        if best is None or bal > best["balanced_accuracy"]:
            best = {"threshold": round(float(t), 4), "balanced_accuracy": round(bal, 4),
                    "pos_kept": sum(p >= t for p in pos), "neg_rejected": sum(n < t for n in neg)}
    return best


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--db", required=True)
    ap.add_argument("--lexical", required=True, help="answers.jsonl of the lexical $0 run (w12)")
    ap.add_argument("--lexical-wide", help="answers.jsonl of a wider lexical run (w64)")
    ap.add_argument("--paid", help="answers.jsonl of the paid run (lexical + LLM rewrite)")
    ap.add_argument("--model", default="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--query-prefix", default="")
    ap.add_argument("--passage-prefix", default="")
    ap.add_argument("--long-seq", type=int, default=512, help="token limit for the 'whole chunk' variant")
    ap.add_argument("--tsv")
    ap.add_argument("--json")
    ap.add_argument("--seed", type=int, default=20261120)
    ap.add_argument("--show", action="append", default=[],
                    help="question id to print with its top windows (repeatable), e.g. --show Q044")
    args = ap.parse_args()
    rng = random.Random(args.seed)

    lex = load_run(args.lexical)
    wide = load_run(args.lexical_wide) if args.lexical_wide else None
    paid = load_run(args.paid) if args.paid else None
    conn, chunks = load_chunks(args.db)
    chunk_ids = [c["chunk_id"] for c in chunks]
    chunk_pos = {cid: i for i, cid in enumerate(chunk_ids)}
    n_chunks = len(chunks)
    chunks_per_unit = {}
    for c in chunks:
        chunks_per_unit[c["unit_id"]] = chunks_per_unit.get(c["unit_id"], 0) + 1
    tokens_of = {c["chunk_id"]: c["token_count"] or 0 for c in chunks}
    qids = sorted(lex)
    kinds = {q: lex[q]["kind"] for q in qids}
    gold = {q: lex[q]["gold_units"] for q in qids}
    by_kind = {k: [q for q in qids if kinds[q] == k]
               for k in ("answerable", "conflicting", "unanswerable")}

    out = {"meta": {
        "model": args.model, "device": args.device, "db": args.db, "lexical": args.lexical,
        "lexical_wide": args.lexical_wide, "paid": args.paid, "primary_variant": PRIMARY_VARIANT,
        "primary_k": PRIMARY_K, "n_chunks": n_chunks, "n_units": len(chunks_per_unit),
        "chars_total": sum(len(c["content"]) for c in chunks),
        "tokens_total_pkg_estimate": sum(tokens_of.values()),
        "questions": {k: len(v) for k, v in by_kind.items()},
        "python": sys.version.split()[0], "platform": platform.platform(),
        "machine": platform.machine(),
    }}

    # ---- model
    t0 = time.perf_counter()
    import torch
    import sentence_transformers
    from sentence_transformers import SentenceTransformer
    import_s = time.perf_counter() - t0
    t0 = time.perf_counter()
    model = SentenceTransformer(args.model, device=args.device)
    load_s = time.perf_counter() - t0
    default_seq = int(model.max_seq_length)
    dim = int(model.get_sentence_embedding_dimension())
    out["meta"].update({
        "sentence_transformers": sentence_transformers.__version__, "torch": torch.__version__,
        "torch_threads": torch.get_num_threads(), "import_seconds": round(import_s, 2),
        "model_load_seconds": round(load_s, 2), "model_default_max_seq_length": default_seq,
        "embedding_dim": dim, "long_seq": args.long_seq,
        "process_peak_rss_mb_after_model_load": rss_mb(),
        "model_parameters_millions": round(sum(p.numel() for p in model.parameters()) / 1e6, 1)})
    model.encode(["прогрев"], normalize_embeddings=True)       # warm-up, not timed

    # ---- index variants
    specs = {
        "chunk128": {"label": f"чанк как есть, лимит модели {default_seq} токенов", "seq": default_seq,
                     "texts": [c["content"] for c in chunks], "owner": np.arange(n_chunks)},
        "chunk512": {"label": f"чанк как есть, лимит поднят до {args.long_seq} токенов", "seq": args.long_seq,
                     "texts": [c["content"] for c in chunks], "owner": np.arange(n_chunks)},
    }
    for name, size, stride, head in (("win2", 2, 1, False), ("win3", 3, 2, False),
                                     ("win5", 5, 3, False), ("win3head", 3, 2, True)):
        texts, owner = make_windows(chunks, size, stride, with_head=head)
        specs[name] = {"label": f"окна по {size} предл., шаг {stride}" + (", + заголовок раздела" if head else ""),
                       "seq": default_seq, "texts": texts, "owner": owner}

    index = {}
    out["index"] = {}
    for name, spec in specs.items():
        lens = token_lengths(model, spec["texts"])
        try:
            vecs, secs = encode(model, spec["texts"], spec["seq"], prefix=args.passage_prefix)
        except Exception as exc:                                  # e.g. model cannot take long_seq
            out["index"][name] = {"label": spec["label"], "error": repr(exc)}
            continue
        index[name] = {"vecs": vecs, "owner": spec["owner"], "seq": spec["seq"], "texts": spec["texts"]}
        chars = sum(len(t) for t in spec["texts"])
        out["index"][name] = {
            "label": spec["label"], "max_seq_length": spec["seq"], "vectors": len(spec["texts"]),
            "vectors_per_chunk": round(len(spec["texts"]) / n_chunks, 2),
            "index_seconds": round(secs, 3), "vectors_per_second": round(len(spec["texts"]) / secs, 1),
            "chars_embedded": chars, "token_len_median": int(statistics.median(lens)),
            "token_len_max": max(lens),
            "truncated_share": round(sum(l > spec["seq"] for l in lens) / len(lens), 3),
            "text_seen_share": round(sum(min(l, spec["seq"]) for l in lens) / sum(lens), 3),
            "size_bytes_float32": int(vecs.nbytes),
        }

    # ---- queries
    questions = [lex[q]["question"] for q in qids]
    q_lens = token_lengths(model, questions)
    qvecs = {}
    for seq in sorted({ix["seq"] for ix in index.values()}):
        vecs, _ = encode(model, questions, seq, prefix=args.query_prefix)
        qvecs[seq] = {q: vecs[i] for i, q in enumerate(qids)}
    out["queries"] = {"token_len_median": int(statistics.median(q_lens)), "token_len_max": max(q_lens),
                      "over_default_limit": sum(l > default_seq for l in q_lens)}

    # ---- rank every question in every variant
    ranks = {name: {} for name in index}       # name -> q -> (order, scores)
    for name, ix in index.items():
        for q in qids:
            ranks[name][q] = rank_chunks(qvecs[ix["seq"]][q], ix["vecs"], ix["owner"], chunk_ids)

    def vec_units(name, q, k):
        return units_of(ranks[name][q][0][:k], chunks)

    def vec_chunks(name, q, k):
        return [chunk_ids[i] for i in ranks[name][q][0][:k]]

    def count(kind, pred):
        return sum(1 for q in by_kind[kind] if pred(q))

    def ctx_tokens(chunk_id_list):
        return sum(tokens_of.get(c, 0) for c in set(chunk_id_list))

    # ---- lexical baselines
    def run_summary(run):
        res = {}
        for kind in ("answerable", "conflicting"):
            qs = by_kind[kind]
            res[kind] = {
                "n": len(qs),
                "all_gold": sum(all_gold(gold[q], run[q]["unit_ids"]) for q in qs),
                "any_gold": sum(any_gold(gold[q], run[q]["unit_ids"]) for q in qs),
                "empty_pack": sum(not run[q]["unit_ids"] for q in qs),
                "mean_units": round(statistics.fmean(len(run[q]["unit_ids"]) for q in qs), 2),
                "mean_chunks": round(statistics.fmean(len(run[q]["chunk_ids"]) for q in qs), 2),
                "mean_tokens": round(statistics.fmean(ctx_tokens(run[q]["chunk_ids"]) for q in qs)),
                "failed": [q for q in qs if not all_gold(gold[q], run[q]["unit_ids"])],
            }
        res["unanswerable_empty_pack"] = sum(not run[q]["unit_ids"] for q in by_kind["unanswerable"])
        return res

    out["lexical"] = {"w12": run_summary(lex)}
    if wide:
        out["lexical"]["wide"] = run_summary(wide)
    if paid:
        out["lexical"]["paid_rewrite"] = run_summary(paid)
        out["lexical"]["paid_rewrite"]["rewrite_question_non_null"] = sum(
            1 for q in qids if paid[q].get("rewrite_question"))
    lex_fail = {k: out["lexical"]["w12"][k]["failed"] for k in ("answerable", "conflicting")}
    lex_ok = {k: [q for q in by_kind[k] if q not in lex_fail[k]] for k in ("answerable", "conflicting")}

    # ---- chance level and raw BM25 control
    out["chance"] = {}
    for kind in ("answerable", "conflicting"):
        out["chance"][kind] = {
            f"all_gold_k{k}": round(sum(p_random_cover(gold[q], chunks_per_unit, n_chunks, k)
                                        for q in by_kind[kind]), 1) for k in KS}
        out["chance"][kind]["closes_lexical_failures_k12"] = round(sum(
            p_random_cover(set(gold[q]) - set(lex[q]["unit_ids"]), chunks_per_unit, n_chunks, 12)
            for q in lex_fail[kind]), 1)
        out["chance"][kind]["closes_lexical_failures_k6"] = round(sum(
            p_random_cover(set(gold[q]) - set(lex[q]["unit_ids"]), chunks_per_unit, n_chunks, 6)
            for q in lex_fail[kind]), 1)
    bm25 = {q: raw_bm25(conn, lex[q]["question"]) for q in qids}
    bm25_order = {}                      # full order over all chunks: matched by BM25 first, rest by id
    for q in qids:
        hit = [chunk_pos[c] for c in bm25[q] if c in chunk_pos]
        rest = [i for i in range(n_chunks) if i not in set(hit)]
        bm25_order[q] = hit + rest
    bm25_units = lambda q, k: units_of([chunk_pos[c] for c in bm25[q][:k] if c in chunk_pos], chunks)
    out["raw_bm25_control"] = {
        "note": "ungated FTS5 BM25, own OR-query of crude stems; not the project retriever",
        "mean_candidates": round(statistics.fmean(len(bm25[q]) for q in qids), 1)}
    for kind in ("answerable", "conflicting"):
        firsts = [first_gold_rank(gold[q], bm25_order[q], chunks) for q in by_kind[kind]]
        out["raw_bm25_control"][kind] = {
            **{f"all_gold_k{k}": count(kind, lambda q, k=k: all_gold(gold[q], bm25_units(q, k))) for k in KS},
            "mrr_first_gold_chunk": round(statistics.fmean(1 / r for r in firsts), 3),
            "gold_chunk_is_top1": sum(r == 1 for r in firsts),
            "gold_chunk_in_top3": sum(r <= 3 for r in firsts),
            "closes_lexical_failures_k12": [q for q in lex_fail[kind] if all_gold(
                gold[q], set(lex[q]["unit_ids"]) | set(bm25_units(q, 12)))],
            "worse_than_lexical_k12": [q for q in lex_ok[kind] if not all_gold(gold[q], bm25_units(q, 12))],
        }

    # ---- vector alone
    out["vector"] = {}
    for name in index:
        res = {}
        for kind in ("answerable", "conflicting"):
            qs = by_kind[kind]
            entry = {"n": len(qs)}
            for k in KS:
                entry[f"all_gold_k{k}"] = sum(all_gold(gold[q], vec_units(name, q, k)) for q in qs)
                entry[f"any_gold_k{k}"] = sum(any_gold(gold[q], vec_units(name, q, k)) for q in qs)
                entry[f"mean_units_k{k}"] = round(statistics.fmean(len(vec_units(name, q, k)) for q in qs), 2)
                entry[f"mean_tokens_k{k}"] = round(statistics.fmean(ctx_tokens(vec_chunks(name, q, k)) for q in qs))
            firsts = [first_gold_rank(gold[q], ranks[name][q][0], chunks) for q in qs]
            needs = [last_gold_unit_rank(gold[q], ranks[name][q][0], chunks) for q in qs]
            entry["mrr_first_gold_chunk"] = round(statistics.fmean(1 / r for r in firsts), 3)
            entry["gold_chunk_is_top1"] = sum(r == 1 for r in firsts)
            entry["gold_chunk_in_top3"] = sum(r <= 3 for r in firsts)
            entry["median_k_needed_for_all_gold"] = statistics.median(needs)
            entry["max_k_needed_for_all_gold"] = max(needs)
            entry["closes_lexical_failures_alone_k12"] = [
                q for q in lex_fail[kind] if all_gold(gold[q], vec_units(name, q, 12))]
            entry["worse_than_lexical_k12"] = [
                q for q in lex_ok[kind] if not all_gold(gold[q], vec_units(name, q, 12))]
            entry["sign_test_p_vs_lexical_k12"] = sign_test(
                len(entry["closes_lexical_failures_alone_k12"]), len(entry["worse_than_lexical_k12"]))
            bm_ok = lambda q, k: all_gold(gold[q], bm25_units(q, k))
            entry["vs_raw_bm25_k12"] = {
                "vector_only": [q for q in qs if all_gold(gold[q], vec_units(name, q, 12)) and not bm_ok(q, 12)],
                "bm25_only": [q for q in qs if bm_ok(q, 12) and not all_gold(gold[q], vec_units(name, q, 12))],
                "neither": [q for q in qs if not bm_ok(q, 12) and not all_gold(gold[q], vec_units(name, q, 12))],
            }
            for top in (6, 9, 12):                       # true rank fusion: both lists are full rankings
                fused = lambda q, top=top: rrf([[chunk_ids[i] for i in bm25_order[q][:24]],
                                                vec_chunks(name, q, 24)], top=top)
                entry[f"rrf_raw_bm25_plus_vector_top{top}"] = sum(
                    all_gold(gold[q], {c.split(":", 1)[0] for c in fused(q)}) for q in qs)
            for k in (6, 12):
                entry[f"union_raw_bm25_k{k}_vector_k{k}"] = sum(
                    all_gold(gold[q], set(bm25_units(q, k)) | set(vec_units(name, q, k))) for q in qs)
            res[kind] = entry
        out["vector"][name] = res
    # chance-level MRR for reference (expected reciprocal rank of the first gold chunk)
    def chance_mrr(q):
        g = sum(chunks_per_unit[u] for u in gold[q])
        return sum((1 / r) * math.comb(n_chunks - r, g - 1) / math.comb(n_chunks, g)
                   for r in range(1, n_chunks - g + 2))
    out["chance"]["mrr_first_gold_chunk"] = {
        kind: round(statistics.fmean(chance_mrr(q) for q in by_kind[kind]), 3)
        for kind in ("answerable", "conflicting")}

    # ---- hybrid: lexical w12 + vector
    def hybrid_block(base_run, name):
        res = {}
        for kind in ("answerable", "conflicting"):
            qs = by_kind[kind]
            fails = [q for q in qs if not all_gold(gold[q], base_run[q]["unit_ids"])]
            entry = {"n": len(qs), "lexical_all_gold": len(qs) - len(fails)}
            for k in KS:
                uni = lambda q, k=k: set(base_run[q]["unit_ids"]) | set(vec_units(name, q, k))
                unic = lambda q, k=k: list(base_run[q]["chunk_ids"]) + vec_chunks(name, q, k)
                entry[f"union_k{k}"] = {
                    "all_gold": sum(all_gold(gold[q], uni(q)) for q in qs),
                    "closed": [q for q in fails if all_gold(gold[q], uni(q))],
                    "still_open": [q for q in fails if not all_gold(gold[q], uni(q))],
                    "mean_units": round(statistics.fmean(len(uni(q)) for q in qs), 2),
                    "mean_chunks": round(statistics.fmean(len(set(unic(q))) for q in qs), 2),
                    "mean_tokens": round(statistics.fmean(ctx_tokens(unic(q)) for q in qs)),
                }
            fused = lambda q: rrf([base_run[q]["chunk_ids"], vec_chunks(name, q, 12)], top=12)
            fused_units = lambda q: {c.split(":", 1)[0] for c in fused(q)}
            entry["rrf_top12"] = {
                "all_gold": sum(all_gold(gold[q], fused_units(q)) for q in qs),
                "closed": [q for q in fails if all_gold(gold[q], fused_units(q))],
                "lost": [q for q in qs if q not in fails and not all_gold(gold[q], fused_units(q))],
                "mean_units": round(statistics.fmean(len(fused_units(q)) for q in qs), 2),
                "mean_tokens": round(statistics.fmean(ctx_tokens(fused(q)) for q in qs)),
            }
            def split(q):                                  # lexical top-6 + vector top-6, dedup, <= 12
                picked = list(base_run[q]["chunk_ids"][:6])
                for c in vec_chunks(name, q, n_chunks):
                    if len(picked) >= 12:
                        break
                    if c not in picked:
                        picked.append(c)
                return picked
            split_units = lambda q: {c.split(":", 1)[0] for c in split(q)}
            entry["split_6_plus_fill_to_12"] = {
                "all_gold": sum(all_gold(gold[q], split_units(q)) for q in qs),
                "closed": [q for q in fails if all_gold(gold[q], split_units(q))],
                "lost": [q for q in qs if q not in fails and not all_gold(gold[q], split_units(q))],
                "mean_tokens": round(statistics.fmean(ctx_tokens(split(q)) for q in qs)),
            }
            res[kind] = entry
        return res

    out["hybrid_w12"] = {name: hybrid_block(lex, name) for name in index}
    if paid:
        out["hybrid_paid"] = {name: hybrid_block(paid, name) for name in index}

    # ---- judge's "in the book, retrieval missed it" list
    P = PRIMARY_VARIANT if PRIMARY_VARIANT in index else next(iter(index))
    out["judge_missed"] = []
    for q in JUDGE_MISSED:
        if q not in lex:
            continue
        order = ranks[P][q][0]
        out["judge_missed"].append({
            "q": q, "kind": kinds[q], "gold": gold[q],
            "lexical_w12_all_gold": all_gold(gold[q], lex[q]["unit_ids"]),
            "paid_all_gold": all_gold(gold[q], paid[q]["unit_ids"]) if paid else None,
            "vector_all_gold_k12": all_gold(gold[q], vec_units(P, q, 12)),
            "vector_first_gold_chunk_rank": first_gold_rank(gold[q], order, chunks),
            "vector_k_needed_for_all_gold": last_gold_unit_rank(gold[q], order, chunks),
            "vector_chunk128_all_gold_k12": all_gold(gold[q], vec_units("chunk128", q, 12)) if "chunk128" in index else None,
            "vector_chunk512_all_gold_k12": all_gold(gold[q], vec_units("chunk512", q, 12)) if "chunk512" in index else None,
        })

    # ---- best cosine per question (primary index) + the cosine the lexical pack reaches
    best_cos = {q: float(ranks[P][q][1].max()) for q in qids}
    lex_cos = {}
    for q in qids:
        idx = [chunk_pos[c] for c in lex[q]["chunk_ids"] if c in chunk_pos]
        lex_cos[q] = float(ranks[P][q][1][idx].max()) if idx else None

    # ---- adaptive signals: when is the lexical result weak?
    diag = lambda q, key: (lex[q].get("diagnostics") or {}).get(key)
    signals = {
        "empty_pack (поиск по словам вернул пусто)": lambda q: not lex[q]["unit_ids"],
        "domain_no_signal (словарь понятий молчит)": lambda q: lex[q].get("domain_signal") == "domain_no_signal",
        "no_concept_match (conceptMatches = 0)": lambda q: not diag(q, "conceptMatches"),
        "pack_status != ready": lambda q: lex[q].get("pack_status") != "ready",
        "confidence none/low": lambda q: lex[q].get("confidence") in (None, "low"),
        "confidence none": lambda q: lex[q].get("confidence") is None,
        "units <= 3": lambda q: len(lex[q]["unit_ids"]) <= 3,
        "units <= 5": lambda q: len(lex[q]["unit_ids"]) <= 5,
        "topScore none or < 0.60": lambda q: diag(q, "topScore") is None or diag(q, "topScore") < 0.60,
        "topScore none or < 0.70": lambda q: diag(q, "topScore") is None or diag(q, "topScore") < 0.70,
        "strongUnits = 0": lambda q: not diag(q, "strongUnits"),
        "vector disagrees (best_cos - cos of lexical pack >= 0.05, or pack empty)":
            lambda q: lex_cos[q] is None or best_cos[q] - lex_cos[q] >= 0.05,
        "always (вектор всегда)": lambda q: True,
    }
    med = statistics.median(best_cos[q] for q in qids)
    signals[f"best_cos < median ({med:.3f})"] = lambda q: best_cos[q] < med
    if paid:
        signals["F: domain_no_signal"] = lambda q: paid[q].get("domain_signal") == "domain_no_signal"
        signals["F: confidence none/low"] = lambda q: paid[q].get("confidence") in (None, "low")
    all_fail = lex_fail["answerable"] + lex_fail["conflicting"]
    out["signals"] = {}
    for label, fires in signals.items():
        fired = [q for q in qids if fires(q)]
        entry = {"fires_total": len(fired),
                 "fires_by_kind": {k: sum(1 for q in fired if kinds[q] == k) for k in by_kind},
                 "lexical_failures_covered": sum(1 for q in fired if q in all_fail),
                 "lexical_failures_missed": [q for q in all_fail if q not in fired],
                 "needless_fires_lexical_was_ok": sum(1 for q in fired if q in lex_ok["answerable"] + lex_ok["conflicting"]),
                 "fires_on_unanswerable": sum(1 for q in fired if kinds[q] == "unanswerable")}
        for k in (6, 12):
            def final_units(q, k=k):
                base = set(lex[q]["unit_ids"])
                return base | set(vec_units(P, q, k)) if fires(q) else base
            def final_tokens(q, k=k):
                base = list(lex[q]["chunk_ids"])
                return ctx_tokens(base + vec_chunks(P, q, k)) if fires(q) else ctx_tokens(base)
            entry[f"add_vector_k{k}"] = {
                "answerable_all_gold": sum(all_gold(gold[q], final_units(q)) for q in by_kind["answerable"]),
                "conflicting_all_gold": sum(all_gold(gold[q], final_units(q)) for q in by_kind["conflicting"]),
                "failures_closed": [q for q in all_fail if all_gold(gold[q], final_units(q))],
                "mean_tokens_all_questions": round(statistics.fmean(final_tokens(q) for q in qids)),
            }
            def final_units_bm25(q, k=k):
                base = set(lex[q]["unit_ids"])
                return base | set(bm25_units(q, k)) if fires(q) else base
            entry[f"add_raw_bm25_k{k}"] = {
                "answerable_all_gold": sum(all_gold(gold[q], final_units_bm25(q)) for q in by_kind["answerable"]),
                "conflicting_all_gold": sum(all_gold(gold[q], final_units_bm25(q)) for q in by_kind["conflicting"]),
                "failures_closed": [q for q in all_fail if all_gold(gold[q], final_units_bm25(q))],
            }
        out["signals"][label] = entry

    # ---- "not in the book": best cosine, answerable vs unanswerable
    out["not_in_book"] = {"note": "n(unanswerable)=10 — intervals are wide"}
    for name in index:
        bc = {q: float(ranks[name][q][1].max()) for q in qids}
        pos = [bc[q] for q in by_kind["answerable"]]
        neg = [bc[q] for q in by_kind["unanswerable"]]
        conf = [bc[q] for q in by_kind["conflicting"]]
        lo, hi = auc_ci(pos, neg, rng)
        out["not_in_book"][name] = {
            "answerable": dist(pos), "conflicting": dist(conf), "unanswerable": dist(neg),
            "auc_answerable_vs_unanswerable": round(auc(pos, neg), 3),
            "auc_ci95_bootstrap": [round(lo, 3), round(hi, 3)],
            "best_threshold": best_threshold(pos, neg),
            "unanswerable_below_min_answerable": sum(n < min(pos) for n in neg),
            "answerable_below_max_unanswerable": sum(p < max(neg) for p in pos),
        }
    # margin signal: how much the best window stands out from the typical chunk
    margin = {q: float(ranks[P][q][1].max() - np.median(ranks[P][q][1])) for q in qids}
    pos = [margin[q] for q in by_kind["answerable"]]
    neg = [margin[q] for q in by_kind["unanswerable"]]
    out["not_in_book"]["margin_best_minus_median_primary"] = {
        "answerable": dist(pos), "unanswerable": dist(neg),
        "auc_answerable_vs_unanswerable": round(auc(pos, neg), 3)}
    ts = lambda q: diag(q, "topScore") or 0.0
    out["not_in_book"]["lexical_topScore"] = {
        "answerable": dist([ts(q) for q in by_kind["answerable"]]),
        "unanswerable": dist([ts(q) for q in by_kind["unanswerable"]]),
        "auc_answerable_vs_unanswerable": round(auc([ts(q) for q in by_kind["answerable"]],
                                                    [ts(q) for q in by_kind["unanswerable"]]), 3)}
    out["not_in_book"]["lexical_signals"] = {
        "empty_pack": {k: sum(not lex[q]["unit_ids"] for q in by_kind[k]) for k in by_kind},
        "domain_no_signal": {k: sum(lex[q].get("domain_signal") == "domain_no_signal" for q in by_kind[k]) for k in by_kind},
        "pack_status_ready": {k: sum(lex[q].get("pack_status") == "ready" for q in by_kind[k]) for k in by_kind},
    }

    # ---- speed and size
    seq = index[P]["seq"]
    model.max_seq_length = seq
    q_times = []
    for text in questions:
        t0 = time.perf_counter()
        model.encode([args.query_prefix + text], normalize_embeddings=True, convert_to_numpy=True,
                     show_progress_bar=False)
        q_times.append((time.perf_counter() - t0) * 1000)
    q_times.sort()
    speed = {"query_encode_ms": {"median": round(statistics.median(q_times), 2),
                                 "p95": round(q_times[int(0.95 * len(q_times))], 2),
                                 "max": round(q_times[-1], 2)},
             "search_ms": {}}
    base = index[P]["vecs"]
    probe = qvecs[seq][qids[0]]
    for rows in (len(base), 15_000, 160_000, 240_000):
        reps = max(1, math.ceil(rows / len(base)))
        mat = np.ascontiguousarray(np.tile(base, (reps, 1))[:rows])
        times = []
        for _ in range(20):
            t0 = time.perf_counter()
            sims = mat @ probe
            np.argpartition(-sims, min(50, rows - 1))[:50]
            times.append((time.perf_counter() - t0) * 1000)
        speed["search_ms"][str(rows)] = {"median": round(statistics.median(times), 3),
                                         "size_mb_float32": round(mat.nbytes / 1e6, 2)}
        del mat
    try:                                                   # single CPU thread: proxy for a small VPS
        torch.set_num_threads(1)
        one = []
        for text in questions:
            t0 = time.perf_counter()
            model.encode([args.query_prefix + text], normalize_embeddings=True, convert_to_numpy=True,
                         show_progress_bar=False)
            one.append((time.perf_counter() - t0) * 1000)
        one.sort()
        _, secs = encode(model, specs[P]["texts"], seq, prefix=args.passage_prefix)
        speed["single_thread"] = {
            "query_encode_ms": {"median": round(statistics.median(one), 2),
                                "p95": round(one[int(0.95 * len(one))], 2)},
            "index_vectors_per_second": round(len(specs[P]["texts"]) / secs, 1)}
    except Exception as exc:
        speed["single_thread"] = {"error": repr(exc)}
    speed["process_peak_rss_mb_end"] = rss_mb()
    out["speed"] = speed

    # ---- per-question table
    best_signal = "empty_pack (поиск по словам вернул пусто)"
    out["meta"]["tsv_signal"] = best_signal
    rows = []
    for q in qids:
        scored_q = kinds[q] != "unanswerable"
        lex_all = all_gold(gold[q], lex[q]["unit_ids"]) if scored_q else None
        vec_all = all_gold(gold[q], vec_units(P, q, PRIMARY_K)) if scored_q else None
        hyb_all = all_gold(gold[q], set(lex[q]["unit_ids"]) | set(vec_units(P, q, PRIMARY_K))) if scored_q else None
        rows.append({"q": q, "kind": kinds[q], "gold_records": ",".join(gold[q]),
                     "lexical_all": lex_all, "vector_all_k12": vec_all, "hybrid_all": hyb_all,
                     "best_cos": round(best_cos[q], 4), "signal_weak": signals[best_signal](q),
                     "lexical_units": len(lex[q]["unit_ids"]),
                     "vector_first_gold_rank": first_gold_rank(gold[q], ranks[P][q][0], chunks) if scored_q else None,
                     "vector_k_needed": last_gold_unit_rank(gold[q], ranks[P][q][0], chunks) if scored_q else None,
                     "lexical_pack_cos": None if lex_cos[q] is None else round(lex_cos[q], 4),
                     "raw_bm25_all_k12": all_gold(gold[q], bm25_units(q, 12)) if scored_q else None,
                     "pack_status": lex[q].get("pack_status"), "confidence": lex[q].get("confidence"),
                     "domain_signal": lex[q].get("domain_signal")})
    out["per_question"] = rows
    fmt = lambda v: "" if v is None else ("1" if v is True else "0" if v is False else str(v))
    if args.tsv:
        cols = ["q", "kind", "gold_records", "lexical_all", "vector_all_k12", "hybrid_all",
                "best_cos", "signal_weak"]
        with open(args.tsv, "w", encoding="utf-8") as fh:
            fh.write("\t".join(cols) + "\n")
            for row in rows:
                fh.write("\t".join(fmt(row[c]) for c in cols) + "\n")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)

    # ---- short console summary
    v = out["vector"][P]
    h = out["hybrid_w12"][P]
    print(f"model={args.model} dim={dim} default_seq={default_seq} chunks={n_chunks} primary={P}")
    for kind in ("answerable", "conflicting"):
        n = len(by_kind[kind])
        print(f"{kind}: lexical {out['lexical']['w12'][kind]['all_gold']}/{n} | "
              f"vector k6/12/24 {v[kind]['all_gold_k6']}/{v[kind]['all_gold_k12']}/{v[kind]['all_gold_k24']} | "
              f"union k12 {h[kind]['union_k12']['all_gold']}/{n} | rrf12 {h[kind]['rrf_top12']['all_gold']}/{n} | "
              f"chance k12 {out['chance'][kind]['all_gold_k12']}")
    for q in args.show:
        if q not in lex:
            continue
        print(f"\n{q} [{kinds[q]}] {lex[q]['question']}\n  gold: {gold[q]}")
        ix = index[P]
        sims = ix["vecs"] @ qvecs[ix["seq"]][q]
        for j in np.argsort(-sims)[:3]:
            c = chunks[int(ix["owner"][j])]
            mark = "GOLD" if c["unit_id"] in gold[q] else "    "
            print(f"  {sims[j]:.3f} {mark} {c['chunk_id']}\n        {ix['texts'][int(j)][:260]}")
    conn.close()


if __name__ == "__main__":
    main()
