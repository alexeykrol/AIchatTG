# AIchatTG independent VPS cutover runbook

## Status and boundary

This is a **prepared** local candidate, not a deployment receipt. It defines
two separate AIchatTG containers, their own image names, bind-mounted data
roots, environment boundary, health checks, and disabled Traefik routers. It
does not create a VPS service, select a hostname, read or write secrets, copy a
database, change a webhook, or touch News Digest.

The permanent AIchatTG integrator owns public routing and the cutover queue. A
production operation needs an exact candidate accepted by that controller, an
explicit Product Owner approval, and a one-time lease stating the SHA, services,
host/path scope, data-migration scope, rollback point, expiry, verification,
and stop conditions.

## Dedicated topology

| Concern | AIchatTG value | Separation rule |
| --- | --- | --- |
| Compose project | `aichattg` | Never run a News Compose file. |
| Services | `aichattg-gatekeeper`, `aichattg-telegram-runtime` | Neither service is named or derived from `news-digest`. |
| Release source | one detached AIchatTG Git worktree at `AICHATTG_SOURCE_SHA` | Build only from that exact revision; no overlay or copied partial tree. |
| Data root | `AICHATTG_DATA_ROOT/gatekeeper` and `AICHATTG_DATA_ROOT/telegram-runtime` | Must be a new non-symlink root outside `/srv/news_agent_001`; no Docker volume or SQLite file is shared. |
| Runtime configuration | lease-scoped, mode-0600 file outside Git | Do not commit, print, or reuse News configuration/secrets. |
| Shared host network | existing external `root_default` | It is only the Traefik attachment; AIchatTG owns different service and router names. |
| Public hostname | `AICHATTG_FQDN` | The controller selects it later; this repository intentionally contains no hostname value. |

`infra/aichattg/docker-compose.yml` has no default service profile. A later
leased operation must explicitly choose `gatekeeper` and/or `telegram-runtime`.
Both `traefik.enable` labels default to `false`, so a Compose start cannot
silently activate a route without a separate runtime flag.

## Local candidate checks

Run these from the exact detached source worktree. They read only local source
and perform no network, provider, Docker build, or service-start action.

```bash
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/gatekeeper ci
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/telegram-runtime ci
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm test
node --test scripts/aichattg/test/verify-migration-bundle.test.mjs
bash scripts/aichattg/assert-isolation.sh
docker compose -f infra/aichattg/docker-compose.yml config --no-interpolate
git diff --check
```

Before a later build, additionally run:

```bash
bash scripts/aichattg/verify-release-source.sh "$AICHATTG_SOURCE_SHA"
```

It rejects a source SHA mismatch, any tracked or untracked overlay, whitespace
errors, and a Compose reference to a News service, data root, or hostname.

## One-way data-migration admission gate

No database file belongs in a release archive, a Compose mount, or this
repository. The only accepted input for a later migration is a separately
approved normalized JSONL bundle. Its `bundle-manifest.json` must conform to
`infra/aichattg/migration-bundle.schema.json` and contain:

- an immutable News source commit, but no source path or SQLite file;
- a SHA-256 and line count for a sibling file named exactly `records.jsonl`;
- target `aichattg-telegram-runtime` and schema `runtime-sqlite-v1`;
- the exact accepted candidate SHA, controller lease ID, and Product Owner
  approval ID.

Validate it without echoing records or values:

```bash
node scripts/aichattg/verify-migration-bundle.mjs \
  --manifest /approved-private-directory/bundle-manifest.json
```

The verifier refuses a source database, a symlink, path traversal, unexpected
manifest fields, a target other than AIchatTG, a bad digest, or a record-count
mismatch. It is an admission check only: a controller must approve the record
mapping, target-transaction/import procedure, duplicate policy, and privacy
handling before any target database write. Never point an importer at a live
News SQLite file.

## Later leased cutover sequence

These steps are intentionally not authorized by this candidate alone.

1. The controller records current production state for both applications,
   accepts one exact AIchatTG candidate, obtains Product Owner approval, and
   issues a one-time lease. The approved `AICHATTG_FQDN` and each allowed route
   must appear in that lease.
2. Create a clean detached AIchatTG worktree at the accepted SHA; run
   `verify-release-source.sh` before any build. Do not stage files from an
   existing host checkout.
3. Create `/srv/aichattg/data/{gatekeeper,telegram-runtime}` (or the other
   approved `AICHATTG_DATA_ROOT`) as real, non-symlink directories owned by
   UID/GID 1000 and mode `0700`. Confirm it is outside the News data root.
4. Place a new mode-0600 runtime file outside Git, based on
   `infra/aichattg/runtime.env.example`. Do not inspect or log its values.
   Keep both router flags `false` until their individual ingress approvals.
5. Build only the profiles named by the lease from the clean source. Check each
   container health endpoint from inside its container and record image digest,
   source SHA label, service name, data-root path, and restart count.
6. For an approved migration, validate the private normalized bundle first.
   Execute only the separately accepted transactional importer against the new
   AIchatTG data root; record source/bundle/target digests and row counts
   without logging payloads.
7. Activate only the specifically leased router flag and only after its
   application/configuration gates below pass. Verify the public HTTPS route,
   expected authorization response, internal health, and no conflict with the
   News host/path rules. Register or switch a Telegram webhook only under its
   own explicit lease.

## Known blockers before route activation

Two code-level conditions are intentionally not papered over by this Compose
file:

1. `apps/gatekeeper/src/server.mjs` binds its HTTP server to `127.0.0.1`.
   A separate Traefik container cannot reach that listener through
   `root_default`. Keep `AICHATTG_GATEKEEPER_ROUTING_ENABLED=false` until an
   accepted Gatekeeper runtime change supplies a reviewed non-loopback ingress
   boundary and tests it.
2. `apps/gatekeeper/src/config.mjs` currently accepts
   `GATEKEEPER_PUBLIC_BASE_URL` only as `https://news.questtales.com` when the
   site flow is enabled. Do not enable Gatekeeper site routing for a new
   `AICHATTG_FQDN` until the owning application workstream changes that policy
   and the controller accepts it.

The Telegram runtime can start with ingress disabled, but enabling
`AICHATTG_RUNTIME_ROUTING_ENABLED` still requires its own approved FQDN,
webhook secrets, bot configuration, webhook decision, and a paid-model policy
if LLM use is requested. A local health response is never authorization to
perform Telegram, provider, or public-routing activity.

## Rollback boundary

Before any approved build, record the untouched current production service
receipt and create a verified rollback image/source reference for **AIchatTG
only**. If a new AIchatTG service fails before a webhook or data migration is
activated, stop and remove only the leased AIchatTG service and its new router;
do not rebuild, restart, restore, or modify News Digest.

After a data migration or webhook switch, stop automatic rollback. Preserve the
new AIchatTG data root and migration receipts, disable only the new AIchatTG
router/webhook under the lease, and have the controller decide whether a
transactional compensating migration is safe. Restoring an old database
blindly may discard newly received events and is not an approved rollback.
