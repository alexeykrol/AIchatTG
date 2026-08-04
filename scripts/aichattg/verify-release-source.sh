#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <exact-40-character-git-sha>" >&2
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
echo "release source: passed ($actual_sha)"
