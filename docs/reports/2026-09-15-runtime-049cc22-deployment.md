# Telegram runtime deployment receipt — 2026-09-15 UTC

Lifecycle: `production-verified`.

## Source and approval

- Product Owner approved commit/push/deploy and then confirmed the exact
  single-service lease in the AIchatTG root task.
- Candidate: `049cc22d02aa052a5002cf8377185b1e3dcb4943`.
- Service: `aichattg-telegram-runtime`, Compose project `aichattg`.
- Registered host alias: `news-vps`; remote owner: the active AIchatTG root
  integrator. One key-only SSH master served this deployment.
- Scope: build the exact Git archive and recreate only Telegram runtime;
  preserve runtime.env values, databases, knowledge, secrets and routes.
- The one-time lease covers this run only, from preparation at 00:19 UTC
  through post-deployment verification. It is consumed by this deployment.
- No migrations, webhook registration, paid-model probes or external Telegram
  messages were executed. Operator Console retained its original container ID.

## Deployed artifact

- Image: `aichattg/telegram-runtime:049cc22d02aa052a5002cf8377185b1e3dcb4943`.
- Image ID: `sha256:0651c6c38001d69eb6f7e5d74d61c2ff85af94d7a7b872ef931cb351cf2d7292`.
- OCI revision label: `049cc22d02aa052a5002cf8377185b1e3dcb4943`.
- Git archive SHA-256:
  `83d42b406afdfef603dbfee4475abacddd7edd0c31b86a87c5bf9d5e74d5345f`.
- Container start: `2026-09-15T00:20:48.158977874Z`.
- Release directory:
  `/home/agent/aichattg/releases/049cc22d02aa052a5002cf8377185b1e3dcb4943`.
- Content-free host receipts: `evidence/preflight.json` and
  `evidence/postverify.json` under that release directory.

`runtime.env` was copied byte-for-byte from the previous release and remains
mode 0600. Compose receives `AICHATTG_SOURCE_SHA` from the deployment command's
environment; the copied file retains its original value. Future Compose
operations must supply the intended image SHA explicitly.

Existing runtime environment values, bind mounts and Traefik labels matched
the running predecessor. Five new Compose parameters reached the container:
dialogue turn limit `3`, provider timeout `45000`, Telegram timeout `15000`,
empty rewrite model and rewrite reasoning `minimal`. Rewrite remains disabled.

## Verification

- `passed`: full project `npm test` under Node 20.20.0, Gatekeeper scenario
  check (30 machine messages / 34 human entries), nine migration/import tests,
  six framework safety checks, dialog archive regression, Compose validation,
  project isolation, whitespace and relative-link checks before deployment.
- `passed`: independent review and 34 targeted dialogue/provider regressions,
  including full router/analyzer/answer envelopes retaining the newest turns.
- `passed`: clean exact release source; archive digest checked on the host.
- `passed`: production image tag, image ID and OCI revision equal the candidate;
  50 deployed runtime/core source files match the release archive hashes.
- `passed`: container healthy, restart count 0; internal `/health` HTTP 200,
  service `aichattg-telegram-runtime`, ingress enabled.
- `passed`: repeated inspection at 00:24:08 UTC (over three minutes after
  startup) still showed the same candidate, healthy and zero restarts.
- `passed`: offline smoke tests inside the deployed container for deterministic
  self-description, 15s/45s deadlines and complete-input dialogue budgeting.
- `passed`: both public webhook paths return HTTP 401 to an unauthenticated
  empty request, before update processing.
- `passed`: runtime.env content, routes, bind mounts and Console container
  preserved; runtime database schema and dependency files unchanged from the
  predecessor.
- `not_run`: live Telegram conversation and paid-model end-to-end tests;
  the approved deployment did not include those external actions.

## Rollback

Previous image/source:
`f51753f2e1c291af319c3bb791abb1932dd9b9c3`.

Previous image ID:
`sha256:e093cab0630ee13a19d1fffcb6688c262d1a60b694e9d03a4279c09538318c1f`.

The previous release directory and mode-0600 runtime.env remain on the host.
The deployment command would restore that image on a startup/health failure.
Rollback was not needed. A later rollback is a fresh production operation;
recreate only this service from the previous source/config, preserving current
database and knowledge files.
