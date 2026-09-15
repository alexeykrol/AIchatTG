#!/bin/bash
#
# save-dialogs.sh — preserve local Claude Code and Codex JSONL transcripts.
#
# TODO(manager): wire this into scripts/lib/install_common.sh so that
#   install_common() copies scripts/save-dialogs.sh into the target project,
#   and install_gitignore() adds these lines for shared/public mode:
#     .claude/dialogs/*.jsonl
#     .claude/dialogs/INDEX.md
#   Also copy templates/global/skills/save-dialog/ to each project type's
#   skills install loop, and the rule (dialog-preservation.md) to the rule
#   install loop. Currently only this repo's own .claude/ is wired manually.
#
# Behavior:
#   - Reads every Claude Code session for this cwd
#   - Reads the current Codex thread when CODEX_THREAD_ID/CODEX_SESSION_ID is set
#   - Copies each into
#     .claude/dialogs/<YYYY-MM-DD>_<source>_<session-id>.jsonl
#   - Idempotent: skips files whose hash matches an existing copy
#   - Updates .claude/dialogs/INDEX.md with one row per new/updated file
#   - Optional: --note "<topic>" attaches a note to new rows
#
# Usage:
#   bash scripts/save-dialogs.sh
#   bash scripts/save-dialogs.sh --note "тема диалога"
#   bash scripts/save-dialogs.sh --source claude|codex|all
#
# Exits 0 even when source directory missing (prints a warning).

set -euo pipefail

# ---------- args ----------
NOTE=""
SOURCE="all"
while [ $# -gt 0 ]; do
    case "$1" in
        --note)
            shift
            if [ $# -eq 0 ]; then
                echo "save-dialogs.sh: --note requires a value" >&2
                exit 1
            fi
            NOTE="$1"
            shift
            ;;
        --note=*)
            NOTE="${1#--note=}"
            shift
            ;;
        --source)
            shift
            if [ $# -eq 0 ]; then
                echo "save-dialogs.sh: --source requires claude, codex or all" >&2
                exit 1
            fi
            SOURCE="$1"
            shift
            ;;
        --source=*)
            SOURCE="${1#--source=}"
            shift
            ;;
        -h|--help)
            cat <<EOF
Usage: save-dialogs.sh [--note "topic"] [--source claude|codex|all]
Preserves local Claude Code and Codex JSONL transcripts in .claude/dialogs/.
EOF
            exit 0
            ;;
        *)
            echo "save-dialogs.sh: unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

case "$SOURCE" in
    claude|codex|all) ;;
    *)
        echo "save-dialogs.sh: --source requires claude, codex or all" >&2
        exit 1
        ;;
esac

# ---------- detect CWD and encoded path ----------
CWD="$(pwd)"

# Encode path the way Claude Code does it: each '/' -> '-', and '_' -> '-' too.
# Leading '/' also becomes '-', producing e.g.
#   /Users/foo/bar      -> -Users-foo-bar
#   /Users/foo/my_proj  -> -Users-foo-my-proj
ENCODED="$(printf '%s' "$CWD" | sed -e 's|/|-|g' -e 's|_|-|g')"

CLAUDE_SRC_DIR="$HOME/.claude/projects/$ENCODED"
CODEX_SESSIONS_DIR="$HOME/.codex/sessions"
CODEX_ARCHIVE_DIR="$HOME/.codex/archived_sessions"
DST_DIR="./.claude/dialogs"
INDEX="$DST_DIR/INDEX.md"

mkdir -p "$DST_DIR"

# ---------- helpers ----------

# Portable SHA-256 — picks whichever is available on macOS/Linux.
hash_file() {
    local f="$1"
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$f" 2>/dev/null | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$f" 2>/dev/null | awk '{print $1}'
    else
        # last resort — file size + mtime; not a real hash but stable enough
        if [ "$(uname)" = "Darwin" ]; then
            stat -f '%z-%m' "$f" 2>/dev/null
        else
            stat -c '%s-%Y' "$f" 2>/dev/null
        fi
    fi
}

# Portable mtime as YYYY-MM-DD.
mtime_date() {
    local f="$1"
    if [ "$(uname)" = "Darwin" ]; then
        stat -f '%Sm' -t '%Y-%m-%d' "$f" 2>/dev/null
    else
        date -u -r "$f" '+%Y-%m-%d' 2>/dev/null || date '+%Y-%m-%d'
    fi
}

