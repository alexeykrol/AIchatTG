"""Summarize costs, answer lengths, latency, and token usage in eval runs."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
import json
import math
from pathlib import Path
from statistics import mean, median


KINDS = ("answerable", "unanswerable", "conflicting")
COLUMNS = (
    ("n", "n", "d"),
    ("cost_mean_usd", "Mean cost (USD)", ".6f"),
    ("cost_median_usd", "Median cost (USD)", ".6f"),
    ("cost_p90_usd", "P90 cost (USD)", ".6f"),
    ("answer_chars_mean", "Mean chars", ".2f"),
    ("usd_per_1000_chars", "USD / 1,000 chars", ".6f"),
    ("latency_mean_s", "Mean latency (s)", ".3f"),
    ("latency_p90_s", "P90 latency (s)", ".3f"),
    ("input_tokens_mean", "Mean input tokens", ".2f"),
    ("output_tokens_mean", "Mean output tokens", ".2f"),
    ("cost_per_1000_answers_usd", "USD / 1,000 answers", ".4f"),
)


@dataclass(frozen=True)
class Answer:
    q: str | None
    kind: str | None
    knowledge_gap: bool | None
    cost: float
    chars: int | None
    latency_s: float | None
    input_tokens: float | None
    output_tokens: float | None


def read_jsonl(path):
    """Yield objects or None for malformed lines, including blank lines."""
    with path.open("rb") as source:
        for line in source:
            try:
                row = json.loads(line.decode("utf-8"))
            except (ValueError, RecursionError):
                row = None
            yield row if isinstance(row, dict) else None


def optional_field(row, key, expected_type):
    value = row.get(key)
    if value is not None and not isinstance(value, expected_type):
        raise ValueError(key)
    return value


def optional_number(row, key):
    value = optional_field(row, key, (int, float, str))
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(key)
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(key)
    return value


def parse_answer(row):
    q = optional_field(row, "q", str)
    kind = optional_field(row, "kind", str)
    if kind is not None and kind not in KINDS:
        raise ValueError("kind")
    gap = optional_field(row, "knowledge_gap", bool)
    answer = optional_field(row, "answer", str)
    cost = (optional_number(row, "cost_usd") or 0) + (
        optional_number(row, "rewrite_cost_usd") or 0
    )
    if not math.isfinite(cost):
        raise ValueError("combined cost")
    latency = optional_number(row, "latency_ms")
    return Answer(
        q, kind, gap, cost, len(answer) if answer is not None else None,
        latency / 1000 if latency is not None else None,
        optional_number(row, "input_tokens"), optional_number(row, "output_tokens"),
    )


def nearest_rank(values, percentile):
    if not values:
        return None
    return sorted(values)[math.ceil(len(values) * percentile / 100) - 1]


def mean_available(values):
    available = [value for value in values if value is not None]
    return mean(available) if available else None


def summarize(answers):
    """Use available observations for means and require all lengths for pooled cost."""
    costs = [answer.cost for answer in answers]
    lengths = [answer.chars for answer in answers]
    latencies = [answer.latency_s for answer in answers if answer.latency_s is not None]
    cost_mean = mean_available(costs)
    chars_mean = mean_available(lengths)
    pooled_rate = None
    if chars_mean and None not in lengths:
        pooled_rate = cost_mean / chars_mean * 1000
    metrics = {
        "n": len(answers),
        "cost_mean_usd": cost_mean,
        "cost_median_usd": median(costs) if costs else None,
        "cost_p90_usd": nearest_rank(costs, 90),
        "answer_chars_mean": chars_mean,
        "usd_per_1000_chars": pooled_rate,
        "latency_mean_s": mean_available(latencies),
        "latency_p90_s": nearest_rank(latencies, 90),
        "input_tokens_mean": mean_available(answer.input_tokens for answer in answers),
        "output_tokens_mean": mean_available(answer.output_tokens for answer in answers),
        "cost_per_1000_answers_usd": cost_mean * 1000 if cost_mean is not None else None,
    }
    return {
        key: None if isinstance(value, float) and not math.isfinite(value) else value
        for key, value in metrics.items()
    }


def read_judge(path):
    labels = {}
    skipped = 0
    for row in read_jsonl(path):
        if row is None or not isinstance(row.get("q"), str):
            skipped += 1
            continue
        label = row.get("gap_class")
        if isinstance(label, str) and label:
            labels[row["q"]] = label
        elif label is not None:
            skipped += 1
    return labels, skipped


def summarize_run(path, judge_labels=None, judge_skipped=0):
    run_dir = path if path.is_dir() else path.parent
    answers_file = path / "answers.jsonl" if path.is_dir() else path
    groups = defaultdict(list)
    statuses = Counter()
    skipped = 0
    for row in read_jsonl(answers_file):
        if row is None or not isinstance(row.get("status"), str) or not row["status"]:
            skipped += 1
            continue
        if row["status"] != "answered":
            statuses[row["status"]] += 1
            continue
        try:
            answer = parse_answer(row)
        except (ValueError, OverflowError):
            skipped += 1
            continue
        groups["all"].append(answer)
        if answer.kind is not None:
            groups[f"kind={answer.kind}"].append(answer)
        if answer.knowledge_gap is not None:
            groups[f"knowledge_gap={str(answer.knowledge_gap).lower()}"].append(answer)
        if judge_labels is not None and answer.q in judge_labels:
            groups[f"gap_class={judge_labels[answer.q]}"].append(answer)

    summary = {
        "run": run_dir.resolve().name or "/",
        "not_answered": sum(statuses.values()),
        "statuses": dict(sorted(statuses.items())),
        "skipped": skipped,
        "groups": {
            name: summarize(groups[name])
            for name in ("all", *sorted(groups.keys() - {"all"}))
        },
    }
    if judge_labels is not None:
        summary["judge_skipped"] = judge_skipped
    return summary


def markdown_text(value):
    return value.encode("utf-8", errors="backslashreplace").decode().replace(
        "\\", "\\\\"
    ).replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def markdown_table(run):
    statuses = ", ".join(
        f"{markdown_text(status)}: {count}" for status, count in run["statuses"].items()
    )
    lines = [
        f"## {markdown_text(run['run'])}",
        "",
        f"not answered: {run['not_answered']}" + (f" ({statuses})" if statuses else ""),
        f"skipped: {run['skipped']}",
    ]
    if "judge_skipped" in run:
        lines.append(f"judge skipped: {run['judge_skipped']}")
    lines.extend((
        "",
        "| Group | " + " | ".join(title for _, title, _ in COLUMNS) + " |",
        "| --- |" + " ---: |" * len(COLUMNS),
    ))
    for name, stats in run["groups"].items():
        cells = [markdown_text(name)]
        for key, _, spec in COLUMNS:
            value = stats[key]
            cells.append("n/a" if value is None else format(value, spec))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runs", type=Path, nargs="+", metavar="RUN_DIR")
    parser.add_argument("--judge", type=Path, metavar="RESULTS_JSONL")
    parser.add_argument("--json", type=Path, metavar="OUT.json")
    args = parser.parse_args(argv)
    try:
        judge_labels, judge_skipped = read_judge(args.judge) if args.judge else (None, 0)
        runs = [summarize_run(path, judge_labels, judge_skipped) for path in args.runs]
        if args.json:
            args.json.write_text(json.dumps(runs, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    except OSError as exc:
        parser.exit(1, f"{parser.prog}: {exc}\n")
    print("\n\n".join(markdown_table(run) for run in runs))


if __name__ == "__main__":
    main()
