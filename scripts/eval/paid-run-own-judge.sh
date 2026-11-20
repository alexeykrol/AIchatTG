#!/usr/bin/env bash
# Our own answer judge on one answer run (PAID: Anthropic API).
#   scripts/eval/paid-run-own-judge.sh <KEY_ENV_NAME> <ANSWER_RUN_DIR> <CAP_USD> <ALREADY_SPENT_USD>
# 1. calibration: known-bad answers must all fail with their expected code, known-good must pass (stop otherwise);
# 2. the judge on <ANSWER_RUN_DIR>/answers.jsonl, with an Opus audit of every 10th case.
# Both steps share one tranche: CAP_USD is the tranche cap, ALREADY_SPENT_USD what the tranche spent before;
# the calibration spend is added before step 2. The key is read only from the variable named KEY_ENV_NAME.
# Extra arguments go to judge.py of step 2 (e.g. --model, --audit-every, --workers).
set -euo pipefail
KEY_ENV="${1:?key env name}"; RUN="${2:?answer run dir}"; CAP="${3:?cap usd}"; SPENT="${4:?already spent usd}"; shift 4
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PY="${AICHATTG_EVAL_PY3:-python3}"
JUDGE="$REPO/scripts/eval/judge_own/judge.py"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$REPO/output/eval/judge-own/$STAMP"
export PYTHONDONTWRITEBYTECODE=1
[ -f "$RUN/answers.jsonl" ] || { echo "no answers.jsonl in $RUN" >&2; exit 2; }

set +e
"$PY" "$JUDGE" --calibrate --key-env "$KEY_ENV" --cap-usd "$CAP" --already-spent-usd "$SPENT" \
  --out "$OUT-calibration" | tee "$OUT-calibration.txt"
CAL=${PIPESTATUS[0]}
set -e
SPENT_AFTER="$("$PY" -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["tranche_total_usd"])' "$OUT-calibration.txt")"
if [ "$CAL" -ne 0 ]; then
  echo "STOP: own judge calibration failed (exit $CAL); tranche total now \$$SPENT_AFTER" >&2; exit 5
fi
"$PY" "$JUDGE" --answers "$RUN/answers.jsonl" --key-env "$KEY_ENV" --cap-usd "$CAP" \
  --already-spent-usd "$SPENT_AFTER" --out "$OUT" "$@"
