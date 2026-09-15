# Task Charter: Non-retry routing continuation

## Metadata

- Task ID: routing-nonretry-continuation-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`
- Base ref: `dccda6d688a8dc48cdd05de57166f21a86f29f60`
- Worktree/branch:`codex/assistant-domain-registry`
- Controller:canonical integrator019fd019-af89-7b50-a16d-8c7928753f24
- Result owner:current Assistant task

## Outcome and Acceptance

- Outcome:measure only56never-attempted original requests, without retrying uncertain48 or resetting any count/cost/deadline.
- Acceptance:parent byte hashes and ordered reservations bound; one continuation maximum; cumulative104/USD20; original09:11:38.999UTC deadline.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope:new uniquely named continuation collector/tests/evidence only.
- Excluded:parent artifact edits, frozen runtime/index/gold/evaluator/model/settings changes, repeats, third run, Telegram/answers/production.

## Sources of Truth

- Parent immutable `.handoffs/local/routing-live-collector-v1/` and its consumed lease.
- Controller explicit non-retry preparation authorization in this task.

## Ownership

- Owned files/contracts:new `routing-live-continuation-v1.mjs`, matching test, charter/evidence.
- Shared-contract writer: none.
- Integration owner/target: canonical integrator/main.
- Unrelated dirty paths:none; preserve any later work.

## Authority and Attention Gates

- Allowed:offline preparation/tests and exact controller-leased remaining requests.
- Forbidden:any reserved-key replay, parent overwrite/reset, third run or separate diagnostic API call.
- Production: blocked.
- Spending: PO104total/USD20; new exact controller continuation lease required before network.

## Dependencies

- Inputs:parent48attempts/47results/1uncertain,56remaining keys, frozen plan214b006c.
- Depends on:exact continuation lease; expires no later than2026-09-15T09:11:38.999Z.
- Unblocks:partial-to-complete authorized attempts, not production.

## Checks

```bash
node --test apps/telegram-runtime/test/routing-live-continuation-v1.test.mjs
git diff --check
```

## Stop Rules

- Every next auth/transport/schema/tier/usage/budget/source/expiry failure is terminal, no third run.
- Never extend originaldeadline or reduce carried costs/counts; uncertain48 remains uncertain and unrepeated.

## Result Contract

- Exactcandidate/parent/keydigests, fakechecks, cumulativecost/attempts and immutable merged evidence.
- Return tocontroller before paid execution. If deadline prevents safe preparation, close partial.

## Preflight Evidence

- Node20.20.0:6/6 artifact-bound admission tests passed, zero skipped. In a clean checkout without ignored parent evidence they explicitly skip, never fabricate that evidence.
- Full fixture-backed suite:704 passed, zero failed/skipped; runtime423.
- Full logSHA256:4b588ac297c40d770ca74051a2684c08515082255efdbfd1ff72e6135863a63d.
- CollectorSHA256:ca54102d93e2e9e901338308bf0aa3250bf7ba5a99863a45bb84bb8084b5110d.
- Remaining56keys digest:3b9e534873278b284a66f0d987f16b02d0db4b9135e7d00d229fba23cba4b1fc.
- Parent objectdigest:909d15b8f4e120842402cfd4cce61faa2464c3430627d8650dcf5047d957a9a8; six immutable filehashes pinned in collector.
- Combined worst-case reservation USD0.5045423, carried48attempts, uncertain48 excluded permanently, unchanged09:11:38.999UTCdeadline.
- Parent-first merged childjournal/capture identifies carried events and continuation_started; dollar summary can aggregate without duplicate calls.
- Actual continuation:not_run until exact controllerlease accepted; no parent/source mutation.

## Completed Lease Evidence

- Exactc0ed32b continuation accepted and executed09:07:51–09:09:19UTC beforeoriginaldeadline.
- All56never-attempted keys dispatched once; cumulative104unique attempts,103valid results,oneoriginaluncertain outcome preserved;no thirdrun.
- Parent sixfilehashes unchanged. Mergedjournal/capture/costsummary preserve fullcarry withoutdoublebilling.
- Known token-price estimateUSD0.01543186; total conservativeboundUSD0.07052025 includinguncertainty;invoiceunavailable.
- Newrouter28/28 vsold14/28; analyzer26/27 vsold13/27 onmatchedcases. Onecompound-domain miss,tworisklabeldifferences,one technicalmissingresult remain explicit.
- Versioned final report:docs/reports/2026-09-15-routing-measurement-result-v2.md. No source/index/gold tuning orproduction action.
