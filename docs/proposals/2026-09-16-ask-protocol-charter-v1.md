# Task Charter: restart-safe ask protocol and single-judge ownership

## Metadata

- Task ID: ask-protocol-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `258d17f1c1c01eefbe6df0ec5b69e4abe06bf03c`
- Worktree/branch: `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`,
  `codex/assistant-reply-moderation`
- Controller: root task `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: task «Ассистент», `019fd023-a940-7cf2-864a-75b20fd842ef`

## Outcome and Acceptance

- Outcome: local cross-role judging, visible failure fallback and durable
  30-second service-prompt cleanup candidate.
- Acceptance: Assistant-addressed questions have one Assistant-owned judgement;
  ordinary posts have one Moderator-owned judgement; Moderator/Guard executes
  only the code-derived plan. Duplicate streams/recovery never add a second
  judge. Answers require exact-revision allow; invalid judgement gets fallback.
- Acceptance: expire only the proven command/hint service pair30seconds after
  successful hint delivery, including restart. Preserve Q/A and late-reply
  routing; answer completion/expiry share one durable cleanup claim.
- Evidence vocabulary: passed / failed / not_run / inconclusive.
- The owner's «Давай - все делай.» is relayed by the result-owner task on
  2026-09-16 UTC. It authorizes local implementation, not an unknown-SHA deploy.

## Scope and Exclusions

- In scope: CROSS-ROLE-JUDGEMENT-1, ASK-ROUTER-INVALID operational fallback,
  durable ask expiry/late replies, strict contracts, local schema compatibility,
  recovery, tests and a candidate-specific design/evidence report.
- Excluded: changing porn-spam policy, sanctions/thresholds, bot roles/chat
  scope, pricing/model tuples or limits; Console/Review, knowledge, Gatekeeper,
  News, infrastructure/dependencies and unrelated backlog.
- No fake Moderator webhook, loose safety validation or unjudged-answer bypass.

## Sources of Truth

- `/Users/alexeykrolmini/Code/AIchatTG/docs/OWNER_FEEDBACK_LOG.md` — owner
  direction and the bounded diagnosis of the actual invalid-router incident.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/reports/2026-09-16-porn-spam-policy-deployment.md`
  — current production a41518f/Assistant2.4.38 and closed prior lease.
- Exact base and previously delivered Moderator review — contracts and pitfalls.

## Ownership

- Owned files/contracts, only inside the result-owner worktree:
  `apps/telegram-runtime/src/{runtime,database,safety-v3,guard-adapter,telegram-adapter,server,http-server,moderator-recovery,assistant-policy,route-arbitration}.mjs`;
  new `ask-*.mjs`, `judgement-*.mjs`, `assistant-ask-expiry.mjs` in that src directory;
  `packages/telegram-core/src/{index,schema}.mjs`;
  related `apps/telegram-runtime/test/**` and `packages/telegram-core/test/**`;
  `docs/proposals/2026-09-16-ask-protocol-design-v1.md` and
  `docs/reports/2026-09-16-ask-protocol-candidate.md`.
- Shared-contract writer: result owner exclusively in reserved paths;
  root accepts results and prevents concurrent edits.
- Integration owner/target: root alone, canonical `main`. Public release JSON,
  root docs, release queue, manifests/locks, Compose and production stay root-owned.
- Unrelated dirty paths: none; preserve later unrelated work and frozen Review.
- No commits by delegated workers/subagents. Return the clean-base diff and
  evidence; root will make and verify the candidate commit in the isolated branch.

## Authority and Attention Gates

- Allowed: fast-forward clean target to root's docs-only charter checkpoint;
  reserved edits, offline temp DB/fake-provider tests, non-overlapping subagents.
- Forbidden: edits outside reservation, root main writes, Git push, merge,
  production access, SSH, secrets/private datasets, paid/provider/Telegram calls,
  destructive Git operations or production database tests/migrations.
- Production: blocked unless root accepts an exact candidate, PO approves its
  service/config/schema/risk/rollback scope and root issues a fresh exact lease.
- Spending: blocked; this local charter authorizes no paid calls or resources.

## Protocol Constraints

1. Code-owned raw envelope: native chat/message and original/edit coordinate,
   not bot update ID; bind source/context/policy hashes. Divergent observations
   of one coordinate fence as conflict, not independently judged revisions.
2. Determine one judge before either provider call, regardless of webhook order.
   Either authenticated stream schedules that owner; the second attaches a
   receipt. Preserve existing addressed-message semantics and chat scope.
3. Submission accepts a trusted opaque claim and semantic result only. Derive
   actor/targets/evidence/plan from persisted code-owned input; reject extra
   action fields and forged/stale/mismatched claims. Reuse strict validators,
   actual verbatim spans and priority rules.
4. Atomically accept verdict/plan/native weak reservation/disposition. Same
   submission fingerprint returns the original receipt; conflicting submission
   fails closed. Preserve provider calling/unknown and enforcement
   calling/uncertain fences. Recovery uses persisted owner, never second judge.
   Recheck latest revision after Guard preflight.
5. Persist hint delivery/due time and exact service-pair ownership. Expiry and
   answer cleanup share one bounded claim with no duplicate external delete.
   Preserve edits, uncertain/not-found outcomes, permissions and Q/A. Bound
   overdue recovery; retain linkage for authenticated late replies.
6. Visible invalid-router fallback is code-owned, content-free and once-only,
   with footer/delivery fences. Do not answer unjudged content, reveal internals
   or sanction the sender. Reuse approved copy; label new copy for review.
   Persist bounded reason codes, never raw provider/private content.
7. Schema changes: additive, tested on synthetic old state. Rollback must prevent
   old binaries rejudging pending/late events. No blind DB restore or rerouting
   pending Assistant work to Moderator. Stop if safe transition needs a decision.

## Dependencies

- Inputs: exact base, owner direction, review, synthetic fixtures; no live data.
- Depends on: previous runtime release closure (complete).
- Unblocks: root independent review/integration, then exact release decision.

## Checks

Run with Node20.20.0; install ignored local dependencies only if necessary.

```bash
git status --short --branch
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm run test:runtime
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm test
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH node --test scripts/aichattg/test/verify-migration-bundle.test.mjs scripts/aichattg/test/import-runtime-state.test.mjs
git diff --check
```

Required cases: both webhook orders/concurrency, missing stream, duplicates,
edit conflicts, forged/stale claims/evidence, native weak strike once,
exemptions/shadow/rights, no answer before allow, invalid/unknown without
re-judgement, crash/restart around claims/Guard,30-second boundary and late
reply/answer-cleanup races, not-found/uncertain deletes, preserved Q/A, once-only
fallback/footer/body-only memory. Never change historical gold to pass.

## Stop Rules

- Stop for: conflicting writers/dirty state, required files outside reservation,
  material routing/copy/privacy/cost/architecture decision, inability to fence
  rollback, unavailable safety contract, any production or paid boundary.
- Report progress/checkpoints to root directly; never ask PO to coordinate tasks.
- Send design/state-machine checkpoint before large shared-file patch; continue
  isolated pure-contract/tests meanwhile. Root reviews concrete concerns.

## Result Contract

Return exact base/diff/owned paths, synthetic test totals and receipts, migration/
rollback compatibility, visible copy diff, remaining risks and not_run evidence.
No commit/push/deploy claim. Root is the next owner for independent review,
Assistant version/date bump, candidate commit and integration/source gates.
