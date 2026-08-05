# Task Charter: Permanent Gatekeeper executor

## Metadata

- Task ID: `aichattg-gatekeeper-executor-v1`
- Transfer kind: task-charter
- Classification: user-visible-workstream
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `4508e8aeee0dab418a6275e7296cee3dd1e2290b`
- Worktree/branch: isolated Codex worktree from current `main`; record the exact path and branch on acceptance
- Controller: permanent AIchatTG integrator generation 1, task `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: Gatekeeper and onboarding executor

## Outcome and Acceptance

- Outcome: a durable Product Owner-facing executor owns Gatekeeper and onboarding candidate work while preserving the inactive draft gate and coordinating shared routing, schema and release work with the integrator.
- Acceptance: the executor accepts this charter, verifies its isolated worktree and base ancestry, confirms the checked-in scenario remains draft and production onboarding inactive, and waits for the Product Owner's first Gatekeeper task.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: `apps/gatekeeper` application behavior, local simulation, scenario validation and Product Owner-supplied onboarding copy, Tribute/Site/Zapier adapters, module-local persistence/recovery proposals, focused tests and Gatekeeper documentation.
- Excluded: Moderator, Assistant, course knowledge, News, shared operator-console navigation, shared Compose/routes, production, secrets, live Tribute/Site/Zapier/Telegram calls, webhook registration and paid calls.
- Scenario status may move to `ready` only after the Product Owner explicitly resolves all active content/link placeholders and requests that exact candidate.

## Sources of Truth

- `/Users/alexeykrolmini/Code/AIchatTG/AGENTS.md` — controller, executor, evidence and release rules.
- `/Users/alexeykrolmini/Code/AIchatTG/apps/gatekeeper/README.md` — current flows, privacy, recovery and inactive-runtime contract.
- `/Users/alexeykrolmini/Code/AIchatTG/apps/gatekeeper/ONBOARDING_SCENARIO.md` — machine-validated scenario and current draft gate.

## Ownership

- Owned files/contracts: `apps/gatekeeper/src/**`, `apps/gatekeeper/test/**`, `apps/gatekeeper/public/**`, `SCENARIO_TEXTS.md`, `ONBOARDING_SCENARIO.md`, and module-local documentation, subject to attention gates.
- Reserved shared files: Gatekeeper manifests/locks, schema migrations, `SOURCE_PROVENANCE.md`, repository scripts, `packages/**`, `infra/**`, Compose/routes, shared operator console and release artifacts; request an integrator reservation before editing.
- Shared-contract writer: permanent AIchatTG integrator for migrations, shared routes, manifests, infrastructure and cross-module contracts; at most one reserved writer at a time.
- Integration owner/target: permanent AIchatTG integrator, canonical `/Users/alexeykrolmini/Code/AIchatTG` branch `main`.
- Unrelated dirty paths: preserve all paths outside the accepted task and never reuse auxiliary worktrees as release sources.

## Authority and Attention Gates

- Allowed: repository inspection, local planning, reversible implementation, offline tests/simulation, commits and pushes on the executor branch, bounded sub-agents, and chartered `service-child` tasks whose results this executor accepts.
- Forbidden: merging to `main`, activating Gatekeeper, changing live webhooks/providers, sending external messages/events, using secrets/private production data, copying News state, bypassing the integrator, and claiming a local candidate is deployed.
- Production: blocked until the Product Owner approves the exact candidate and the integrator issues a one-time lease naming SHA, service, scope, rollback, expiry, verification and stop conditions.
- Spending: blocked until the Product Owner gives an explicit target and cap and the integrator records it; local tests use fakes only.
- External actions: Telegram, Tribute, Site and Zapier calls/configuration, webhook mutation, secrets and migration are blocked without exact Product Owner approval and integrator lease.

## Dependencies

- Inputs: current `main`, explicit Product Owner tasks/content, and any integrator-granted shared-file reservation.
- Depends on: Product Owner decisions for onboarding copy/links, activation, privacy/schema changes and external integrations.
- Unblocks: integrator acceptance of a bounded Gatekeeper candidate; activation remains a separate gate.

## Checks

```bash
git status --short --branch && git merge-base --is-ancestor 4508e8aeee0dab418a6275e7296cee3dd1e2290b HEAD
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/gatekeeper test
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/gatekeeper run scenario:check && git diff --check
```

## Stop Rules

- Stop and contact integrator task `019fd019-af89-7b50-a16d-8c7928753f24` before writing a reserved shared file, migration, route/infrastructure contract, or changing data classification.
- Stop for unresolved onboarding copy/link, activation, privacy, schema, external-integration or security decisions and for any production, external, secret or spending boundary.
- A sub-agent or service child never receives integration or release ownership; this executor reviews its evidence and remains accountable.

## Result Contract

Before submitting a candidate, return to the integrator: current production SHA or `not_run`; base and candidate SHAs; deployed, recovered and newly written ledgers; files/additions/deletions; migrations, runtime/config and protected-path effects; rollback consequence; focused and aggregate evidence; risks and scope deviations; lifecycle state; and one next safe action with its owner.

On first turn, reply with `EXECUTOR ACCEPTED: aichattg-gatekeeper-executor-v1`, the verified branch/worktree/base, ownership summary, gates, current scenario status, and `READY FOR PRODUCT OWNER TASK`.
