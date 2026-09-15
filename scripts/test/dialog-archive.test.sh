#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() {
    rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

PROJECT="$TMP_DIR/AIchatTG_fixture"
FAKE_HOME="$TMP_DIR/home"
mkdir -p "$PROJECT/scripts" "$PROJECT/.claude/dialogs"
cp "$ROOT/scripts/save-dialogs.sh" "$PROJECT/scripts/save-dialogs.sh"

ENCODED="$(printf '%s' "$PROJECT" | sed -e 's|/|-|g' -e 's|_|-|g')"
CLAUDE_DIR="$FAKE_HOME/.claude/projects/$ENCODED"
CODEX_ID="019fd019-af89-7b50-a16d-8c7928753f24"
CODEX_DIR="$FAKE_HOME/.codex/sessions/2026/09/14"
mkdir -p "$CLAUDE_DIR" "$CODEX_DIR"
printf '%s\n' '{"source":"claude"}' > "$CLAUDE_DIR/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
printf '%s\n' '{"source":"codex"}' > \
    "$CODEX_DIR/rollout-2026-09-14T00-00-00-$CODEX_ID.jsonl"

run_archive() {
    (
        cd "$PROJECT"
        HOME="$FAKE_HOME" CODEX_THREAD_ID="$CODEX_ID" \
            bash scripts/save-dialogs.sh --note fixture
    )
}

FIRST="$(run_archive)"
printf '%s\n' "$FIRST" | grep -q 'saved: 2, new: 2, updated: 0'
test "$(find "$PROJECT/.claude/dialogs" -type f -name '*.jsonl' | wc -l | tr -d ' ')" = "2"
grep -q '| claude |' "$PROJECT/.claude/dialogs/INDEX.md"
grep -q '| codex |' "$PROJECT/.claude/dialogs/INDEX.md"
grep -q '| fixture |' "$PROJECT/.claude/dialogs/INDEX.md"

SECOND="$(run_archive)"
printf '%s\n' "$SECOND" | grep -q 'saved: 0, new: 0, updated: 0'

printf '%s\n' '{"source":"claude","grew":true}' >> \
    "$CLAUDE_DIR/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"
OLD_HASH="$(awk -F'|' '$3 ~ /claude/ { gsub(/ /, "", $6); print $6 }' \
    "$PROJECT/.claude/dialogs/INDEX.md")"
THIRD="$(run_archive)"
printf '%s\n' "$THIRD" | grep -q 'saved: 1, new: 0, updated: 1'
CLAUDE_ARCHIVE="$(find "$PROJECT/.claude/dialogs" -type f \
    -name '*_claude_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl' -print -quit)"
NEW_HASH="$(shasum -a 256 "$CLAUDE_ARCHIVE" | awk '{print $1}')"
test "$NEW_HASH" != "$OLD_HASH"
grep -q "$NEW_HASH" "$PROJECT/.claude/dialogs/INDEX.md"
test "$(grep -c 'claude_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl' \
    "$PROJECT/.claude/dialogs/INDEX.md")" = "1"

if (
    cd "$PROJECT"
    HOME="$FAKE_HOME" bash scripts/save-dialogs.sh --source invalid
) >/dev/null 2>&1; then
    echo "dialog-archive: invalid source unexpectedly succeeded" >&2
    exit 1
fi

echo "dialog-archive: passed"
