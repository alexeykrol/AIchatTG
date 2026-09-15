#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ! "$1" =~ ^[0-9a-f]{40}$ || ( $# -eq 2 && ! "$2" =~ ^[0-9a-f]{40}$ ) ]]; then
  echo "usage: $0 <exact-40-character-git-sha> [<previous-production-git-sha>]" >&2
  exit 64
fi

expected_sha=$1
repo_root=$(git rev-parse --show-toplevel)
actual_sha=$(git -C "$repo_root" rev-parse HEAD)

if [[ "$actual_sha" != "$expected_sha" ]]; then
  echo "release source SHA mismatch: expected $expected_sha, got $actual_sha" >&2
  exit 1
fi

if [[ -n $(git -C "$repo_root" status --porcelain --untracked-files=all) ]]; then
  echo 'release source worktree must be clean, including untracked files' >&2
  exit 1
fi

git -C "$repo_root" diff --check
"$repo_root/scripts/aichattg/assert-isolation.sh"
release_args=(--source "$expected_sha")
if [[ $# -eq 2 ]]; then
  release_args+=(--previous "$2")
fi
node "$repo_root/scripts/aichattg/verify-assistant-release.mjs" "${release_args[@]}"
echo "release source: passed ($actual_sha)"
