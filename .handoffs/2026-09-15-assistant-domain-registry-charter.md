# Task Charter: Universal Assistant domain registry

## Metadata

- Task ID: assistant-domain-registry-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`
- Base ref: `909fad69daf2bed720de075ca2f2fecf9f19afed`
- Worktree/branch: `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`, `codex/assistant-domain-registry`
- Controller: canonical integrator task `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: current Assistant task `019fd023-a940-7cf2-864a-75b20fd842ef`

## Outcome and Acceptance

- Outcome: domain recognition and knowledge binding are described by a human-editable Markdown registry; existing course content, navigation, operations and value plus a small public Assistant profile use the same runtime contract.
- Acceptance: an arbitrary additional test domain is loaded, routed and answered from local Markdown without editing runtime code; existing admitted sources and moderation/cleanup boundaries remain usable; unknown domain and missing knowledge remain distinct; routing can retain more than one domain and separate safety evidence.
- Evidence vocabulary: passed / failed / not_run / inconclusive.
- Offline checks validate runtime mechanics and supplied domain examples, not live model classification quality.

## Scope and Exclusions

- In scope: generic catalog loading/validation, registered route normalization, existing-domain descriptions, public self knowledge, Assistant source selection and response policies, matching offline tests and documentation.
- Excluded: production, remote/network/provider/Telegram calls, paid tests, migration/schema changes, secrets, dependency/manifests, Moderator and Gatekeeper behavior, main merge and push, source-package rebuild or knowledge reorganization.

## Sources of Truth

- `AGENTS.md` — current governance and release boundaries.
- `apps/telegram-runtime/src/runtime.mjs` and existing tests — delivery, moderation, cost and cleanup semantics.
- `docs/ASSISTANT_KNOWLEDGE_ENABLEMENT.md` — recorded source admission and deployed knowledge.
- `/Users/alexeykrolmini/Code/agi/knowledge/domains/` — read-only descriptor design reference; no runtime dependency or database import.

## Ownership

- Owned files/contracts: new domain catalog modules/Markdown and Assistant-specific tests/docs; Assistant-related portions of `runtime.mjs`, `provider-adapter.mjs`, `analyzer-spec.mjs/json`, `analyzer-adapter.mjs`, `route-arbitration.mjs`, `knowledge-adapter.mjs`, `knowledge-slices.mjs`; `config.mjs`/`server.mjs` only if needed for registry loading; `packages/telegram-core/src/index.mjs` only for backward-compatible Assistant routing.
- Shared-contract writer: this task under `RESERVATION CONFIRMED: assistant-domain-registry-v1`, received from canonical integrator on 2026-09-15 after verification of base and worktree.
- Integration owner/target: canonical integrator, `/Users/alexeykrolmini/Code/AIchatTG`, `main`.
- Unrelated dirty paths: none at base; preserve any later unrelated changes.
- Reservation ends at candidate handoff, explicit cancellation or coordinated reassignment. No root-control transfer.

## Authority and Attention Gates

- Allowed: reversible local implementation, scoped subagents, offline tests with fakes, local candidate commit, reviewable evidence.
- Forbidden: main merge/push, shared-path scope expansion, other-project writes or live runtime/data dependencies.
- Production: blocked until exact candidate approval and integrator release coordination.
- Spending: blocked; all provider and Telegram interactions use local fakes.

## Dependencies

- Inputs: verified base, PO agreement to universal domains, integrator single-writer reservation.
- Depends on: existing source admission and moderator disposition contracts.
- Unblocks: integrator review of a prepared candidate.

## Checks

```bash
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm test
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm run check:gatekeeper
git diff --check
```

## Stop Rules

- Stop shared writes on a competing writer, scope conflict or source admission regression.
- Production, spending, secrets and external messages remain outside this candidate.
- No claim that this resolves the separate synthetic menu deletion incident.

## Result Contract

- Return base/candidate SHA, paths/additions/deletions, runtime/contract/config effects, source provenance, offline regression evidence and residual live acceptance requirements.
- Include compound identity and general-rules versus personal-account boundaries.
- Lifecycle: prepared; next owner: canonical integrator for review and integration.

## Result Evidence

- Completed local implementation and independent bounded review. All subagent
  writing scopes have returned to the result owner.
- `passed`: full offline suite, 656 passed / 0 failed / 4 skipped; Gatekeeper
  scenario check (30 machine / 34 human entries); `git diff --check`.
- `not_run`: real-model semantic evaluation, live Telegram and production.
- Candidate report: `docs/reports/2026-09-15-assistant-domain-registry-candidate.md`.
- No production lease, push, main merge, other-project import or spending.
