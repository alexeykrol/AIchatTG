# Russian Console v3 deployment — 2026-09-15 UTC

Lifecycle: `production-verified`.

## Authority and exact scope

After the owner asked whether the new admin panel had actually been deployed,
the integrator confirmed that only Assistant2.4.37 had shipped. The owner's
next direct instruction was «Деплой», referring to the new Console v3.
The one-time `console-v3-82cb8c6-20260915` lease expires22:00UTC and names one
root integrator/SSH owner. The Console task independently oversees the release
evidence and visual acceptance; it does not become a second production writer.

Only `aichattg-operator-console` was built and recreated with
`--no-build --no-deps`. The existing TLS route and Basic-auth token were
preserved. A new Console-owned `operator-console/candidates` directory was
created beside, not inside, the existing runtime database directory.
The database remains mounted read-only into Console. No runtime recreation,
webhook/bot command change, paid call, secret change, database migration,
production draft save, Gatekeeper/News or host maintenance occurred.

## Source and image identity

- Source worker candidate: `c62701c0a438026f4f493c486c8ac83b42c0c192`.
- Main integration base: `1bd8bd8c49de3abfd1a8f74f1ebe0070f4b38669`.
- Integrated production source: `82cb8c60f7ad4dbd773bf76b194794ee313165fe`.
- Exact Git archive SHA-256:
  `bbe69cf6584cba1eae94f2eb8e62bc043c2b75594bbdd70a241bd5012f6f699d`.
- Console image ID:
  `sha256:612ea08f06c1fc0d7e98c2782a2b8e120ad2cb392c27ff3e35841749fd7a53f7`.
- Console container ID:
  `7e9eae2ed36c3e8092e44a20499f25c81774ff98bcd711eb5f70c970c70ccea6`.
- Console started: `2026-09-15T21:23:28.994537597Z`.
- Previous Console / rollback source:
  `5e67451e6cf2d5b3afb336ccd42897bdeefd6f2b`.
- Previous Console image ID:
  `sha256:6ccee5d8e899775294a63443997624f0b38dd0cfd4b3cf1d9218d274ae123314`.
  Its historical OCI revision label was empty; tag, image ID and retained
  exact release/config are the rollback identity, not a fabricated label.

All three Console commits were merged onto current main in a separate clean
release worktree. The sole merge conflict was the feedback log; both histories
were retained. A pre-release editor race was fixed before the final commit.
The final exact source was pushed to canonical main and archived directly from
Git. No partial overlay or stale whole-project runtime was deployed.

## Delivered behavior

Six Russian pages share one navigation: Moderation, Assistant, Settings,
Domain knowledge, Analytics and Tests. Existing URLs redirect to their v3
equivalents; original variants remain under `/legacy/v1/` and `/legacy/v2/`.
Settings and Markdown saves create validated versioned drafts only. There is
no apply-to-runtime endpoint. Tests clearly state that starting a new live run
from the panel is not connected.

Independent review reproduced a race in the submitted v3 editor: a pending
domain read could leave the old text paired with a new selected domain during
save. The integrated fix invalidates the editor on selection, rejects stale or
mismatched responses, binds saves to loaded domain state and fences concurrent
save completions. Nine deterministic tests execute the actual inline script.
Approved UI copy and preserved legacy pages were not rewritten.

The Console receives five new env fields: domain index and draft root paths,
plus displayed chat IDs, dialogue-turn limit and synthetic daily limit.
All pre-existing Console env values and the auth token remain unchanged.
Every displayed `TELEGRAM_RUNTIME_*` value matches the unchanged running
runtime. No bot settings are applied through this display snapshot.

## Verification

`passed`:

- Root tests780/780, zero failures/skips: Gatekeeper132, runtime416, core114,
  snapshot4, infra2, release guard61, log safety4, acceptance-runner17, Console30.
- Default nested historical lane23 passed/6 explicit local-evidence skips;
  separate original-receipt lane29/29 passed, no new network/provider calls.
- Migration safety9/9, whitespace/isolation checks and independent security/
  compatibility review. No production migration was executed.
