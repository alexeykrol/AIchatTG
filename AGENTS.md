# AIchatTG Project Rules

## Product boundary

AIchatTG owns the Telegram product:

- Moderator bot;
- Assistant bot;
- Gatekeeper bot and onboarding.

It does **not** own publishing a news digest to a Telegram channel. That
publisher stays in the News Digest project.

## Runtime boundary

The production VPS and Traefik are shared infrastructure, not a shared
application runtime. AIchatTG must have its own:

- repository and release archive;
- container/service and health endpoint;
- database/data root and migrations;
- runtime secrets and configuration;
- webhook routes and bot tokens;
- CI/test and deployment receipt.

No code, SQLite database, `.env`, Compose service, or release artifact may be
silently shared with News Digest. A future explicit integration may add a
versioned API or event contract; direct cross-project database access is
prohibited.

## Safety and releases

- Preserve three bot roles as adapters over one Telegram product core.
- Deploys, bot webhook changes, external Telegram messages, paid model calls,
  production migrations, and secret changes require an explicit Product Owner
  approval and an exact release lease.
- Use exact Git sources for releases. Do not deploy overlays or copy a partial
  tree into a server runtime.
- Never commit credentials, private user data, or production database files.
- Classify evidence as `passed`, `failed`, `not_run`, or `inconclusive`.

## Shared-VPS diagnostic safety

- The permanent integrator owns remote Docker diagnostics on the shared VPS.
  Product executors must not independently run or leave Docker-log readers on
  that host.
- Never invoke `docker logs` directly from an operational script. Use
  `scripts/aichattg/docker-logs-safe.sh`, which bounds both finite reads and
  `--follow` sessions. A timeout exit (`124`) is an incident signal: record it
  and stop rather than retrying in a loop.
- A stale Docker-log client is terminated before any container, daemon, or
  host restart is considered. Host-wide logging-driver or Docker-version
  changes are separate, controller-owned maintenance operations and require a
  Product Owner-approved lease.

## Integrator and executor protocol

Governance since 2026-09-14 (Product Owner decision): there are no permanent
per-module executor sessions. Exactly one repository-root session is the active
AIchatTG integrator **and** executor at a time. It may be Codex or Claude Code;
the Product Owner selects it by assigning the repository task, and a handoff is
required before another root session takes control.

- The active repository-root integrator works autonomously: decomposition,
  subagents, integration, tests and commits are its own decisions and need no
  approval.
- The Product Owner gives goals, approvals and decisions on stops. The
  integrator raises the Product Owner only on a stop, not for routine work.
- A production change — deploy, webhook change, env/config change, migration,
  secret change, paid-model policy — still requires explicit Product Owner
  approval for that exact change (SHA or variable, service, scope, rollback,
  verification). A local test, Git commit or merge to `main` is not proof of
  deployment.
- Before a production change the integrator reports: current production
  image/SHA (or `not_run`), candidate SHA, runtime/config effects, rollback
  consequence, and evidence as `passed` / `failed` / `not_run` /
  `inconclusive`.
- Report exactly one lifecycle state per candidate: `prepared`, `pushed`,
  `PO-approved`, `deployed`, or `production-verified`.

## Assistant public release identity

- The Assistant's public version/date come only from
  `apps/telegram-runtime/src/assistant-release.json`. This component follows
  the historical `2.4.x` line; Git image SHAs, project changelog numbering and
  npm scaffold versions are not substitutes for the public version number.
- Every actually delivered Assistant reply has the code-owned version/date
  footer at the bottom; a multipart answer carries it once on its final part.
  Preserve approved body copy, forceReply, delivery fences and body-only
  dialogue memory. Do not ask the model to invent or append release metadata.
- Any Assistant-affecting source release must advance the component version
  and set its planned release date. Before deployment, run
  `scripts/aichattg/verify-release-source.sh <candidate-SHA> <current-production-SHA>`
  and verify the rendered footer inside the exact deployed image. A missing
  historical metadata baseline is reported as bootstrap, never fabricated.

## Session classification

The former Codex executor worktrees, charters and handoffs under `.handoffs/`
are historical and kept for provenance; `.handoffs/active-module-registry.md`
is no longer a live registry. Durable work is tracked in `CHANGELOG.md`,
`README.md`, `.claude/SNAPSHOT.md`, `.claude/BACKLOG.md` and the docs under
`docs/`, not by per-module executor sessions.

`CHANGELOG.md` tracks what shipped, for a reader of the software.
`docs/OWNER_FEEDBACK_LOG.md` tracks what the Product Owner personally
reported — a live bug, a stale doc, a missing behaviour — with the
diagnosis and the recommendation, including items recommended but not yet
built (`status: proposed`). It also admits `partial`, `superseded` and
`inconclusive` when those are the truthful outcomes. Append an entry there
whenever the Product Owner reports something in chat, whether or not it becomes
code in the same session.

- Before finishing a root task, archive the available Claude Code and Codex
  transcript with `scripts/save-dialogs.sh`. The archive is local and ignored
  by Git; never commit raw transcripts.

- Evidence statuses (`passed` / `failed` / `not_run` / `inconclusive`) and the
  lifecycle states above apply to every candidate regardless of who prepared
  it.
- Subagents spawned by the integrator return a bounded result to it; they do
  not commit, deploy, or hold production access.
