#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aichattg-framework-safety.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
PASSED=0

fail() {
    echo "not ok - $1" >&2
    exit 1
}

pass() {
    PASSED=$((PASSED + 1))
    echo "ok $PASSED - $1"
}

init_repo() {
    local repo="$1"
    mkdir -p "$repo"
    git -C "$repo" init -q
    git -C "$repo" config user.name "Framework Test"
    git -C "$repo" config user.email "framework-test@example.invalid"
}

copy_switch_tools() {
    local repo="$1"
    mkdir -p "$repo/scripts"
    cp "$PROJECT_DIR/scripts/framework-state-mode.sh" "$repo/scripts/framework-state-mode.sh"
    cp "$PROJECT_DIR/scripts/switch-repo-access.sh" "$repo/scripts/switch-repo-access.sh"
    chmod +x "$repo/scripts/framework-state-mode.sh" "$repo/scripts/switch-repo-access.sh"
}

# PreCompact must leave HEAD, index, worktree and SNAPSHOT byte-for-byte as found.
PRE_REPO="$TEST_ROOT/precompact"
init_repo "$PRE_REPO"
mkdir -p "$PRE_REPO/.claude"
printf 'base\n' > "$PRE_REPO/tracked.txt"
printf '# Snapshot\n**Last Updated:** 2026-09-14\n' > "$PRE_REPO/.claude/SNAPSHOT.md"
git -C "$PRE_REPO" add tracked.txt .claude/SNAPSHOT.md
git -C "$PRE_REPO" commit -qm "test: base"
printf 'dirty\n' >> "$PRE_REPO/tracked.txt"
printf 'untracked\n' > "$PRE_REPO/untracked.txt"
PRE_HEAD="$(git -C "$PRE_REPO" rev-parse HEAD)"
PRE_INDEX="$(git -C "$PRE_REPO" diff --cached | shasum -a 256 | awk '{print $1}')"
PRE_STATUS="$(git -C "$PRE_REPO" status --porcelain)"
PRE_SNAPSHOT="$(shasum -a 256 "$PRE_REPO/.claude/SNAPSHOT.md" | awk '{print $1}')"
(cd "$PRE_REPO" && bash "$PROJECT_DIR/.claude/hooks/pre-compact.sh" >/dev/null)
[ "$(git -C "$PRE_REPO" rev-parse HEAD)" = "$PRE_HEAD" ] || fail "pre-compact changed HEAD"
[ "$(git -C "$PRE_REPO" diff --cached | shasum -a 256 | awk '{print $1}')" = "$PRE_INDEX" ] || fail "pre-compact changed index"
[ "$(git -C "$PRE_REPO" status --porcelain)" = "$PRE_STATUS" ] || fail "pre-compact changed worktree"
[ "$(shasum -a 256 "$PRE_REPO/.claude/SNAPSHOT.md" | awk '{print $1}')" = "$PRE_SNAPSHOT" ] || fail "pre-compact changed SNAPSHOT"
pass "pre-compact is read-only"

# A missing sentinel block is created with exact framework patterns.
SWITCH_REPO="$TEST_ROOT/switch-missing-sentinel"
init_repo "$SWITCH_REPO"
copy_switch_tools "$SWITCH_REPO"
mkdir -p "$SWITCH_REPO/.claude"
printf 'project_name=test\nrepo_access=private-solo\n' > "$SWITCH_REPO/manifest.md"
printf '.DS_Store\n' > "$SWITCH_REPO/.gitignore"
printf '# Project\n' > "$SWITCH_REPO/CLAUDE.md"
printf '# Agent\n' > "$SWITCH_REPO/AGENTS.md"
printf '# Snapshot\n' > "$SWITCH_REPO/.claude/SNAPSHOT.md"
git -C "$SWITCH_REPO" add -- .gitignore scripts/framework-state-mode.sh \
    scripts/switch-repo-access.sh
