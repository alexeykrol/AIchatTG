# Task Charter: Establish AIchatTG as the Telegram bot product

## Metadata

- Task ID: aichattg-product-extraction-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `News origin/codex/telegram-gatekeeper-site-zapier-v1@dbc492f85d7b8f96e601829de4fd369034a47787; AIchatTG origin/main is empty`
- Worktree/branch: `/Users/alexeykrolmini/Code/AIchatTG` on `main`; the Product Owner authorized repository migration on 2026-08-03, including the initial clean commit and push of this local foundation
- Controller: `Интегратор_2_Substack` (`019faf29-b795-7750-8e23-d7b084e992ab`)
- Result owner: permanent integrator for AIchatTG extraction

## Outcome and Acceptance

- Outcome: a clean independent repository boundary for the Telegram Moderator, Assistant, and Gatekeeper product, with the Gatekeeper mechanically ported from its exact accepted source revision and the remaining shared-runtime extraction mapped before code is moved.
- Acceptance: AIchatTG has a validated charter, clear non-overlap with Digest publishing, a provenance-preserving local Gatekeeper port with its own tests, and an evidence-led dependency plan for the Moderator and Assistant port.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: local repository setup, architecture and migration documentation, exact Git-object inventory, isolated Gatekeeper port, local tests, and a dependency map for the Moderator and Assistant.
- Excluded: Digest formation, Telegram channel publishing, `news-digest` code changes, legacy deletion, News production changes, shared-container rebuilds, webhooks, Traefik/config changes, secrets, bot messages, paid models, production database migrations, and deployments.

## Sources of Truth

- `/Users/alexeykrolmini/Code/News/AGENTS.md` — current release lock and the retained Digest/publishing boundary.
- `https://github.com/alexeykrol/AIchatTG.git` — new independent target repository.
- `News origin/codex/telegram-gatekeeper-site-zapier-v1@dbc492f85d7b8f96e601829de4fd369034a47787` — exact Gatekeeper source port.
- `/Users/alexeykrolmini/Code/News/news-digest-pipeline/src/pro/moderation/` — Moderator and Assistant source inventory only.

## Ownership

- Owned files/contracts: all local files under `/Users/alexeykrolmini/Code/AIchatTG`; the product-boundary and source-provenance documents.
- Shared-contract writer: permanent integrator; shared VPS Traefik and any future cross-project ingress must be coordinated separately.
- Integration owner/target: permanent integrator; target is the independent `alexeykrol/AIchatTG` repository and, later, its own runtime/container.
- Unrelated dirty paths: the News root checkout is dirty and behind its remote; it is read-only source evidence and must be preserved.

## Authority and Attention Gates

- Allowed: reversible local file creation, exact source inspection, mechanical local port from the named Git object, local dependency installation and tests that use no external service.
- Forbidden: modifying News sources, touching its protected publishing paths, server/Compose/Traefik/config edits, bot-token use, Telegram API side effects, paid/provider calls, deployment/rebuild, and rollback.
- Production: blocked unless the Product Owner approves an exact independent AIchatTG release and its future release controller issues an exact one-time lease.
- Spending: blocked unless the Product Owner approves an exact cost cap and purpose.

## Dependencies

- Inputs: the exact Gatekeeper source revision; current News moderation source inventory; the target repository remote.
- Depends on: none for the local foundation; future runtime port depends on an explicit owner decision for config, model, database, and ingress adapters.
- Unblocks: a separately reviewable AIchatTG initial commit and a later independent deployment plan.

## Checks

```bash
python3 /Users/alexeykrolmini/.codex/skills/handoff/scripts/validate_charter.py \
  /Users/alexeykrolmini/Code/AIchatTG/.handoffs/2026-08-03-aichattg-extraction-charter.md
git -C /Users/alexeykrolmini/Code/AIchatTG status --short --branch
git -C /Users/alexeykrolmini/Code/News rev-parse \
  dbc492f85d7b8f96e601829de4fd369034a47787^{commit}
```

## Stop Rules

- Stop for source-provenance mismatch, a cross-project contract conflict, an attempt to extract Telegram channel publishing, or a need to change shared host infrastructure.
- Stop for explicit Product Owner approval before any production cutover, paid use, external Telegram operation, secret injection, or production data migration.

## Result Contract

Return:

- the local artifact inventory and exact source provenance;
- the files and contracts created or ported;
- evidence as passed / failed / not_run / inconclusive;
- risks, discrepancies, and scope deviations;
- one next safe action and its owner.
