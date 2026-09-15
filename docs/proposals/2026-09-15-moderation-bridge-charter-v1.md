# Task Charter: Local private-review capture and delivery bridge contract

## Metadata

- Task ID: moderator-review-bridge-contract-v1
- Work kind: research
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `1829573015de5d307868afb73e4ef3dcfc0e7fdb`
- Worktree/branch: `/Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG`, existing `codex/moderation-review-v1-20260915`; frozen implementation stays unchanged
- Controller: root integrator `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: task Moderator `019fd023-a949-7961-87cd-693bcb893e2c`

## Outcome and Acceptance

- Outcome: one concrete, versioned LOCAL integration contract for runtime
  capture, private-store intake/checkpoint and injected Telegram alert delivery,
  with exact proposed source reservations and synthetic acceptance cases.
- Acceptance: a bounded implementable next slice that cannot collect/send until
  explicitly configured; no shared runtime DB access; erasure cannot be undone
  by replay; restart/uncertain delivery and ownership fences are explicit.
- Evidence vocabulary: passed / failed / not_run / inconclusive

## Scope and Exclusions

- In scope: read current accepted root source; propose pure capture envelope,
  explicit allowed fields/chats, revision identity, cursor/idempotency contract,
  process boundary and storage ownership, private intake, injected fake/real
  transport interface and failure taxonomy. Explain filtering before retention.
- Excluded: implementation/shared-source edits in this contract pass, real data,
  capture enablement, environment/secret access, real network/Telegram calls,
  trained rules/sanctions, cross-chat profiling, source-history import.
- Retention stays indefinite until manual deletion. Capacity rejects intake;
  it does not delete evidence or silently raise paid quotas.

## Sources of Truth

- `/Users/alexeykrolmini/Code/AIchatTG/docs/reports/2026-09-15-moderation-review-integration.md` — accepted exact source and root corrections
- `/Users/alexeykrolmini/Code/AIchatTG/docs/proposals/2026-09-15-moderation-review-contract-v5.md` plus v1–v4 — private evidence/API/erase/disabled invariants
- `/Users/alexeykrolmini/Code/AIchatTG/docs/proposals/2026-09-15-moderator-review-charter-v1.md` — original PO scope and settled retention
- Accepted source1829573 via read-only `git show`; worker9d326f4/frozen files are provenance, not the accepted root implementation.

## Ownership

- Owned files/contracts: new worker-only `docs/proposals/2026-09-15-moderation-live-bridge-contract-v1.md` and optional sibling `-acceptance-plan-v1.md`.
- Shared-contract writer: root alone for existing modules, entrypoints, config,
  schemas/migrations, dependency manifests, Compose, release metadata and docs.
- Integration owner/target: root integrator, canonical main.
- Unrelated dirty paths: preserve every frozen candidate file and pre-existing
  untracked worker proposal. Do not reset/clean/rebase or overwrite v1–v5.
- Propose reservations for uniquely named adapter modules/tests; root accepts
  the contract and fresh isolated implementation base before writing begins.

## Authority and Attention Gates

- Allowed: local read-only source research, architecture/test contract docs,
  bounded read-only subagents; no commit or push required from this worker.
- Forbidden: SSH, production probes, any real ingestion/send, secret lookup,
  copied production DB/config, guesses of recipient/reviewer/chats/limits.
- Production: blocked; queue assignment is not a lease or activation approval.
- Spending: blocked; all examples/transport outcomes synthetic and offline.
- Identify exact open PO decisions, but finish the safe local contract first.
  Distinguish a configurable test placeholder from an approved live value.

## Dependencies

- Inputs: accepted1829573, contracts v1–v5, existing runtime source read-only.
- Depends on: completed local feature acceptance; no live dependency required.
- Unblocks: root review and specifically chartered local bridge implementation.
- Keep shared-VPS lock with root; no transport handoff occurs here.

## Checks

```bash
git status --short --branch
git show 1829573015de5d307868afb73e4ef3dcfc0e7fdb:apps/operator-console/src/moderation-review-store.mjs
git diff --check -- docs/proposals/2026-09-15-moderation-live-bridge-contract-v1.md
```

Contract acceptance must name tests for duplicate/edit delivery, crash between
capture and checkpoint, erase then replay, source deletion/out-of-order events,
unknown/corrupt checkpoints, capacity backpressure, single-writer startup,
partial/uncertain transport and prevention of raw private text in alerts/logs.
Explain how the runtime acknowledges events without losing intended review
evidence; do not silently change webhook guarantees in this contract.

## Stop Rules

- Stop for conflicting ownership or an architecture/security decision that
  changes the approved boundaries; give root a concrete proposal/options.
- Never use live data to resolve a local contract question.
- No blocking wait on a recipient/production approval while writing the safe
  configurable contract; list unresolved decisions explicitly.

## Result Contract

Return actual document paths, proposed modules/contracts, read-only evidence,
risks/open decisions, synthetic acceptance plan and one next safe root action.
Require a grounded acknowledgement of source1829573 and frozen-worker boundary.
