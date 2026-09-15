# Task Charter: Private Moderator review and pattern drafts

## Metadata

- Task ID: moderator-review-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `9d326f419818b616d1c8045ae4d9a812f6a0ad04`
- Worktree/branch: `/Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG`, `codex/aichattg-moderator-executor-v1`
- Controller: root integrator `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: task Moderator `019fd023-a949-7961-87cd-693bcb893e2c`

## Outcome and Acceptance

- Outcome: synthetic observation becomes a persisted private case, a fake alert,
  an authenticated Admin review, a versioned draft example and an audit history.
- Acceptance: immutable revision evidence; deduplicated repeats/delivery;
  attributable server-side human verdict; no automatic sanctions or activation.
- Evidence vocabulary: passed / failed / not_run / inconclusive

## Scope and Exclusions

- In scope: promotion suspicion/repetition within one chat; private case queue,
  opaque authenticated deep link, human labels/notes, pattern drafts/history.
  Preserve existing moderation Model/prompts reference and Russian Console shell.
- Excluded: new delete/ban/strike paths, cross-chat profiling, active detector
  rollout, Telegram decision buttons, Assistant behavior, live collection/import,
  paid calls, fine-tuning, News data, production example content in Git.
- V2 supersedes v1 Telegram callbacks: Telegram only alerts; decisions live in
  Admin. Existing Guard enforcement remains independent and unmodified.

## Sources of Truth

- PO message `01a0a72a-ed5c-7da1-9b0d-95ecb4d1668c` in the result-owner task:
  start the agreed Moderation feature, then commit/deploy/control.
- `/Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG/docs/proposals/2026-09-15-moderator-promotion-review-v2.md` — primary local-flow design.
- Same directory `2026-09-15-moderator-promotion-review-v1.md` — synthetic
  taxonomy/counterexamples only where not superseded by v2.
- Current code at the base above supersedes both proposals' older UI anchors.
  Actual page is `apps/operator-console/public/moderation-v3.html`.

## Ownership

- Owned files/contracts: only in the isolated worker, `moderation-v3.html`,
  new uniquely named moderation-review/detection/store/notification modules,
  feature-local tests/styles and feature documents. Worker is their sole writer.
- Shared-contract writer: root integrator alone for Console `server.mjs`,
  `config.mjs`, common CSS/navigation/release metadata, runtime `runtime.mjs`,
  `server.mjs`, `config.mjs`, `database.mjs`, provider hooks, all existing shared
  schemas/manifests/locks/Compose/env/migrations and central project documents.
- Integration owner/target: root integrator, canonical main and release queue.
- Propose shared changes as a separately named versioned contract and patch in
  feature docs; do not edit protected files until the root accepts a specific
  reservation. A local synthetic harness may exercise new modules directly.
- Console cost task owns analytics page/reader/modules, not moderation paths.
- Unrelated dirty paths: preserve all existing untracked `docs/proposals/` in
  d85f. A clean tracked check and fast-forward to the exact base are allowed;
  no reset/clean, root checkout switch, or rewrite of historical proposals.

## Authority and Attention Gates

- Allowed: isolated implementation, synthetic tests/browser fixtures, local
  package setup, bounded subagents, candidate diff/artifacts. Root commits and
  publishes integration; subagents never commit/deploy/access production.
- Forbidden: direct runtime DB writes from Console, legacy moderation POST
  reactivation, reusing recovery snapshots as review/training data, guessed
  recipient/principal/retention, new real collection or outbound send.
- Production: blocked pending exact integrated candidate approval and lease,
  explicit private recipient/reviewer principal, evidence fields/limits,
  case/example retention/deletion policy, config/migration review and rollback.
- Spending: blocked pending explicit model-call purpose, limits/currency,
  duration and stop strategy; local transports remain fake/offline.
- No existing approved review destination or retention was found in current
  checked-in sources. Notification config only has enabled=false; bootstrap
  injects no sender. Existing recovery TTL and transcript preservation rules
  are not review-data permission. Disabled defaults must fail closed.

## Dependencies

- Inputs: exact base, preserved v1/v2 proposals, explicit local synthetic limits.
- Depends on: root acceptance of versioned evidence/API/storage integration;
  PO decisions only before real collection/delivery. Local work may proceed.
- Unblocks: reviewed local Moderator candidate; not immediate production.
- Production baseline last verified22:07:10UTC: Console3.1.0 `eb0f7fe`,
  runtime/Assistant2.4.37 `335a35a`. Pushed3.1.1 `5e55101` is in the base but
  not deployed; its standalone release is held for the new analytics work.

## Checks

Use Node20.20.0 with fake transports and synthetic local databases:

```bash
git status --short --branch
npm --prefix apps/operator-console test
npm --prefix apps/telegram-runtime test
git diff --check
```

Also cover edit/replay fencing, missing/truncated context, same-chat grouping,
restart, duplicate/stale decisions, hostile-text escaping, CSRF/auth/principal,
failed/uncertain send without automatic retry, pending retention and mobile
deep-link navigation. Cases and examples stay private, limits configurable;
test values are fixtures, never an implied production policy.

## Stop Rules

- Stop the affected integration lane for shared-file collision or unresolved
  storage/security/identity decisions; report a concrete proposal to root.
- Never wait on production approval to finish safe module-only local work.
- Keep real detection, alerts and pattern activation disabled without exact
  authority. No new sanctions are part of this charter.

## Result Contract

Return actual diff/artifacts, touched files/contracts, test evidence, unknowns,
proposed shared hooks and production decisions, and one next safe action.
Require a grounded ownership acknowledgement after the worker verifies base,
dirty paths and scope. This is a bounded feature charter, not transfer of root
control or restoration of historical permanent module-executor governance.
