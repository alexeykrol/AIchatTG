# Task Charter: Bounded routing measurement collector

## Metadata

- Task ID: routing-live-collector-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`
- Base ref: `3f2d2242db083eea30679ad83a962169bb656afe`
- Worktree/branch: `codex/assistant-domain-registry`
- Controller: canonical integrator `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: current Assistant task

## Outcome and Acceptance

- Outcome: record actual routing choices under the PO-approved 104-call / USD20 ceiling (raised explicitly from USD2 in this turn), with per-question and synthetic-dialogue cost accounting.
- Acceptance: immutable one-shot manifest/journal, all attempts reserved before network, no retries, bounded time/cost, fake safety tests before exact experiment lease.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: new collector/safety tests and measurement evidence only.
- Excluded: changes to frozen routing/index/gold, knowledge, answers, production, Telegram, SSH, other-project credentials, dependencies. Integrator separately reopened evaluator/tests to repair mixed out_of_corpus raw scoring before measurement.

## Sources of Truth

- `apps/telegram-runtime/scripts/routing-only-eval.mjs` — frozen plan and scoring.
- `https://developers.openai.com/api/docs/pricing` — fetched current Standard model prices.
- PO's explicit Да after 104 calls / USD2 offer; controller reservation confirmed this turn.

## Ownership

- Owned files/contracts: new `routing-live-collector-v1.mjs`, `routing-cost-summary-v1.mjs`, corresponding tests, charter and versioned measurement report; narrow R3/R4 evaluator/tests repair reservation.
- Shared-contract writer: none; existing files frozen.
- Integration owner/target: canonical integrator / main.
- Unrelated dirty paths: none at base; preserve any later unrelated work.

## Authority and Attention Gates

- Allowed: local isolated implementation, fake tests, read-only non-secret preflight, local candidate.
- Forbidden: secret output/copies, changing credentials or runtime config, unrelated network and production actions.
- Production: blocked, not authorized by experiment approval.
- Spending: PO cap approved; paid execution still blocked until exact collector/plan/model/credential route and one-shot expiry accepted by integrator.

## Dependencies

- Inputs: corrected frozen plan 214b006cdd0d6e0b9e1faaa0472fdf85bddadc7d0cacf6ffca932765e551b3df. Old plans 1c9e00e8 and e88330f0 are invalid for this experiment.
- Depends on: exact experiment lease and local credential-route confirmation.
- Unblocks: real routing comparison, not deployment.

## Checks

```bash
node --test apps/telegram-runtime/test/routing-live-collector-v1.test.mjs
git diff --check
```

## Stop Rules

- Sequential at most104 requests, no retries/resume reset,45s/request,20min whole run.
- Stop on auth/transport/schema/unknown usage or tier/budget/source/expiry failure.
- Whole-run conservative input/output bound must fit USD20 before first call.
- Kill switch: interrupt collector; uncertain attempt remains reserved, never replayed.

## Result Contract

- Exact candidate and immutable run artifacts, actual counts/tokens/cost bounds, remaining missing measurements.
- Return controller review before paid execution; no integration or deployment inference.

## Local Evidence

- Targeted evaluator/collector/accounting:25 passed, zero failed/skipped.
- Full fixture-backed suite:698 passed, zero failed/skipped. Scenario30/34 passed.
- Preflight parser on approved local credential route:passed; key present, enabled=true, official endpoint, exact Luna/low/256 tuple. No key output/copy.
- Collector SHA256:6ff77d67661904aa633c3d021d9955f5c35030214df403951a62112b67845905.
- Experiment execution:not_run pending exact lease. Evidence:docs/reports/2026-09-15-routing-measurement-preflight-v2.md.

## Consumed Experiment and Closure

- Exactfc5a741 collector accepted; one-shot controller lease executed2026-09-15 08:51:38–08:52:51UTC.
- Terminaltransport_failure onattempt48:47valid modelrecords,1uncertain,56unattempted,57missing results; no retry/reset/continuation.
- Known token-price estimateUSD0.00785592; total conservativeboundUSD0.03717845 includinguncertainty. Invoiceunavailable.
- Controller explicitly required offline closure; no self-issued replacementlease, runtime/index/gold change or deployment.
- Partial results and per-question/dialogue accounting:docs/reports/2026-09-15-routing-measurement-result-v1.md.
