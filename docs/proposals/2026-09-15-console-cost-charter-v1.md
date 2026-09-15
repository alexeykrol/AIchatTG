# Task Charter: Source-backed question-cost analytics

## Metadata

- Task ID: console-question-cost-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `9d326f419818b616d1c8045ae4d9a812f6a0ad04`
- Worktree/branch: `/Users/alexeykrolmini/.codex/worktrees/analytics-cost-last5/AIchatTG`, `codex/analytics-cost-last5-20260915`
- Controller: root integrator `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: task Admin `01a0a68d-276e-7d00-8101-3eb730d4b9f5`

## Outcome and Acceptance

- Outcome: explain apparent zero cost and display the last five logical
  questions' source-backed costs plus correctly defined averages/coverage.
- Acceptance: known zero, partial and unknown remain distinguishable;
  chronological unique-question rows, reproducible stage/token/rate provenance,
  explicit priced denominator, no invented historical usage or false bill totals.
- Evidence vocabulary: passed / failed / not_run / inconclusive

## Scope and Exclusions

- In scope: current analytics source diagnosis; bounded reader/aggregation,
  last-five display, means and incomplete-data semantics; proposals for missing
  metadata-only usage hooks. Inherit the already pushed Russian copy hotfix.
- Excluded: Moderator review feature, changing model policy/pricing silently,
  bot behavior, imports/backfills of guessed tokens/costs, paid experiments,
  direct production access, migrations/activation and draft writes.

## Sources of Truth

- PO message `01a0a72c-6e0d-7722-8dba-1ac2e4fd24d7` in the result-owner task:
  investigate question costs, add last-five costs/averages and the needed source.
- `apps/operator-console/src/assistant-cost-analytics.mjs` and
  `model-prices-v1.json` — current calculation and rate provenance.
- `docs/reports/2026-09-15-console-v31-deployment.md` — latest verified
  production75 records, zero fully priced and75 unknown; this does not prove
  all paid usage is missing or that a real charge is zero.
- `docs/reports/2026-09-15-console-v311-candidate.md` — pushed copy fixes,
  not a deployed image. Re-check current source/runtime claims independently.

## Ownership

- Owned files/contracts: in the isolated worker only, `analytics-v3.html`,
  `assistant-cost-analytics.mjs`, new uniquely named cost-reader/usage modules,
  synthetic fixtures/tests and feature docs. Rate-file changes require a
  source-backed reviewed proposal, not automatic active pricing replacement.
- Shared-contract writer: root integrator alone for Console `server.mjs`,
  `config.mjs`, common CSS/nav/release metadata; runtime `runtime.mjs`,
  `server.mjs`, `config.mjs`, `database.mjs`, provider hooks; existing shared
  schemas/locks/manifests/Compose/env/migrations and central docs.
- Integration owner/target: root integrator, main and exact release queue.
- Send proposed versioned shared hooks/contracts/patches under feature docs;
  no protected-file writes until an explicit root reservation is accepted.
- Moderator task owns `moderation-v3.html` and new private-review modules.
- Unrelated dirty paths: preserve all user/other-task work; never write root.

## Authority and Attention Gates

- Allowed: local isolated implementation/research, primary rate documentation,
  fake usage receipts, bounded subagents and source-only candidate evidence.
- Forbidden: credentials/private env/DB copying, new live provider calls,
  raw production transcript retention, uncontrolled full-history readers,
  interpreting absent usage or unsupported tariffs as zero cost.
- Production: blocked pending exact integrated source, fresh root preflight,
  explicit approval/lease, data/config effects and rollback. Root owns all SSH.
- Spending: blocked unless the owner gives a separate exact capped strategy.
- Actual provider invoices are not equivalent to token-based estimates. Name
  estimate/partial/unknown honestly; keep historical rate/date/currency basis,
  stage coverage, cached-token and provider-tier uncertainty explicit.

## Dependencies

- Inputs: current source, existing metadata/schema, synthetic complete/partial
  receipts and applicable primary pricing references.
- Depends on: root acceptance for any runtime/provider/storage hook; request
  content-free production metadata checks from root only if local sources
  cannot answer a necessary question. No worker reconnection to the VPS.
- Unblocks: one reviewed analytics candidate incorporating3.1.1 copy fixes.
  Standalone3.1.1 activation is held; no old lease may be reused.

## Checks

Use Node20.20.0 and offline fixtures:

```bash
git status --short --branch
npm --prefix apps/operator-console test
git diff --check
```

Test chronological last-five limits, ties/replay identity, known zero versus
unknown, partially priced stages, correct average denominators, empty history,
unknown model/rates and cache/tier data, bounded queries and unchanged input.
Root reruns integrated tests and release guards before any production decision.

## Stop Rules

- Stop only the affected lane on protected-file collision, missing provenance,
  a real new retention/security/model-policy choice or production/spend gate.
- Do not fabricate old costs to satisfy the display request. Keep local work
  progressing while an external decision or future integration is pending.

## Result Contract

Return actual diff/artifact, exact worktree/base, evidence and remaining gaps,
changed data contracts, proposed shared hook patch, and next owner/action.
Require a grounded ownership acknowledgement. No transfer of root authority;
final deployment and production verification are a later exact decision.
