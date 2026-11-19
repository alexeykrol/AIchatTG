#!/usr/bin/env bash
# The first paid measurement as one command (PAID: Anthropic API).
#   scripts/eval/paid-run.sh <KEY_ENV_NAME> <ANSWER_CAP_USD> <DONOR_BUILD_CAP_USD>
# 1. known-bad calibration: the stand's judge must fail all 8 (stop otherwise);
# 2. 100 answers through the AIchatTG answer branch on Claude, hard-capped at ANSWER_CAP_USD;
# 3. the stand's judge on those answers (run cap MENTOR_BUDGET__EVAL_RUN_USD, default 3 USD each),
#    table with the stand's own verdicts for the generic chat and the stand bot.
# DONOR_BUILD_CAP_USD is the owner's total for the donor ledger (it is already above the donor's own $80).
set -euo pipefail
KEY_ENV="${1:?key env name}"; CAP="${2:?answer cap usd}"; BUILD="${3:?donor build cap usd}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="${AICHATTG_EVAL_NODE:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
PY="${AICHATTG_EVAL_PY:-$HOME/Code/agi2claude/.venv/bin/python}"
DONOR="${AICHATTG_EVAL_DONOR:-$HOME/Code/agi2claude}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN="$REPO/output/eval/runs/$STAMP-live"
export MENTOR_BUDGET__BUILD_USD="$BUILD" PYTHONDONTWRITEBYTECODE=1

"$PY" "$REPO/scripts/eval/judge_with_stand.py" --donor "$DONOR" --key-env "$KEY_ENV" --side known-bad \
  --answers "$REPO/scripts/eval/known-bad-answers.md" --out "$REPO/output/eval/judge/$STAMP-known-bad" \
  | tee "$REPO/output/eval/judge-known-bad-$STAMP.txt"
if ! grep -qE '^\| Overall pass \|.*\| 0/100 \(judged 8\) \|$' "$REPO/output/eval/judge-known-bad-$STAMP.txt"; then
  echo "STOP: the judge passed at least one known-bad answer; do not trust it for the comparison" >&2; exit 5
fi
"$NODE" "$REPO/scripts/eval/ask-offline.mjs" --mode live --donor "$DONOR" --key-env "$KEY_ENV" \
  --cap-usd "$CAP" --out "$RUN"
"$PY" "$REPO/scripts/eval/judge_with_stand.py" --donor "$DONOR" --key-env "$KEY_ENV" --side aichattg \
  --answers "$RUN/answers.md" --out "$REPO/output/eval/judge/$STAMP-aichattg"
