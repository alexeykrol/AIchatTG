# Task Charter: AIchatTG Assistant and Moderator parity

## Metadata

- Task ID: `aichattg-assistant-moderator-parity-v1`
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `8abaed4`
- Worktree/branch: isolated worktree, `codex/aichattg-assistant-moderator-parity`
- Controller: permanent AIchatTG integrator
- Result owner: Assistant and Moderator port executor

## Outcome and Acceptance

- Outcome: an independently runnable Assistant/Moderator subsystem with
  isolated persistence, knowledge import contracts, model-provider interfaces,
  course-operations routing, and durable safety-to-assistant disposition
  gating.
- Acceptance: it executes offline against explicit fake adapters; no runtime
  import, database, path, secret, or network dependency on News remains.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: `apps/telegram-runtime/**`, `packages/telegram-core/**`,
  `data/knowledge/**`, `docs/**` directly describing this port, and their
  package manifests/locks if essential.
- Sources: deployed News moderation source `a729ccd`, accepted course-operations
  overlay `ef1c6ea`, and their tests/prompt artefacts as reference only.
- Excluded: `apps/gatekeeper/**`; all News files; any News or production SQLite
  file; raw course/student/Telegram event data; Docker/Compose; production
  configuration; bot token/webhook/menu/polling mutation; paid model calls.

## Sources of Truth

- News production moderation source `a729ccd` — deployed Assistant/Moderator
  behavior and source provenance.
- News accepted `ef1c6ea` — course-operations and help behaviour not deployed
  in News but approved as port reference.
- `AIchatTG@8abaed4` — target core contracts and current target boundary.

## Ownership

- Owned files/contracts: Assistant/Moderator runtime and core contracts only.
- Shared-contract writer: permanent integrator for cross-bot event identities
  and data-migration boundaries.
- Integration owner/target: permanent integrator, `AIchatTG/main`.
- Unrelated dirty paths: preserve all work outside this isolated worktree.

## Authority and Attention Gates

- Allowed: exact Git-source inspection, local code/tests, and read-only asset
  inventory. A content-free knowledge importer/manifest may be implemented.
- Forbidden: copying or mounting `/app/data/news-digest.db`, copying secrets,
  production writes, Telegram/provider calls, and any News modification.
- Production: blocked pending an accepted exact AIchatTG candidate and a
  Product Owner deployment/cutover lease.
- Spending: blocked; provider adapters must be disabled by default.

## Dependencies

- Inputs: `a729ccd` deployed source map and `ef1c6ea` accepted unintegrated
  course-operations source behaviour.
- Depends on: isolated core at `AIchatTG@7a40212`.
- Unblocks: one-way data migration and independent VPS cutover.

## Checks

```bash
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/telegram-runtime ci
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/telegram-runtime test
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix packages/telegram-core test
git diff --check
```

## Stop Rules

- Stop for an unresolved source ambiguity, a required copied secret/private
  data set, a direct-News dependency, a change to a shared cross-bot contract,
  production/network action, or a paid-provider requirement.

## Result Contract

Return the exact commit, source/provenance map, files/contracts touched,
evidence as passed/failed/not_run/inconclusive, remaining gaps to production
parity, and the next safe action with its owner.
