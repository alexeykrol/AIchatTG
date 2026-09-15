# Console 3.1.1 — Analytics copy candidate

Lifecycle: `pushed`. Exact candidate
`5e55101da4032dc584b87ba381d3f4d83b4e62f0`.
Production deployment is **not authorized by the consumed 3.1.0 lease**.

## Change and evidence

The independent ordinary-Chrome review of the owner's Console cleanup found
two remaining labels: `в 1 чатах` and a technical English pricing identifier.
Console3.1.1 fixes only the visible formatting and advances Console metadata.
The real inline-script tests cover0/1/2/5/11/21/101/111, a missing pricing date,
unchanged input data, one read-only API request and unknown costs remaining `—`.

`passed`: Node20.20.0 root784total/779passed/5explicit fixture skips/0failed;
Console33/33 including two new browser-script tests; independent source review;
whitespace and exact-source gate against runtime335a35a. Assistant remains2.4.37,
`assistantChanged:false`. Pricing JSON, calculations, backend, Compose, bot
runtime/core and existing settings have zero diff against deployed `eb0f7fe`.

`not_run`: hotfix production build/recreation, new remote preflight, production
visual acceptance, paid calls, Telegram calls and draft writes. There is no
active SSH master or release lease for this candidate. The five root skips
require absent local course/value fixtures and are unrelated to Console copy.

## Exact next production decision

Approve one Console-only release from the candidate SHA above:

- Host `news-vps`; service `aichattg-operator-console`, project `aichattg`.
- Build from the exact Git archive and recreate only Console with
  `--no-build --no-deps` after fresh source/config/runtime preflight.
- Change no setting except refreshing the existing Console-only
  `OPERATOR_CONSOLE_RELEASED_AT` to the actual new activation UTC time.
- Preserve token/routes/mounts/drafts, all runtime configuration, databases,
  bot commands, webhooks and all other services. No new paid resource or call.
- Rollback is current Console3.1.0, source
  `eb0f7fe8455d0c8339d7332dcefe25423ad9f099`, image ID
  `sha256:97f8a62d7b3ab348d768fc7920da34a74d816594760f44fcc36f2a26af0485c6`,
  with its retained exact configuration; preserve drafts and all data.
- Verify healthy/restart0, exact source, API/all seven headers/time versus
  actual StartedAt, unchanged runtime/config/data boundaries, and the corrected
  Analytics labels/unknown cost in ordinary Chrome.

The current Console3.1.0 was verified twice, last at22:07:10UTC on2026-09-15;
its lease/master closed22:07:43UTC. A new one-time lease with fresh expiry,
baseline and stop rules must be issued only after exact PO authority is settled.
Safe default: keep verified3.1.0 live; do not automatically deploy main.

## Local evidence

Ignored receipts under `output/console-v311-release/`:

- `tests.txt`: `048979211ebfb328251812ec12b623831e0b6bb1a2e822c252e09ddc22d467cc`.
- `console-tests.txt`: `6ca6037a9c7121de4ddcba4e63907d372de1df22f182df2a45e80a916dca3820`.
- `source-gate.txt`: `d780e2ceca4a3691f3ce35d7c27e7826e85b0a519fba3c6a085b01d47b84d5f5`.

The original release receipt remains
[Console3.1.0](2026-09-15-console-v31-deployment.md); a pushed hotfix is not
proof that production has changed.
