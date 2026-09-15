# Task Charter: Routing-only comparison

## Metadata

- Task ID: assistant-routing-only-evaluation-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`
- Base ref: `bcd60bfc6d51db4a04ccbf50084c9c2bc5546386`
- Worktree/branch: `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`, `codex/assistant-domain-registry`
- Controller: canonical integrator `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: current task `019fd023-a940-7cf2-864a-75b20fd842ef`

## Outcome and Acceptance

- Outcome: isolate question understanding and domain classification from domain answering.
- Acceptance: frozen regression and independent cases; recorded-output comparison showing raw model choice separately from rule-adjusted choice; missing measurements never scored as passes.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: routing-only benchmark/scoring; R1 compound-domain labels; R2 generic local dry routing; bounded route diagnostics in existing receipt JSON; tests and evidence.
- Excluded: knowledge content/organization, retrieval, answer generation, production/network/provider/Telegram calls, secret reads, migrations, dependencies, push and main merge.

## Sources of Truth

- `apps/telegram-runtime/src/assistant-domain-routing.mjs` — current routing contract.
- `apps/telegram-runtime/src/route-arbitration.mjs` — unchanged legacy baseline.
- PO screenshot questions in this dialogue — observed failures, not recorded internal model verdicts.

## Ownership

- Owned files/contracts: new routing-only evaluator/tests/gold/report; `assistant-domain-routing.mjs`, Assistant-only `runtime.mjs` diagnostic plumbing, `domains/INDEX.md`, `scripts/local-assistant.mjs` and matching tests.
- Shared-contract writer: this task, under CONTINUED SOLE-WRITER RESERVATION CONFIRMED from canonical integrator after review of bcd60bf. Subagents receive disjoint ownership; main owns integration.
- Integration owner/target: canonical integrator / main.
- Unrelated dirty paths: none at base; preserve later changes.

## Authority and Attention Gates

- Allowed: scoped isolated code/artifacts, synthetic and existing approved local package fixtures, fake/recorded-only tests, local commit.
- Forbidden: knowledge Markdown content changes, package changes, answer/provider knowledge policies, moderation/Guard/cleanup/paid policies, external actions, raw question/secret/model-reasoning diagnostic persistence.
- Production: blocked pending exact approval and integrator coordination.
- Spending: blocked pending a separate bounded approval; no live mode in this evaluator.

## Dependencies

- Inputs: current candidate and explicit PO focus on problem 1.
- Depends on: confirmed reservation received; live evaluation remains a separate spending gate.
- Unblocks: route-only live measurement plan and candidate review.

## Checks

```bash
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH node --test apps/telegram-runtime/test/routing-only-eval.test.mjs
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm test
git diff --check
```

## Stop Rules

- No paid inference or production without the exact gate.
- No claim of improved semantic accuracy from supplied fixture outputs or exact-example overrides.
- Do not turn a displayed bad answer into an invented historical route trace.

## Result Contract

- Return candidate/artifact identity, passing mechanics, missing live measurements and next safe action.
- Lifecycle: prepared, not deployed; answer quality remains outside scope.

## Review and expanded acceptance

- Prior bcd60bf is not integration-accepted and must not be deployed.
- R1: the exact full self/operations example must retain both requested domains through the provider boundary in router and dispatch modes.
- R2: local dry harness must consume generic hints and preserve value routing; update transcript semantics without presenting fake choices as model quality.
- Run the complete suite with AICHATTG_KNOWLEDGE_PACKAGE_DIR=/Users/alexeykrolmini/Code/allcourses/code/data/knowledge/packages/ai-140310bf9472 and AICHATTG_VALUE_SLICE_PATH=/Users/alexeykrolmini/Code/allcourses/code/data/knowledge/org/value_slice.json. Read-only fixture use; no copy/import or content changes.
- Review source: `/Users/alexeykrolmini/Code/AIchatTG/output/domain-registry-review-bcd60bf.md`.

## Result Evidence

- Lifecycle: prepared; production and actual model comparison: not_run.
- R1/R2 fixes, bounded routing diagnosis and offline comparison mechanics: passed.
- Complete fixture-backed suite: 682 passed, zero failed, zero skipped.
- Answer policies, knowledge Markdown, packages, migrations and external state unchanged.
- Evidence and separate measurement gate: `docs/reports/2026-09-15-routing-only-comparison.md`.
- Return the exact follow-up commit to the canonical integrator; no transfer of main/release ownership.
