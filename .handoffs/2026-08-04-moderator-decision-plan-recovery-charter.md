# Task Charter: Preserve a stored weak-moderation decision through recovery

## Metadata

- Task ID: `aichattg-moderator-decision-plan-recovery-v1`
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `3e181fd2a7d698d5c38b3a343462cd8ac7912ab6`
- Rejected predecessor: `4918b7e10521269bb94241153c0bbe154f09f587`
- Rejected successor: `d71bae945fbe8042d9fcc84448c736f18055d1bc`
- Worktree/branch: executor worktree; new `codex/aichattg-moderator-recovery-*` descendant
- Controller: permanent AIchatTG integrator
- Result owner: Moderator + Assistant runtime executor

## Outcome and Acceptance

- Outcome: a durable weak-abuse decision cannot be re-derived from a later
  strike count after a crash before the first Guard action.
- Acceptance: recovery either executes exactly the originally persisted policy
  with its one reserved strike, or safely quarantines it; it must make neither
  a second model call nor a stronger/different Guard action.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: `apps/telegram-runtime/src/database.mjs`,
  `apps/telegram-runtime/src/runtime.mjs`, their focused recovery tests, and
  only essential runtime documentation.
- Excluded: `apps/gatekeeper/**`, course knowledge/index/content, operator UI,
  News, Compose, VPS files, tokens, webhooks, providers, Telegram calls and
  all production mutation.

## Sources of Truth

- `d71bae945fbe8042d9fcc84448c736f18055d1bc` — exact rejected recovery
  implementation.
- Independent finding: a `delete_warn_1` decision persisted before receipt can
  become `delete_warn_2` after an unrelated weak strike because recovery uses
  a current live counter rather than the stored plan.

## Ownership

- Owned files/contracts: Moderator decision/receipt persistence and recovery
  contract only.
- Shared-contract writer: permanent integrator for database migration shape.
- Integration owner/target: permanent integrator, `AIchatTG/main`.
- Unrelated dirty paths: preserve all.

## Authority and Attention Gates

- Allowed: isolated local implementation, Git commits/pushes and offline tests.
- Forbidden: production database mutation, deployment, secret access, webhook
  or Telegram/provider/model calls, external content, course import.
- Production: blocked pending fresh exact Product Owner approval because the
  eventual candidate contains a data-preserving SQLite migration.
- Spending: blocked.

## Dependencies

- Inputs: `3e181fd`, `4918b7e`, `d71bae` and the independent audit finding.
- Depends on: no live action.
- Unblocks: independent assurance, integration, then a new exact cutover
  decision.

## Checks

```bash
export PATH="/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH"; hash -r
npm test
git diff --check
```

## Stop Rules

- Stop for a need to change Guard/Telegram semantics, model settings, shared
  interfaces, schema outside the runtime's private database, or any live call.
- Do not replace a stored policy with a newly derived policy. If the legacy
  migration cannot prove the plan/strike reservation, quarantine for review.

## Result Contract

Return the exact pushed candidate; scope/stat; migration behavior; a focused
interleaving regression proving no policy escalation or duplicate strike; full
Node 20.20.0 evidence; and passed/failed/not_run/inconclusive states.
