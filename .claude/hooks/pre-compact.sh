#!/bin/bash
# Pre-Compaction Hook
#
# Read-only checkpoint. Compaction is a context-lifecycle event, not authority
# to stage or commit the working tree. Content and timestamps in SNAPSHOT.md
# are updated deliberately by /finish after successful verification.

set -euo pipefail

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_HELPER="$PROJECT_DIR/scripts/framework-state-mode.sh"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if ! git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "pre-compact: not a git repo; read-only checkpoint skipped"
    exit 0
fi

if [ -x "$STATE_HELPER" ] && ! "$STATE_HELPER" check-safe-mode; then
    echo "pre-compact: framework-state mode is unsafe; no files were changed"
    exit 2
fi

DIRTY_COUNT="$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
if [ "$DIRTY_COUNT" -gt 0 ]; then
    echo "pre-compact: read-only checkpoint at $TIMESTAMP"
    echo "pre-compact: $DIRTY_COUNT uncommitted path(s) remain exactly as found:"
    git -C "$PROJECT_DIR" status --short
    echo "pre-compact: no staging, commit, or SNAPSHOT mutation was performed"
else
    echo "pre-compact: clean read-only checkpoint at $TIMESTAMP"
fi
