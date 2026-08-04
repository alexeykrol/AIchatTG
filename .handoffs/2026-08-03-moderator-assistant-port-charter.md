# Task Charter: Port Moderator and Assistant to AIchatTG

## Metadata

- Task ID: aichattg-moderator-assistant-port-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `AIchatTG origin/main@b95cfe8672499fd068f785e06b0ba91dd717416c; News origin/main@21c0b14d027fb52e65a3cf54d40de62012370297`
- Worktree/branch: isolated `codex/aichattg-moderator-assistant-port` worktree
- Controller: permanent integrator (`019faf29-b795-7750-8e23-d7b084e992ab`)
- Result owner: Moderator and Assistant port executor

## Outcome and Acceptance

- Outcome: an independently runnable local AIchatTG Moderator and Assistant runtime that retains the Telegram product behavior while removing all imports and startup coupling to News Digest.
- Acceptance: `apps/telegram-runtime` owns its bootstrap, configuration boundary, SQLite connection, HTTP ingress and bot adapters; shared contracts live under `packages/telegram-core`; no source imports reference the News project; tests cover default-no-side-effect startup and explicit webhook/LLM adapter boundaries.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: `apps/telegram-runtime/**`, `packages/telegram-core/**`, their package manifests, tests and extraction documentation necessary for the standalone Moderator/Assistant runtime.
- In scope: exact source reuse from the named News Git object when its contracts can be kept intact through AIchatTG-owned adapters.
- Excluded: `apps/gatekeeper/**`; News source edits; Digest formation; Telegram channel publishing; legacy code deletion; server/Compose/Traefik changes; bot-token use; webhook registration or deletion; Telegram messages; LLM/provider calls; paid use; production database migration; deployment and rollback.

## Sources of Truth

- `/Users/alexeykrolmini/Code/AIchatTG/AGENTS.md` — independent product and release boundaries.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/MODERATOR_ASSISTANT_EXTRACTION.md` — approved first extraction seam.
- `News origin/main@21c0b14d027fb52e65a3cf54d40de62012370297` — immutable legacy source; never use the dirty checkout as a source.
- `/Users/alexeykrolmini/Code/News/news-digest-pipeline/src/pro/moderation/` at that Git object — behavior source only.

## Ownership

- Owned files/contracts: `apps/telegram-runtime/**` and `packages/telegram-core/**`.
- Shared-contract writer: permanent integrator owns any future change that crosses Gatekeeper, Moderator, Assistant or host ingress boundaries.
- Integration owner/target: permanent integrator; target `AIchatTG origin/main`.
- Unrelated dirty paths: preserve all News checkout changes and all `apps/gatekeeper/**` content.

## Authority and Attention Gates

- Allowed: exact-Git source inspection, local implementation in the owned paths, dependency installation, local SQLite fixtures and tests with fake adapters.
- Forbidden: writes outside owned paths, source News modifications, any external Telegram/LLM/Zapier call, token/key use, configuration injection, Docker build/start, webhook action, deployment, or production database access.
- Production: blocked until the Product Owner approves an exact AIchatTG release and an exact one-time cutover lease names its service, bot/webhook targets, rollback, expiry and verification.
- Spending: blocked until the Product Owner approves a bounded model/provider budget.

## Dependencies

- Inputs: the two exact base refs; the AIchatTG Gatekeeper protocol and core-boundary documentation.
- Depends on: no live system state.
- Unblocks: an integrated AIchatTG runtime candidate and a separately reviewed migration/cutover plan.

## Checks

```bash
git -C /Users/alexeykrolmini/Code/AIchatTG rev-parse HEAD
git -C /Users/alexeykrolmini/Code/News rev-parse 21c0b14d027fb52e65a3cf54d40de62012370297^{commit}
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm test
```

## Stop Rules

- Stop for any dependency that would require importing a News runtime file, mounting `news-digest.db`, adding a credential, starting a poller, or changing bot ingress.
- Stop and return a bounded adapter interface when an exact legacy behavior is coupled to Digest-specific data or UI rather than copying it as a hidden dependency.
- Stop for a controller decision before schema/data migration, model-provider access, bot/webhook change, server change or production release.

## Result Contract

Return:

- exact commit/branch and source provenance;
- files and contracts owned or deliberately deferred;
- evidence as passed / failed / not_run / inconclusive;
- any behavior gap from the News source and its safe follow-up;
- one next safe action and its owner.
