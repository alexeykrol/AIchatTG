# Task Charter: Permanent Moderator executor

## Metadata

- Task ID: `aichattg-moderator-executor-v1`
- Transfer kind: task-charter
- Classification: user-visible-workstream
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `4508e8aeee0dab418a6275e7296cee3dd1e2290b`
- Worktree/branch: isolated Codex worktree from current `main`; record the exact path and branch on acceptance
- Controller: permanent AIchatTG integrator generation 1, task `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: Moderator executor

## Outcome and Acceptance

- Outcome: a durable Product Owner-facing executor owns Moderator safety behavior, Guard operations and recovery evidence while coordinating shared runtime and schema work with the integrator.
- Acceptance: the executor accepts this charter, verifies its isolated worktree and base ancestry, preserves fail-closed safety and ambiguity fences, and waits for the Product Owner's first Moderator task.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: moderation classification contracts and artifacts, Guard rights/actions, pin governance, enforcement receipts, Moderator recovery worker and status tooling, offline fakes, focused tests, and Moderator documentation.
- Excluded: Assistant answer/product behavior; Gatekeeper/onboarding; course content; News; operator-console integration; production, secrets, webhooks, live Telegram/provider calls, and paid calls.
- Shared runtime or database work requires an explicit single-writer reservation from the integrator before editing.

## Sources of Truth

- `/Users/alexeykrolmini/Code/AIchatTG/AGENTS.md` — controller, executor, evidence and release rules.
- `/Users/alexeykrolmini/Code/AIchatTG/apps/telegram-runtime/README.md` — current Moderator, Guard and recovery contracts.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/ASSISTANT_MODERATOR_PARITY.md` — accepted safety and cross-role behavior provenance.

## Ownership

- Owned files/contracts: `apps/telegram-runtime/src/safety-v3.mjs`, `apps/telegram-runtime/src/safety-artifacts/**`, `apps/telegram-runtime/src/guard-adapter.mjs`, `apps/telegram-runtime/src/moderator-recovery.mjs`, their focused tests, `scripts/aichattg/moderator-recovery-status.mjs`, and narrowly Moderator-specific documentation.
- Reserved shared files: `runtime.mjs`, `database.mjs`, `config.mjs`, `provider-adapter.mjs`, transports, entrypoints, manifests/locks, `packages/telegram-core/**`, Compose, migrations and operator console; request an integrator reservation before editing.
- Shared-contract writer: permanent AIchatTG integrator, with at most one explicitly reserved executor writer at a time.
- Integration owner/target: permanent AIchatTG integrator, canonical `/Users/alexeykrolmini/Code/AIchatTG` branch `main`.
- Unrelated dirty paths: preserve all paths outside the accepted task and never reuse auxiliary worktrees as release sources.

## Authority and Attention Gates

- Allowed: repository inspection, local planning, reversible implementation, offline tests, commits and pushes on the executor branch, bounded sub-agents, and chartered `service-child` tasks whose results this executor accepts.
- Forbidden: merging to `main`, changing another module, bypassing the integrator, weakening fail-closed or no-retry ambiguity fences without an explicit decision, copying News code/data/config, using secrets/private data, and claiming deployment from local evidence.
- Production: blocked until the Product Owner approves the exact candidate and the integrator issues a one-time lease naming SHA, service, scope, rollback, expiry, verification and stop conditions.
- Spending: blocked until the Product Owner gives an explicit target and cap and the integrator records it; local tests use fakes only.
- External actions: Telegram messages/actions, provider calls, webhook changes, secret/config changes and publication are blocked without the same exact approval path.

## Dependencies

- Inputs: current `main`, explicit Product Owner tasks, and any integrator-granted shared-file reservation.
- Depends on: integrator ownership of cross-role disposition ordering, persistence schema and provider configuration.
- Unblocks: integrator acceptance of bounded Moderator candidates and Assistant-safe dispositions.

## Checks

```bash
git status --short --branch && git merge-base --is-ancestor 4508e8aeee0dab418a6275e7296cee3dd1e2290b HEAD
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/telegram-runtime test
git diff --check
```

## Stop Rules

- Stop and contact integrator task `019fd019-af89-7b50-a16d-8c7928753f24` before writing any reserved shared file, changing a schema/migration, cross-role disposition, model tuple, enforcement semantics, or privacy boundary.
- Stop for an ambiguous provider/Telegram effect, unresolved safety/product decision, or any production, external, secret or spending boundary.
- A sub-agent or service child never receives integration or release ownership; this executor reviews its evidence and remains accountable.

## Result Contract

Before submitting a candidate, return to the integrator: current production SHA or `not_run`; base and candidate SHAs; deployed, recovered and newly written ledgers; files/additions/deletions; migrations, runtime/config and protected-path effects; rollback consequence; focused and aggregate evidence; risks and scope deviations; lifecycle state; and one next safe action with its owner.

On first turn, reply with `EXECUTOR ACCEPTED: aichattg-moderator-executor-v1`, the verified branch/worktree/base, ownership summary, gates, and `READY FOR PRODUCT OWNER TASK`.
