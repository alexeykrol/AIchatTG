# Task Charter: Independent AIchatTG VPS release and data-migration artefacts

## Metadata

- Task ID: `aichattg-independent-vps-cutover-v1`
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `8abaed4`
- Worktree/branch: isolated worktree, `codex/aichattg-vps-cutover-artifacts`
- Controller: permanent AIchatTG integrator
- Result owner: infrastructure and migration executor

## Outcome and Acceptance

- Outcome: exact-Git deployment and one-way data-migration artefacts for a
  separate `aichattg` VPS service, including health/rollback/runbook checks.
- Acceptance: artefacts prove unique service/router/data/secrets/release paths
  and cannot mount or recreate News Digest components.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: `infra/aichattg/**`, `scripts/aichattg/**`, and targeted runbook
  documentation below `docs/**`.
- Excluded: application bot behaviour; `apps/gatekeeper/**`; all News source;
  host files; production runtime; existing Traefik/News Compose; bot webhooks;
  secrets; provider and Telegram calls.

## Sources of Truth

- Current VPS topology receipt: shared `root-traefik-1`, `root_default`,
  News on `Host(news.questtales.com)`, and News data beneath
  `/srv/news_agent_001/news-digest-pipeline`.
- AIchatTG `AGENTS.md` and `docs/MIGRATION_FROM_NEWS.md` — separation rules.

## Ownership

- Owned files/contracts: only the dedicated infrastructure/migration artefacts.
- Shared-contract writer: permanent integrator for public routing selection.
- Integration owner/target: permanent integrator, `AIchatTG/main`.

## Authority and Attention Gates

- Allowed: local artefact implementation and read-only VPS topology checks.
- Forbidden: SSH writes, service creation, routing changes, environment/secret
  reads or writes, database copy/import, source overlays, and all external
  calls.
- Production: blocked pending an exact candidate plus a Product Owner lease.
- Spending: blocked; no paid service, provider, or quota action is permitted.
- Public ingress: do not choose a hostname or activate a router; preserve an
  explicit `AICHATTG_FQDN` configuration variable.

## Dependencies

- Inputs: current `AIchatTG/main` and the verified shared-host topology.
- Depends on: no worker result.
- Unblocks: a later bounded server deployment lease after the public hostname
  and final runtime candidate are approved.

## Checks

```bash
docker compose -f infra/aichattg/docker-compose.yml config --no-interpolate
git diff --check
```

## Stop Rules

- Stop for a required host mutation, routing decision, secret, live database
  copy, or contract that would share a News volume/service/database.

## Result Contract

Return exact commit, files/contracts, test/config evidence, a deployment and
rollback sequence, unresolved public-routing input, and passed/failed/not_run/
inconclusive states.
