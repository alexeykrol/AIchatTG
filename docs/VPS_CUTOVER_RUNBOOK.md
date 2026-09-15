# AIchatTG independent VPS cutover runbook

## Status and boundary

This runbook defines the bot-runtime containers plus the read-only operator
console, their own image names, bind-mounted data roots, environment boundary,
health checks, disabled Traefik routers, and the separation rules for later
releases. A source commit is not itself a deployment receipt; verify the
current production receipt before mutation.

The permanent AIchatTG integrator owns public routing and the cutover queue. A
production operation needs an exact candidate accepted by that controller, an
explicit Product Owner approval, and a one-time lease stating the SHA, services,
host/path scope, data-migration scope, rollback point, expiry, verification,
and stop conditions.

## Dedicated topology

| Concern | AIchatTG value | Separation rule |
| --- | --- | --- |
| Compose project | `aichattg` | Never run a News Compose file. |
| Services | `aichattg-gatekeeper`, `aichattg-telegram-runtime`, `aichattg-operator-console` | None is named or derived from `news-digest`; the console mounts only the Telegram-runtime DB read-only. Gatekeeper has its own admin surface. |
| Release source | one detached AIchatTG Git worktree at `AICHATTG_SOURCE_SHA` | Build only from that exact revision; no overlay or copied partial tree. |
| Data root | `AICHATTG_DATA_ROOT/gatekeeper`, `AICHATTG_DATA_ROOT/telegram-runtime`, and read-only `AICHATTG_KNOWLEDGE_ROOT` | Must be non-symlink roots outside `/srv/news_agent_001`; no Docker volume or SQLite file is shared. |
| Runtime configuration | lease-scoped, mode-0600 file outside Git | Do not commit, print, or reuse News configuration/secrets. |
| Shared host network | existing external `root_default` | It is only the Traefik attachment; AIchatTG owns different service and router names. |
| Public hostname | `aikrol.questtales.com` | Approved Product Owner hostname; supplied through `AICHATTG_FQDN` in the private runtime file. |

`infra/aichattg/docker-compose.yml` has no default service profile. A later
leased operation must explicitly choose `gatekeeper`, `telegram-runtime`,
and/or `operator-console`. All `traefik.enable` labels default to `false`, so a Compose start cannot
silently activate a route without a separate runtime flag.

## Local candidate checks

Run these from the exact detached source worktree. They read only local source
and perform no network, provider, Docker build, or service-start action.

```bash
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/gatekeeper ci
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/telegram-runtime ci
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix apps/operator-console ci
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm test
node --test scripts/aichattg/test/verify-migration-bundle.test.mjs \
  scripts/aichattg/test/import-runtime-state.test.mjs
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

## Docker-log diagnostic safety

The VPS is shared infrastructure. The permanent AIchatTG integrator is the
only owner of AIchatTG Docker diagnostics; a product executor must not start a
remote log reader or leave one running. This policy does not authorize a
container, Docker-daemon, logging-driver, or host change.

Use the checked-in wrapper rather than invoking `docker logs` directly:

```bash
scripts/aichattg/docker-logs-safe.sh aichattg-aichattg-telegram-runtime-1
scripts/aichattg/docker-logs-safe.sh aichattg-aichattg-telegram-runtime-1 --follow
```

The finite command reads at most 200 lines from the last 10 minutes and has a
20-second deadline. `--follow` reads at most 100 initial lines from the last
10 minutes and has a five-minute deadline. In either case, timeout status
`124` means the Docker client did not complete in time: retain the command,
container, start time, and exit status as incident evidence; do not retry it
in a loop. Check and terminate the stale client before considering any restart
of a container or `dockerd`. Do not retain, commit, or paste raw log output,
which may contain private user data.

The audited host used bounded `json-file` rotation; re-check the live daemon
and target-container settings before every maintenance candidate. Do not edit
or truncate Docker-managed log files. A future migration to the `local` driver
or a Docker Engine version change is a separate maintenance candidate: scope
it to named services, record rollback/verification, obtain Product Owner
approval, then recreate only the named containers.

## One-way data-migration admission gate

No database file belongs in a release archive, a Compose mount, or this
repository. The only accepted input for a later migration is a separately
approved normalized JSONL bundle. Its `bundle-manifest.json` must conform to
`infra/aichattg/migration-bundle.schema.json` and contain:

- an immutable News source commit, but no source path or SQLite file;
- a SHA-256 and line count for a sibling file named exactly `records.jsonl`;
- target `aichattg-telegram-runtime` and schema `runtime-sqlite-v1`;
- the exact accepted candidate SHA and Product Owner
  approval ID.

Validate it without echoing records or values:

```bash
node scripts/aichattg/verify-migration-bundle.mjs \
  --manifest /approved-private-directory/bundle-manifest.json
