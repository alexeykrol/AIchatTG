#!/bin/bash
# Switch repo_access without silently leaking or rewriting framework state.
# The transition is prepared in the working tree/index; history is never
# rewritten and framework files are never bulk-added automatically.

set -euo pipefail

usage() {
    echo "Usage: scripts/switch-repo-access.sh <public|private-shared|private-solo> [--commit]"
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    usage
    exit 1
fi

TARGET_MODE="$1"
COMMIT_CHANGES=false

case "$TARGET_MODE" in
    public|private-shared|private-solo) ;;
    *) usage; exit 1 ;;
esac

if [ "$#" -eq 2 ]; then
    if [ "$2" != "--commit" ]; then
        usage
        exit 1
    fi
    COMMIT_CHANGES=true
fi

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
MANIFEST="$PROJECT_DIR/manifest.md"
GITIGNORE="$PROJECT_DIR/.gitignore"
HELPER="$PROJECT_DIR/scripts/framework-state-mode.sh"
START_MARKER="# >>> framework-public-ignore"
END_MARKER="# <<< framework-public-ignore"

if ! git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "switch-repo-access: a Git worktree is required"
    exit 1
fi
if [ ! -f "$MANIFEST" ]; then
    echo "switch-repo-access: manifest.md not found"
    exit 1
fi
if [ ! -f "$GITIGNORE" ]; then
    echo "switch-repo-access: .gitignore not found"
    exit 1
fi
if [ ! -x "$HELPER" ]; then
    echo "switch-repo-access: executable framework-state-mode helper not found"
    exit 1
fi

# Switching modes must never absorb an unrelated tracked or staged change.
if ! git -C "$PROJECT_DIR" diff --quiet || ! git -C "$PROJECT_DIR" diff --cached --quiet; then
    echo "switch-repo-access: tracked/staged changes must be clean before switching modes"
    exit 1
fi

START_COUNT="$(awk -v marker="$START_MARKER" '$0 == marker { count++ } END { print count+0 }' "$GITIGNORE")"
END_COUNT="$(awk -v marker="$END_MARKER" '$0 == marker { count++ } END { print count+0 }' "$GITIGNORE")"
if ! { [ "$START_COUNT" -eq 0 ] && [ "$END_COUNT" -eq 0 ]; } \
   && ! { [ "$START_COUNT" -eq 1 ] && [ "$END_COUNT" -eq 1 ]; }; then
    echo "switch-repo-access: malformed framework-public-ignore sentinel block"
    exit 1
fi

# This check must happen before manifest/.gitignore are changed. If any commit
# reachable from HEAD contains framework state, an index-only transition cannot
# remove it from the history that a later push exposes.
if [ "$TARGET_MODE" = "public" ] || [ "$TARGET_MODE" = "private-shared" ]; then
    if git -C "$PROJECT_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
        if ! FRAMEWORK_COMMIT="$(git -C "$PROJECT_DIR" log -1 --format=%H HEAD -- .claude CLAUDE.md manifest.md AGENTS.md)"; then
            echo "switch-repo-access: failed to inspect reachable framework history"
            exit 1
        fi
        if [ -n "$FRAMEWORK_COMMIT" ]; then
            echo "switch-repo-access: reachable history contains framework files at $FRAMEWORK_COMMIT"
            echo "switch-repo-access: no files changed; use an explicitly reviewed history migration or a fresh branch"
            exit 2
        fi
    fi
fi

MANIFEST_TMP="$(mktemp "$MANIFEST.tmp.XXXXXX")"
GITIGNORE_TMP="$(mktemp "$GITIGNORE.tmp.XXXXXX")"
cleanup() {
    rm -f -- "$MANIFEST_TMP" "$GITIGNORE_TMP"
}
trap cleanup EXIT

awk -F= -v mode="$TARGET_MODE" '
    BEGIN { done=0 }
    /^repo_access=/ { print "repo_access=" mode; done=1; next }
    { print }
    END { if (!done) print "repo_access=" mode }
' "$MANIFEST" > "$MANIFEST_TMP"

awk -v start="$START_MARKER" -v end="$END_MARKER" -v mode="$TARGET_MODE" '
    BEGIN {
        inside=0
        found=0
        shared=(mode=="public" || mode=="private-shared")
    }
    $0 == start { inside=1; found=1; print; next }
    $0 == end { inside=0; print; next }
    {
        if (inside) {
            line=$0
            sub(/^# /, "", line)
            if (line == ".claude/" || line == "CLAUDE.md" || line == "manifest.md" || line == "AGENTS.md") {
                print (shared ? line : "# " line)
                next
            }
        }
        print
    }
    END {
        if (!found) {
            print ""
            print start
            print (shared ? ".claude/" : "# .claude/")
            print (shared ? "CLAUDE.md" : "# CLAUDE.md")
            print (shared ? "manifest.md" : "# manifest.md")
            print (shared ? "AGENTS.md" : "# AGENTS.md")
            print end
        }
    }
' "$GITIGNORE" > "$GITIGNORE_TMP"

mv "$MANIFEST_TMP" "$MANIFEST"
mv "$GITIGNORE_TMP" "$GITIGNORE"

if [ "$TARGET_MODE" = "public" ] || [ "$TARGET_MODE" = "private-shared" ]; then
    git -C "$PROJECT_DIR" rm -r --cached --ignore-unmatch -- .claude CLAUDE.md manifest.md AGENTS.md >/dev/null
    if [ -n "$(git -C "$PROJECT_DIR" ls-files -- .claude CLAUDE.md manifest.md AGENTS.md)" ]; then
        echo "switch-repo-access: failed to remove every framework path from the index"
        exit 1
    fi
    git -C "$PROJECT_DIR" add -- .gitignore
else
    # Re-entering private-solo only makes framework paths eligible for a later,
    # reviewed add. It deliberately does not stage the entire framework tree.
    git -C "$PROJECT_DIR" add -- manifest.md .gitignore
fi

if [ "$COMMIT_CHANGES" = true ] && ! git -C "$PROJECT_DIR" diff --cached --quiet; then
    git -C "$PROJECT_DIR" commit -m "chore(repo-access): switch to $TARGET_MODE mode"
fi

echo "switch-repo-access: repo_access set to $TARGET_MODE"
echo "switch-repo-access: framework-state commit eligibility = $("$HELPER" should-commit-framework-state)"

if [ "$TARGET_MODE" = "public" ] || [ "$TARGET_MODE" = "private-shared" ]; then
    echo "switch-repo-access: framework paths are absent from the current index"
    echo "switch-repo-access: this does not rewrite any earlier local history"
else
    echo "switch-repo-access: framework paths are eligible but were not bulk-staged"
fi

if ! git -C "$PROJECT_DIR" diff --cached --quiet; then
    echo "switch-repo-access: reviewed transition remains staged; commit it explicitly"
fi