git -C "$SWITCH_REPO" commit -qm "test: pre-framework base"
(cd "$SWITCH_REPO" && scripts/switch-repo-access.sh public >/dev/null)
[ "$(awk -F= '/^repo_access=/{print $2}' "$SWITCH_REPO/manifest.md")" = "public" ] || fail "repo_access not updated"
[ "$(grep -c '^# >>> framework-public-ignore$' "$SWITCH_REPO/.gitignore")" -eq 1 ] || fail "start sentinel missing"
[ "$(grep -c '^# <<< framework-public-ignore$' "$SWITCH_REPO/.gitignore")" -eq 1 ] || fail "end sentinel missing"
grep -qxF '.claude/' "$SWITCH_REPO/.gitignore" || fail "framework ignore not enabled"
[ -z "$(git -C "$SWITCH_REPO" ls-files -- .claude CLAUDE.md manifest.md AGENTS.md)" ] || fail "framework paths remain in index"
[ -f "$SWITCH_REPO/.claude/SNAPSHOT.md" ] || fail "framework working files were deleted"
pass "repo-access switch creates a missing sentinel safely"

# Local reachable history is a blocker even when there is no upstream.
LOCAL_REPO="$TEST_ROOT/local-history"
init_repo "$LOCAL_REPO"
copy_switch_tools "$LOCAL_REPO"
mkdir -p "$LOCAL_REPO/.claude"
printf 'project_name=test\nrepo_access=private-solo\n' > "$LOCAL_REPO/manifest.md"
printf '.DS_Store\n' > "$LOCAL_REPO/.gitignore"
printf '# Snapshot\n' > "$LOCAL_REPO/.claude/SNAPSHOT.md"
git -C "$LOCAL_REPO" add -- .gitignore manifest.md .claude/SNAPSHOT.md \
    scripts/framework-state-mode.sh scripts/switch-repo-access.sh
git -C "$LOCAL_REPO" commit -qm "test: local framework state"
LOCAL_STATUS="$(git -C "$LOCAL_REPO" status --porcelain)"
LOCAL_MANIFEST="$(shasum -a 256 "$LOCAL_REPO/manifest.md" | awk '{print $1}')"
set +e
(cd "$LOCAL_REPO" && scripts/switch-repo-access.sh public >/dev/null 2>&1)
LOCAL_SWITCH_STATUS=$?
set -e
[ "$LOCAL_SWITCH_STATUS" -eq 2 ] || fail "local framework history did not return blocker status 2"
[ "$(git -C "$LOCAL_REPO" status --porcelain)" = "$LOCAL_STATUS" ] || fail "local-history blocker changed repository"
[ "$(shasum -a 256 "$LOCAL_REPO/manifest.md" | awk '{print $1}')" = "$LOCAL_MANIFEST" ] || fail "local-history blocker changed manifest"
pass "repo-access blocks any framework history reachable from HEAD"

# Upstream framework history is a preflight blocker and leaves files untouched.
UPSTREAM_REPO="$TEST_ROOT/upstream-source"
UPSTREAM_BARE="$TEST_ROOT/upstream.git"
init_repo "$UPSTREAM_REPO"
copy_switch_tools "$UPSTREAM_REPO"
mkdir -p "$UPSTREAM_REPO/.claude"
printf 'project_name=test\nrepo_access=private-solo\n' > "$UPSTREAM_REPO/manifest.md"
printf '.DS_Store\n' > "$UPSTREAM_REPO/.gitignore"
printf '# Snapshot\n' > "$UPSTREAM_REPO/.claude/SNAPSHOT.md"
git -C "$UPSTREAM_REPO" add -- .gitignore manifest.md .claude/SNAPSHOT.md \
    scripts/framework-state-mode.sh scripts/switch-repo-access.sh
