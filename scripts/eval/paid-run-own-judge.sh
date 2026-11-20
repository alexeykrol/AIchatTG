#!/usr/bin/env bash
# Our own answer judge on one answer run (PAID: Anthropic API).
#   scripts/eval/paid-run-own-judge.sh <KEY_ENV_NAME> <ANSWER_RUN_DIR> <CAP_USD> <ALREADY_SPENT_USD> [PACKAGE]
# PACKAGE: knowledge package dir or ai.db the answers were made from (read-only); default: `database` of
# output/eval/tcr-book-v4/build.json. The judge gets the WHOLE book (cached system block) plus the ids of the chunks
# each answer received; every call reserves a ceiling (~$0.86 Sonnet, ~$1.72 Opus); keep ~$3.5 headroom in CAP_USD.
# 1. calibration: known-bad answers must all fail with their expected code, known-good must pass (stop otherwise);
# 2. the judge on <ANSWER_RUN_DIR>/answers.jsonl, with an Opus audit of every 10th case.
# Both steps share one tranche: CAP_USD is the tranche cap, ALREADY_SPENT_USD what the tranche spent before;
# the calibration spend is added before step 2. The key is read only from the variable named KEY_ENV_NAME.
# Extra arguments after PACKAGE go to judge.py of step 2 (e.g. --model, --audit-every, --workers).
set -euo pipefail
KEY_ENV="${1:?key env name}"; RUN="${2:?answer run dir}"; CAP="${3:?cap usd}"; SPENT="${4:?already spent usd}"; shift 4
PACKAGE="${1:-}"; [ $# -gt 0 ] && shift
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PY="${AICHATTG_EVAL_PY3:-python3}"
JUDGE="$REPO/scripts/eval/judge_own/judge.py"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$REPO/output/eval/judge-own/$STAMP"
export PYTHONDONTWRITEBYTECODE=1
if [ -z "$PACKAGE" ]; then
  PACKAGE="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["database"])' "$REPO/output/eval/tcr-book-v4/build.json")"
fi
[ -e "$PACKAGE" ] || { echo "package not found: $PACKAGE" >&2; exit 2; }
[ -f "$RUN/answers.jsonl" ] || { echo "no answers.jsonl in $RUN" >&2; exit 2; }

set +e
"$PY" "$JUDGE" --calibrate --key-env "$KEY_ENV" --cap-usd "$CAP" --already-spent-usd "$SPENT" \
  --package "$PACKAGE" --out "$OUT-calibration" | tee "$OUT-calibration.txt"
CAL=${PIPESTATUS[0]}
set -e
SPENT_AFTER="$("$PY" -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["tranche_total_usd"])' "$OUT-calibration.txt")"
if [ "$CAL" -ne 0 ]; then
  echo "STOP: own judge calibration failed (exit $CAL); tranche total now \$$SPENT_AFTER" >&2; exit 5
fi
"$PY" "$JUDGE" --answers "$RUN/answers.jsonl" --key-env "$KEY_ENV" --cap-usd "$CAP" \
  --already-spent-usd "$SPENT_AFTER" --package "$PACKAGE" --out "$OUT" "$@"