- Exact-source gate against current runtime335a35a: Assistant version2.4.37
  unchanged, `assistantChanged:false`, no changed Assistant source paths.
- Read-only preflight21:13:54UTC: old Console and current runtime healthy/
  restart0. Rendered configuration adds exactly five declared keys, changes
  no existing keys and preserves token/routes. Runtime display mismatch list
  empty. Retained previous Console configuration matches the old live service.
- New directories are real, non-symlink, UID/GID1000:1000 and mode0700.
  Post-deploy process-user access check confirms draft-root writability;
  no production draft was saved as a test.
- Postverify21:24:28UTC: exact Console image/revision, healthy/restart0;
  all29 Console/bundled runtime source files match the exact archive; six
  authenticated Russian pages, legacy redirects, domain catalog, settings API
  and auth denial passed. Runtime container/image/start time/env/mounts/routes
  and SQLite schema remain identical; `quick_check=ok`.
- External HTTPS probe21:25:00UTC: unauthenticated page/settings API401;
  authenticated settings/analytics pages and settings API200; public health200.
  Credentials and question/answer bodies were not printed or retained.
- Analytics read75 stored answer receipts, with0 fully priced and75 unknown,
  in23.5ms. This is a bounded current-data performance check, not a future
  scalability guarantee. The preflight contained117 analyzer observations.
- Repeat verification21:26:58UTC, 150seconds after the first check: identical
  Console image/container/start time, healthy/restart0; all29source hashes,
  six pages/auth/API/storage and unchanged runtime/schema checks passed again.
  Analytics18.0ms. The rollback image remains present and exact.
- Independent Console-task assurance opened a separate tab in the owner's
  existing ordinary Chrome window using the already available authentication.
  Settings, Domain knowledge and Analytics passed visual/accessibility review:
  identical six-item Russian navigation, current settings, draft-only save,
  and both Markdown sources with distinct titles/content. Screenshots were
  inspected in that task but not saved as files. The owner began actively
  using the tab, so automation stopped instead of navigating away from their work.

`failed`: none in the final local gates or either deployment verification.

`not_run`: production draft saves, applying drafts, new paid or Telegram
acceptance, migrations, command registration, Docker-log reads. Assistant menu
localization and Moderator stale-command removal remain separate prepared work,
not part of this deployment.
Visual review of the other three pages was not completed in this production
pass; their HTTP/source/auth checks passed. The panel was left available to the
owner in the ordinary Chrome tab.

## Analytics limitation

Costs are explicitly incomplete estimates, not invoices. Current receipts omit
some routing/paid-attempt/cache details; absent counters are unknown, not zero.
The recorded journal covers analyzer-enabled chat paths, not all usage.
The production visual check showed38 questions over24hours,44 over7days and75
over recorded history; all75 lacked a complete cost estimate, so average and
total appeared as dashes. The requested cost-accounting feature is therefore
**partial**, pending complete stage/token receipts; deployment success is not
proof of complete cost accounting.
The query currently scans recorded history synchronously; the observed75-row
latency is acceptable but does not remove the need for future bounded aggregation
or a separate complete usage ledger.

## URL, rollback and evidence

Panel: [https://aikrol.questtales.com/](https://aikrol.questtales.com/).
Settings: [Russian settings](https://aikrol.questtales.com/settings-v3.html).
Existing Basic-auth login remains required; no credentials belong in links.

Rollback recreates only Console from the retained5e67451 image and its original
configuration. Keep the current live runtime database and new Console drafts;
do not restore/delete data. Assistant remains2.4.37 on image335a35a and original
container `2ced0e9713f5ad49fa156b7f0ef8e29ee38654b006a2dbccf652349ea95e60b8`.

Content-free evidence is retained in ignored `output/console-v3-release/`
and on the host under
`/home/agent/aichattg/releases/82cb8c60f7ad4dbd773bf76b194794ee313165fe/evidence/`.
The one-time lease was consumed and closed at21:27:13UTC; the only SSH master
was closed and socket absence verified. No rollback was required.
