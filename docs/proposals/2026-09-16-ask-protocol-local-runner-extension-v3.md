# Task Charter: local runner strict-trace compatibility addendum

## Metadata

- Task ID: ask-protocol-v1-local-runners-v3
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `b1c19c551bfa2ac76badbe427710b5d9feb47f86`
- Worktree/branch: `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`,
  `codex/assistant-reply-moderation`
- Controller: root task `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: task «Ассистент», `019fd023-a940-7cf2-864a-75b20fd842ef`

## Outcome and Acceptance

- Outcome: existing local dialogue runners supply valid strict safety traces
  to the new submission boundary without relaxing that boundary.
- Acceptance: dry/local synthetic tests work; safety remains explicitly
  substituted, never represented as real model recognition or paid usage.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: replace existing trace-free `lab_local_judge` results with a
  shared local synthetic result produced through `classifySafetyV3` and an
  injected in-memory response; update necessary explanatory comments.
- Excluded: paid execution, real provider adapters, live CLI flags, domains,
  dialogue policy, historical gold/artifacts, runtime validation bypasses,
  infrastructure, dependencies and any other script changes.

## Sources of Truth

- `/Users/alexeykrolmini/Code/AIchatTG/docs/proposals/2026-09-16-ask-protocol-charter-v1.md`
  — parent scope, strict contracts and attention gates.
- The three existing local runner files below — current explicitly substituted
  safety behavior, including live-answer mode whose safety judge stays local.

## Ownership

- Owned files/contracts, only in the result-owner worktree:
  `apps/telegram-runtime/scripts/local-assistant.mjs`;
  `apps/telegram-runtime/scripts/lib/managed-dialogue.mjs`;
  `apps/telegram-runtime/scripts/lib/dual-dialogue.mjs`;
  optional new shared helper
  `apps/telegram-runtime/scripts/lib/lab-safety.mjs`.
- Related runtime tests remain covered by the parent charter.
- Shared-contract writer: the result owner exclusively in these paths.
- Integration owner/target: root alone, canonical `main` and commits.
- Unrelated dirty paths: preserve all pre-existing parent-candidate edits.

## Authority and Attention Gates

- Allowed: bounded compatibility edits and synthetic offline tests.
- Forbidden: commits, push, root writes, SSH/production access, paid calls,
  secrets or private data; changing the production provider contract to admit
  trace-free semantics. Lab code must not become a production fallback.
- Production: blocked; no release approval or lease is issued.
- Spending: blocked; do not run live modes or introduce any network invocation.

## Dependencies

- Inputs: current strict-trace candidate and existing local lab substitutions.
- Depends on: parent ask-protocol-v1 implementation.
- Unblocks: full offline regression verification and root acceptance review.

## Checks

Run with Node20.20.0. Prove the helper's invocation stays in memory, outputs
pass strict validation, and returned metadata retains synthetic provenance
without invented paid-model usage. Run affected local/managed/dual dialogue
tests, then the full runtime and repository suites under the parent charter.

## Stop Rules

- Stop for any extra path, policy/gold change, real call, or new product decision.
- Do not solve failing historical source tests by rewriting their artifacts.

## Result Contract

Return the exact diff and test evidence to root with the parent candidate.
This addendum grants only the named local edits, not candidate acceptance.
