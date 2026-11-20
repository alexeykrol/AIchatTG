#!/usr/bin/env bash
# Launch one Codex worker task under docs/codex-worker-protocol.md (subscription compute, no API spend).
#   scripts/codex-worker.sh report <task> <charter.md>   worker writes only output/codex/<task>/
#   scripts/codex-worker.sh code   <task> <charter.md>   worker writes only its git worktree (branch codex/<task>),
#                                                        uncommitted; the integrator commits on that branch
# Environment: CODEX_MODEL (default gpt-6.2-sol — the everyday coding model), CODEX_EFFORT (low|medium|high|xhigh,
#              default medium), CODEX_WORKTREES (default ~/.codex/worktrees).
# Resource rule (Product Owner, 2026-11-20): Sol + medium for all routine work; raise the effort to high, or the model
# to gpt-6.2-astra, only for a hard analytical task and say so in the charter. gpt-6-luna for trivial bulk work.
# The sandbox is workspace-write with network off: no push, no API calls, no writes outside the task directory.
# Artefacts: <dir>/PROMPT.md (what the worker got), events.jsonl (transcript, local only), LAST_MESSAGE.md,
# REPORT.md (written by the worker). Exit status is the worker's.
set -euo pipefail
MODE="${1:?mode: report|code}"; TASK="${2:?task name}"; CHARTER="${3:?charter file}"
[[ "$TASK" =~ ^[a-z0-9][a-z0-9-]{1,48}$ ]] || { echo "task name: lowercase letters, digits, dashes" >&2; exit 2; }
[ -f "$CHARTER" ] || { echo "no charter: $CHARTER" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROTOCOL="$REPO/docs/codex-worker-protocol.md"
command -v codex >/dev/null || { echo "codex CLI not found" >&2; exit 3; }
EFFORT="${CODEX_EFFORT:-medium}"; MODEL="${CODEX_MODEL:-gpt-6.2-sol}"
ARGS=(-s workspace-write -c 'sandbox_workspace_write.network_access=false' -c "model_reasoning_effort=\"$EFFORT\"" -m "$MODEL" --json)

case "$MODE" in
  report)
    DIR="$REPO/output/codex/$TASK"; mkdir -p "$DIR"; LOG="$DIR"
    WHERE="Mode: report. Your write area is the current directory ($DIR) and nothing else. The repository root is $REPO (read-only for you)."
    ;;
  code)
    WT_ROOT="${CODEX_WORKTREES:-$HOME/.codex/worktrees}/aichattg-$TASK"; DIR="$WT_ROOT/AIchatTG"; BRANCH="codex/$TASK"
    if [ ! -d "$DIR" ]; then
      mkdir -p "$WT_ROOT"
      git -C "$REPO" worktree add -b "$BRANCH" "$DIR" HEAD >&2
    fi
    LOG="$REPO/output/codex/$TASK"; mkdir -p "$LOG"
    # The sandbox keeps git metadata read-only, so the worker cannot commit (measured 2026-11-20, also with
    # --add-dir "$REPO/.git"). It leaves changes uncommitted; the integrator commits them on $BRANCH after review.
    WHERE="Mode: code. Your write area is this git worktree ($DIR), branch $BRANCH, and nothing else. The main working tree $REPO is read-only for you. Do not commit: leave your changes uncommitted and write REPORT.md in the worktree root."
    ;;
  *) echo "mode must be report or code" >&2; exit 2;;
esac

{
  echo "You are a Codex worker for the AIchatTG integrator (a Claude Code session). Task: $TASK."
  echo "$WHERE"
  echo "Follow the protocol below exactly, then do the charter. Your last act is REPORT.md in the format the protocol gives; your final message repeats its Status line and one-paragraph summary."
  echo; echo "=================== PROTOCOL ==================="; cat "$PROTOCOL"
  echo; echo "=================== CHARTER ===================="; cat "$CHARTER"
} > "$LOG/PROMPT.md"

set +e
codex exec "${ARGS[@]}" -C "$DIR" -o "$LOG/LAST_MESSAGE.md" - < "$LOG/PROMPT.md" > "$LOG/events.jsonl" 2> "$LOG/stderr.log"
RC=$?
set -e
echo "task=$TASK mode=$MODE model=$MODEL effort=$EFFORT exit=$RC dir=$DIR log=$LOG"
if [ "$MODE" = code ]; then
  echo "--- branch $BRANCH:"; git -C "$DIR" log --oneline "HEAD" --not "$(git -C "$REPO" rev-parse HEAD)" 2>/dev/null | head -20
  echo "--- uncommitted in worktree:"; git -C "$DIR" status --short | head -30
fi
echo "--- last message:"; cat "$LOG/LAST_MESSAGE.md" 2>/dev/null | head -40
exit $RC
