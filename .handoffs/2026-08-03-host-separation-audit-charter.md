# Task Charter: Audit the parallel AIchatTG host cutover

## Metadata

- Task ID: aichattg-host-separation-audit-v1
- Work kind: assurance
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `AIchatTG origin/main@0f1c2b2c9be6a2d5ef61b589798161352d640d77; current production host read-only`
- Worktree/branch: read-only
- Controller: permanent integrator (`019faf29-b795-7750-8e23-d7b084e992ab`)
- Result owner: permanent integrator

## Outcome and Acceptance

- Outcome: a grounded, non-mutating inventory of the shared VPS routing, existing News runtime and safe parallel-service seam for AIchatTG.
- Acceptance: identifies only non-secret service/container/volume/router facts needed for an exact future cutover; proposes a no-Digest-rebuild deployment topology and rollback target.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: read-only SSH/Docker/Compose/Traefik/health inspection and exact route/service/volume conflict analysis.
- Excluded: all writes, builds, recreates, Compose edits, image tags, database backups, `.env` reads containing values, secret disclosure, webhooks, Telegram calls, provider calls, publication, deployment, rollback and cleanup.

## Sources of Truth

- `/Users/alexeykrolmini/Code/AIchatTG/AGENTS.md` — desired independent-service boundary.
- current production VPS runtime — read-only ground truth for current containers and Traefik routes.
- `/Users/alexeykrolmini/Code/News/AGENTS.md` — preserved News/publishing ownership boundary.

## Ownership

- Implementation ownership: none. This assurance worker must not own, edit, or
  repair any code, configuration, host artifact or production resource; it
  must not own implementation files.
- Shared-contract writer: permanent integrator owns any future shared Traefik/host contract.
- Integration owner/target: permanent integrator; future target is a new `aichattg` service, never `news-digest`.
- Unrelated dirty paths: all local source trees and all production state are preserved.

## Authority and Attention Gates

- Allowed: read-only host inspection with safe-key/path manifests and public health reads.
- Forbidden: production mutation, secret value output, Docker/Compose action, config modification, token use, external call and spending.
- Production: no deployment authority. A later explicit Product Owner cutover approval and exact one-time lease are required.
- Spending: no provider use.

## Dependencies

- Inputs: current host access and current containers.
- Depends on: none.
- Unblocks: an exact AIchatTG deployment/cutover plan after local runtime is accepted.

## Checks

```bash
ssh news-vps 'docker ps --format "{{.Names}} {{.Image}} {{.Status}}"'
ssh news-vps 'docker network ls'
curl -fsS https://news.questtales.com/health
```

## Stop Rules

- Stop without mutation if host access is unavailable, a route/volume conflict cannot be identified safely, or evidence would expose secrets.
- Do not self-fix a finding; return it to the controller with the exact fact
  and a proposed bounded remediation. It must not fix its own findings.
- Do not infer a deployment lease from this audit.

## Result Contract

Return:

- non-secret runtime, route and storage facts;
- candidate parallel-service topology and exact conflict risks;
- evidence as passed / failed / not_run / inconclusive;
- one next safe action and its owner.