```

The verifier refuses a source database, a symlink, path traversal, unexpected
manifest fields, a target other than AIchatTG, a bad digest, or a record-count
mismatch. The candidate-side [runtime state importer](RUNTIME_STATE_IMPORT.md)
adds a state-only record allowlist, explicit dry-run/apply modes, current
candidate-SHA admission, all-or-nothing duplicate checks and a content-free
SQLite audit receipt. It still does not prove the external lease or approval:
the controller must approve the record mapping, target transaction, duplicate
policy and privacy handling before any target database write. Never point an
importer at a live News SQLite file.

## Later leased cutover sequence

These steps are intentionally not authorized by this candidate alone.

1. The controller records current production state for both applications,
   accepts one exact AIchatTG candidate, and issues a one-time lease. The
   approved `AICHATTG_FQDN=aikrol.questtales.com` and each allowed route must
   appear in that lease.
2. Create a clean detached AIchatTG worktree at the accepted SHA; run
   `verify-release-source.sh` before any build. Do not stage files from an
   existing host checkout.
3. Create `/srv/aichattg/data/{gatekeeper,telegram-runtime}` (or the other
   approved `AICHATTG_DATA_ROOT`) and the separate
   `/srv/aichattg/knowledge` (or approved `AICHATTG_KNOWLEDGE_ROOT`) as real,
   non-symlink directories owned by UID/GID 1000 and mode `0700`. Confirm all
   three are outside the News data root. The knowledge directory is required
   by the read-only mount even while knowledge admission is disabled.
4. Place a new mode-0600 runtime file outside Git, based on
   `infra/aichattg/runtime.env.example`. Do not inspect or log its values.
   Keep both router flags `false` until their individual ingress approvals.
   The provider remains disabled until all three explicit tuples (Moderator
   safety, Assistant router and Assistant answer) are approved and present.
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

## Configuration-only change (same image)

Used on 2026-09-14 to enable the assistant in a third chat without a new
build. On the host a release lives at
`<AICHATTG_HOME>/releases/<source-sha>/{runtime.env,source/}`; the image tag
is the source SHA. It still requires explicit Product Owner approval for the
exact variable change.

1. Back up the live file next to itself, mode `0600`:
   `cp -p releases/<sha>/runtime.env releases/<sha>/runtime.env.pre-YYYYMMDD && chmod 0600 releases/<sha>/runtime.env.pre-YYYYMMDD`.
2. Edit the one variable in `releases/<sha>/runtime.env` (for example, add a
   chat id to `TELEGRAM_RUNTIME_ASSISTANT_CHAT_IDS`). Do not print the file.
3. Validate the rendered configuration without starting anything:
   `docker compose --env-file releases/<sha>/runtime.env -f <compose> --profile telegram-runtime config -q`.
4. Recreate only the changed service with the same image:
   `docker compose --env-file releases/<sha>/runtime.env -f <compose> --profile telegram-runtime up -d --no-build --no-deps aichattg-telegram-runtime`.
5. Wait for the container to report healthy; verify the variable inside the
   container and check the Telegram webhook `pending` counter (expected `0`).
6. Rollback: restore `runtime.env.pre-YYYYMMDD` over `runtime.env` and repeat
   steps 3–5.

Historical gap: earlier builds had an empty `org.opencontainers.image.revision`
label. The `049cc22` deployment supplied `AICHATTG_SOURCE_SHA` to Compose build
and verified the populated revision label against the exact candidate. Keep
that explicit variable in future build/up commands; the preserved private env
file may still contain the previous image's source SHA.

## Gatekeeper configuration gate before route activation

Gatekeeper keeps its direct local-process default on `127.0.0.1`. Only the
dedicated AIchatTG Compose service sets `GATEKEEPER_CONTAINER_BIND=true`, which
selects the reviewed `0.0.0.0` container listener on the attached Docker
networks; no arbitrary bind address is configurable. Compose also derives the
canonical `GATEKEEPER_PUBLIC_ORIGIN` from the same controller-selected
`AICHATTG_FQDN` used in the Gatekeeper Traefik rule. Gatekeeper rejects IP
literals, non-FQDN names, ports, credentials, paths, queries, and
non-canonical spellings, then appends its fixed `/gatekeeper` public path.

These code-level corrections do not enable routing: keep
`AICHATTG_GATEKEEPER_ROUTING_ENABLED=false` until the controller accepts an
exact candidate, the Product Owner approves the FQDN and route, and a
one-time deployment lease authorizes activation.

The Telegram runtime can start with ingress disabled, but enabling
`AICHATTG_RUNTIME_ROUTING_ENABLED` still requires its own approved FQDN,
webhook secrets, bot configuration, webhook decision, and a paid-model policy
if LLM use is requested. A local health response is never authorization to
perform Telegram, provider, or public-routing activity.

## Operator console gate

`aichattg-operator-console` is a separate optional service at
`https://aikrol.questtales.com/`. It serves the ported Moderator, Assistant and
Tests pages, has no write API, and mounts only the Telegram runtime SQLite
directory read-only. The route remains disabled until
both `AICHATTG_OPERATOR_CONSOLE_ROUTING_ENABLED=true` and a non-empty
runtime-only `AICHATTG_OPERATOR_TOKEN` are present. Its Basic-auth user name is
fixed to `operator`; never reuse a News Digest session, cookie, or token.

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