ensure_index_header() {
    if [ ! -f "$INDEX" ]; then
        cat > "$INDEX" <<EOF
# Dialog Archive

Локально сохранённые JSONL-диалоги Claude Code и Codex. Сырые диалоги
содержат приватный контекст и никогда не коммитятся. Подробнее: rule
\`dialog-preservation\`.

| Date | Source | File | Session | SHA-256 | Note |
|------|--------|------|---------|---------|------|
EOF
    fi
}

update_index_row() {
    local file_name="$1"
    local date_str="$2"
    local provider="$3"
    local session_id="$4"
    local file_hash="$5"
    local note="$6"
    local index_tmp
    index_tmp="$(mktemp "$DST_DIR/index.tmp.XXXXXX")"
    if awk -F'|' -v file="$file_name" -v date="$date_str" \
        -v source="$provider" -v session="$session_id" \
        -v hash="$file_hash" -v replacement_note="$note" '
        function clean(value) {
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
            return value
        }
        {
            if ($0 ~ /^\|/ && clean($4) == file) {
                old_note=clean($7)
                chosen_note=(replacement_note == "" ? old_note : replacement_note)
                printf "| %s | %s | %s | %s | %s | %s |\n", \
                    date, source, file, session, hash, chosen_note
                found=1
                next
            }
            print
        }
        END { if (!found) exit 3 }
    ' "$INDEX" > "$index_tmp"; then
        mv "$index_tmp" "$INDEX"
    else
        rm -f -- "$index_tmp"
        echo "save-dialogs.sh: archive index row missing for $file_name" >&2
        return 1
    fi
}

# ---------- collect candidates ----------
shopt -s nullglob 2>/dev/null || true

SAVED=0
NEW=0
UPDATED=0

# Candidate format is source|absolute-path. Avoid mapfile/readarray for the
# Bash 3.2 shipped with macOS.
CANDIDATES=""
if [ "$SOURCE" = "all" ] || [ "$SOURCE" = "claude" ]; then
    if [ -d "$CLAUDE_SRC_DIR" ]; then
        for f in "$CLAUDE_SRC_DIR"/*.jsonl; do
            [ -f "$f" ] || continue
            CANDIDATES="$CANDIDATES""claude|$f"$'\n'
        done
    fi
fi

if [ "$SOURCE" = "all" ] || [ "$SOURCE" = "codex" ]; then
    CODEX_ID="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}"
    if [ -n "$CODEX_ID" ]; then
        for root in "$CODEX_SESSIONS_DIR" "$CODEX_ARCHIVE_DIR"; do
            [ -d "$root" ] || continue
            while IFS= read -r f; do
                [ -f "$f" ] || continue
                CANDIDATES="$CANDIDATES""codex|$f"$'\n'
            done < <(find "$root" -type f -name "*${CODEX_ID}.jsonl" -print 2>/dev/null)
        done
    fi
fi

if [ -z "$CANDIDATES" ]; then
    echo "save-dialogs.sh: no local transcripts found for source=$SOURCE"
    exit 0
fi

ensure_index_header

# ---------- iterate ----------
# Use process substitution carefully — keep counters in main shell by reading
# from a here-string (bash 3.2 compatible).
while IFS='|' read -r PROVIDER SRC; do
    [ -z "$PROVIDER" ] && continue
    [ -z "$SRC" ] && continue
    [ -f "$SRC" ] || continue

    BASENAME="$(basename "$SRC")"
    if [ "$PROVIDER" = "codex" ] && [ -n "${CODEX_ID:-}" ]; then
        SESSION_FULL="$CODEX_ID"
    else
        SESSION_FULL="${BASENAME%.jsonl}"
    fi
    # Keep the complete id: truncation could make two independent sessions
    # overwrite the same local archive path.
    SESSION_ID="$SESSION_FULL"
    DATE_STR="$(mtime_date "$SRC")"
    [ -z "$DATE_STR" ] && DATE_STR="$(date '+%Y-%m-%d')"

    DST="$DST_DIR/${DATE_STR}_${PROVIDER}_${SESSION_ID}.jsonl"

    STATUS=""
    if [ -f "$DST" ]; then
        SRC_HASH="$(hash_file "$SRC")"
        DST_HASH="$(hash_file "$DST")"
        if [ -n "$SRC_HASH" ] && [ "$SRC_HASH" = "$DST_HASH" ]; then
            # identical — skip silently
            continue
        else
            cp "$SRC" "$DST"
            STATUS="updated"
            UPDATED=$((UPDATED + 1))
        fi
    else
        cp "$SRC" "$DST"
        STATUS="new"
        NEW=$((NEW + 1))
    fi
    SAVED=$((SAVED + 1))

    FILE_NAME="$(basename "$DST")"
    SAFE_NOTE="$(printf '%s' "$NOTE" | tr '\n|' ' -')"
    FILE_HASH="$(hash_file "$DST")"
    if [ "$STATUS" = "new" ]; then
        printf '| %s | %s | %s | %s | %s | %s |\n' \
            "$DATE_STR" "$PROVIDER" "$FILE_NAME" "$SESSION_ID" \
            "$FILE_HASH" "$SAFE_NOTE" \
            >> "$INDEX"
    else
        update_index_row "$FILE_NAME" "$DATE_STR" "$PROVIDER" \
            "$SESSION_ID" "$FILE_HASH" "$SAFE_NOTE"
    fi
done <<< "$CANDIDATES"

# ---------- summary ----------
TOTAL=0
for f in "$DST_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    TOTAL=$((TOTAL + 1))
done

echo "saved: $SAVED, new: $NEW, updated: $UPDATED, total in archive: $TOTAL"
