# Task Charter: Gatekeeper host-portability repair

## Metadata

- Task ID: `aichattg-gatekeeper-host-portability-v1`
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `6789f13`
- Worktree/branch: isolated worktree, `codex/aichattg-gatekeeper-host-portability`
- Controller: permanent AIchatTG integrator
- Result owner: Gatekeeper portability executor

## Outcome and Acceptance

- Outcome: Gatekeeper can run behind an independent AIchatTG Traefik service
  without accepting unsafe arbitrary public origins or exposing a host listener
  outside an explicit container-runtime setting.
- Acceptance: default local bind remains loopback; only the dedicated Compose
  service selects a reviewed non-loopback bind; enabled Site/Public URL uses a
  strict, canonical HTTPS runtime origin and fails closed on mismatch.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: `apps/gatekeeper/**`, `infra/aichattg/docker-compose.yml`,
  `infra/aichattg/runtime.env.example`, and directly related documentation/tests.
- Excluded: all News files and VPS host files; active routes; source data;
  database migration; webhook registration; external Telegram/Tribute/Zapier
  calls; provider calls; secret injection; deployed configuration.

## Sources of Truth

- `docs/VPS_CUTOVER_RUNBOOK.md` — current separate-service constraints.
- `apps/gatekeeper/src/config.mjs` and `src/server.mjs` — current loopback and
  historical host restriction to replace.
- `AIchatTG@6789f13` — exact integration base.

## Ownership

- Owned files/contracts: Gatekeeper public-origin and bind configuration plus
  its AIchatTG Compose wiring.
- Shared-contract writer: permanent integrator for final FQDN selection and
  external route lease.
- Integration owner/target: permanent integrator, `AIchatTG/main`.

## Authority and Attention Gates

- Allowed: local code/tests/Compose validation and exact-Git candidate push.
- Forbidden: choosing a real FQDN, server access, secrets, route enablement,
  service start, Telegram/Tribute/Zapier/provider requests, production writes.
- Production: blocked until an exact deployment lease after FQDN and final
  runtime are approved.
- Spending: blocked; no network action is allowed.

## Dependencies

- Inputs: `AIchatTG@6789f13` and the independent VPS artefacts at `d00ee8b`.
- Depends on: no active worker result.
- Unblocks: AIchatTG Gatekeeper service activation after public ingress choice.

## Checks

```bash
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/gatekeeper ci
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/gatekeeper test
docker compose -f infra/aichattg/docker-compose.yml config --no-interpolate
git diff --check
```

## Stop Rules

- Stop for an attempt to choose or enable a public hostname, a request to
  inspect/migrate secrets or data, any external call, or a conflict with the
  shared runtime/cutover contract.

## Result Contract

Return an exact candidate commit, scope and config contract, test/Compose
evidence, any security caveat, and a clear statement that FQDN selection and
live activation remain controller/PO gates.