git -C "$UPSTREAM_REPO" commit -qm "test: upstream framework state"
git init -q --bare "$UPSTREAM_BARE"
git -C "$UPSTREAM_REPO" remote add origin "$UPSTREAM_BARE"
git -C "$UPSTREAM_REPO" push -qu origin HEAD:main
git -C "$UPSTREAM_REPO" branch --set-upstream-to=origin/main >/dev/null
UPSTREAM_STATUS="$(git -C "$UPSTREAM_REPO" status --porcelain)"
UPSTREAM_MANIFEST="$(shasum -a 256 "$UPSTREAM_REPO/manifest.md" | awk '{print $1}')"
UPSTREAM_IGNORE="$(shasum -a 256 "$UPSTREAM_REPO/.gitignore" | awk '{print $1}')"
set +e
(cd "$UPSTREAM_REPO" && scripts/switch-repo-access.sh public >/dev/null 2>&1)
SWITCH_STATUS=$?
set -e
[ "$SWITCH_STATUS" -eq 2 ] || fail "upstream history did not return blocker status 2"
[ "$(git -C "$UPSTREAM_REPO" status --porcelain)" = "$UPSTREAM_STATUS" ] || fail "blocked switch changed repository"
[ "$(shasum -a 256 "$UPSTREAM_REPO/manifest.md" | awk '{print $1}')" = "$UPSTREAM_MANIFEST" ] || fail "blocked switch changed manifest"
[ "$(shasum -a 256 "$UPSTREAM_REPO/.gitignore" | awk '{print $1}')" = "$UPSTREAM_IGNORE" ] || fail "blocked switch changed gitignore"
pass "repo-access upstream blocker is mutation-free"

# Invalid repo_access must propagate through every public helper command.
INVALID_REPO="$TEST_ROOT/invalid-mode"
init_repo "$INVALID_REPO"
copy_switch_tools "$INVALID_REPO"
printf 'project_name=test\nrepo_access=typo\n' > "$INVALID_REPO/manifest.md"
for command in repo-access is-shared-mode should-commit-framework-state check-safe-mode; do
    set +e
    (cd "$INVALID_REPO" && scripts/framework-state-mode.sh "$command" >/dev/null 2>&1)
    INVALID_STATUS=$?
    set -e
    [ "$INVALID_STATUS" -eq 2 ] || fail "invalid repo_access failed open for $command"
done
pass "invalid repo_access fails closed in every helper command"

# Static policy checks protect behavior encoded as Claude instructions.
! rg -n 'npm test.*\|\| true|коммитить код.*тесты красные' "$PROJECT_DIR/.claude/skills/finish/SKILL.md" >/dev/null || fail "finish still masks red tests"
rg -n 'остановить `/finish` до staging/commit' "$PROJECT_DIR/.claude/skills/finish/SKILL.md" >/dev/null || fail "finish lacks red-candidate stop"
rg -n 'should-commit-framework-state' "$PROJECT_DIR/.claude/skills/finish/SKILL.md" >/dev/null || fail "finish does not read framework commit mode"
rg -n 'webhook|секрет|миграц|внешнее Telegram|платн' "$PROJECT_DIR/.claude/rules/production-safety.md" >/dev/null || fail "production gates are incomplete"
rg -n 'safe-remote-deploy' "$PROJECT_DIR/.claude/rules/production-safety.md" "$PROJECT_DIR/.claude/ARCHITECTURE.md" >/dev/null || fail "remote safety is missing"
rg -n 'нет PostgreSQL/Supabase target' "$PROJECT_DIR/.claude/skills/db-migrate/SKILL.md" >/dev/null || fail "SQLite boundary is missing"
rg -n 'Четыре статуса доказательств' "$PROJECT_DIR/.claude/ARCHITECTURE.md" >/dev/null || fail "evidence status count is wrong"
! rg -n 'git add -u \+ commit|Обновить timestamp.*SNAPSHOT' "$PROJECT_DIR/.claude/rules/context-management.md" >/dev/null || fail "context rules still promise mutating compaction"
pass "framework policies are fail-closed and project-specific"

echo "1..$PASSED"
