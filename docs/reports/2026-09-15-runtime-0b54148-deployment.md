# Runtime 0b54148 deployment — 2026-09-15 UTC

Lifecycle: `production-verified`.

## Scope and authority

The Product Owner supplied the exact three-paragraph out-of-coverage response,
viewed it, and requested «Отлично. Деплой.» in message
`01a0a6ab-a9ea-7c90-ac1c-b4f18bc8dedc` of the Assistant task. The root request
also authorized commit, push and deployment. The root integrator alone held
the one-time `aichattg-copy-release-0b54148-20260915` lease, expiring 20:45 UTC.

Only `aichattg-telegram-runtime` was built and recreated with
`--no-build --no-deps`. No new paid test or Telegram send was performed.
Config/secrets, bot settings, webhooks, model tuples/caps, database schema,
knowledge sources/admission, Console, Gatekeeper and News were outside scope.

## Exact sources

- Production candidate: `0b541483ac1c8f2eee32127240c7a0b9f38d4466`.
- Copy source: `541a2def8a208094771fe12a7d88c20d32ef8971`, integrated as
  `71c6568976d745922bfa4388da281df243c1aa65`.
- Prior production/rollback: `5600afd98d69da5e98edf3a7e9abacebff7406af`.
- Git archive SHA-256:
  `8a71a8b0e44bf9cbaa816503810613d172229e8b8559847ddd32857f2d27e7bc`.
- New image ID:
  `sha256:de7d21b63d234b501483d0fa70381336e631e4ede4fb2649fd8f08744f658565`.
- New container ID:
  `579e45bf4006862f587b4ad0dd5154cbe3b148e933f3ad2bcf56d7c7fb1ca4c3`.
- Runtime started: `2026-09-15T20:16:45.147926631Z`.

The clean source was checked in a detached worktree, pushed to canonical
`origin/main`, then archived directly from the exact commit. No overlay was
deployed. The new release directory contains an unchanged copy of the existing
mode-0600 runtime configuration; no secret values were printed.

## Delivered changes

- Menu-first Help explicitly follows menu command → bot prompt → reply with
  the question; `/ask` text and mentions remain secondary paths. Public
  identity grounding and the actual prompt prefix remain consistent.
- The owner's final boundary response replaces the earlier additive candidate,
  without editorial changes. The three paragraphs, punctuation and
  «смогу найти ответить» are preserved exactly.
- Review caught a delivery-path mismatch: `domainBoundaryReply` previously
  shadowed that constant with its own older text. `domain_no_signal` now
  delegates to the shared policy reply; known-domain knowledge gaps remain
  distinct. This adds no sanctions, escalation, retry or classification rule.
- Historical routing checks now run against frozen `5600afd` in isolation;
  current routing/provider checks still test current sources. Historical gold,
  source hashes, captures and paid leases were not rewritten.

## Verification

`passed`:

- Root suite: 688/688 top-level tests; zero failures/skips. Breakdown:
  Gatekeeper 132, runtime 407, core 114, snapshot 4, infra 2, log safety 4,
  acceptance-runner safety 17, Console 8.
- The automatic nested historical lane: 23 passed / 6 explicit evidence-only
  skips. A separate run against original validated receipts passed 29/29,
  without new network/provider calls.
- Focused copy/runtime/retrieval tests: 72/72, included in the root count.
  They check exact Telegram-port output, history, deficit/quota handling and
  the absence of new moderation actions.
- Migration safety tests: 9/9. No production migration was run.
- Gatekeeper scenario: 30 machine messages / 34 human entries; isolation,
  clean exact-source gate and whitespace checks passed.
- Independent offline review confirmed the exact response across three turns,
  zero answer/retrieval/network calls and unchanged known-domain gap handling.
- Production preflight at 20:13:57 UTC confirmed exact `5600afd`, healthy,
  restart 0. Rendered candidate configuration preserved all 64 service env
  values, mounts and routes.
- Post-deploy check at 20:17:31 UTC: exact revision/image, healthy/restart 0,
  internal health 200, SQLite `quick_check=ok`; 55 runtime/core files match
  the source archive. All env values, mounts/routes, schema and log configuration
  match preflight. Console identity/image remain unchanged and healthy.
- Actual in-container domain boundary yields all three approved paragraphs;
  SHA-256 `a58d0b6896776c2431875801e68ffd487807528702bf40427322da949bc902ba`.
  This was an offline function check, not a Telegram send.
- Public HTTPS: health 200; unauthenticated Assistant and Moderator webhook
  requests 401. No webhook secret or valid Telegram update was sent.
- Repeat verification at 20:20:00 UTC, 148 seconds after the first check:
  same container/image/start time, healthy/restart 0, identical source/copy,
  unchanged env/schema/mounts/routes/logging/Console; rollback image verified.

`failed`: none in the final local suite or either production verification.

`not_run`: new paid model tests, real Telegram answer/Help/menu acceptance,
bot-setting changes, webhook changes, migrations/imports, Docker-log reads.
The earlier ordinary-user cleanup acceptance gap remains open; this copy
release is not proof that the human menu scenario has passed end-to-end.

## Rollback and evidence

The exact prior image remains present:
`sha256:21fed69a7866178f491763e15833f305aa5f3ae657c6ff476350c9cf12e872a1`.
Rollback recreates only runtime from the retained `5600afd` release/image.
The current live database must remain in place: no backup restoration or
data/schema rollback is part of this release.

Content-free receipts are retained locally in
`output/coverage-exact-release/` (ignored) and on the host under
`/home/agent/aichattg/releases/0b541483ac1c8f2eee32127240c7a0b9f38d4466/evidence/`.
Historical Help/additive candidate reports are preserved, not overwritten.
The one-time lease was consumed and closed; its only key-only SSH master was
closed at 20:21:05 UTC and the control socket's absence verified. No Docker-log
reader was started. The rollback was retained but was not needed.
