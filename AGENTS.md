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

## Controller and executor protocol

- The permanent controller/integrator owns cross-bot contracts, shared core,
  migrations, the release queue and production integration. An executor owns
  only its chartered module paths.
- Before a candidate is submitted, every executor reports: current production
  version/SHA (or `not_run`), base and candidate SHAs, already deployed versus
  recovered versus newly written work, files/additions/deletions, migration and
  runtime/config effects, protected-path effects, rollback consequence, and
  evidence as `passed` / `failed` / `not_run` / `inconclusive`.
- A production change requires both explicit Product Owner approval for that
  exact candidate and a one-time controller lease naming SHA, service, scope,
  rollback, expiry, verification, and stop conditions. The executor may then
  do the mechanical exact-Git deployment and return a receipt; it never gains
  ownership of other modules.
- A candidate, local test, Git commit, or controller acceptance is not proof
  of deployment. Report exactly one lifecycle state: `prepared`, `pushed`,
  `controller-accepted`, `PO-approved`, `leased`, `deployed`, or
  `production-verified`.

## Session classification

Every durable task is classified on creation and recorded in
`.handoffs/active-module-registry.md`.

- A `user-visible-workstream` is explicitly requested by the Product Owner,
  expected to continue, or directly used by the Product Owner. It stays active
  until the Product Owner replaces or retires it.
- A `service-child` exists only to return a bounded result to its parent. The
  parent archives it only after accepting the result, recording durable
  evidence, confirming no active lease or user attention gate, and checking
  that its worktree is clean or handed off.
- Names, sidebar position, idle state and completed turns are not archival
  criteria. If classification is unclear, preserve the task and ask the
  controller to classify it.
