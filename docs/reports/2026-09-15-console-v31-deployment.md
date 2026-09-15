# Console 3.1.0 deployment — 2026-09-15 UTC

Lifecycle: `production-verified`. Exact source
`eb0f7fe8455d0c8339d7332dcefe25423ad9f099`; Console only.

## Authority and source

The owner requested version/date/time in the upper-left of every tab, removal
of redundant descriptions, detailed Russian Help, then commit/push/deploy with
oversight. Actual message `01a0a6ff-5cb9-7542-b060-3c9e1f1ee232` in task
«Админка» (`01a0a68d-276e-7d00-8101-3eb730d4b9f5`) was re-read before release.
That task reviews the result; the root integrator remains the only SSH writer.

The source candidate `063f76f613533e9f7c51b9c3a8e00709553cd5bb` was integrated
onto `8f7efd0`, preserving both Console and Moderator owner-feedback entries.
All 17 other changed files match the source candidate exactly. The integrated
source was committed and pushed before deployment. The exact Git archive
SHA-256 is `e61b110dedbfeede1366b2bb7e86bcd58194d71a7377d041e7ba4c06ff77ffe3`.

Lease `console-v31-eb0f7fe-20260915`, expiry 22:30 UTC, permits one forward
Console recreation, bounded verification and at most one conditional rollback
on confirmed application failure with healthy transport. No Telegram/provider
calls, paid resources, bot/config/migration/draft writes or News changes.

## Production identity and effect

- Version **3.1.0**, metadata `apps/operator-console/src/console-release.json`.
- Release timestamp **2026-09-15T22:04:32Z**, set immediately before activation.
- Container started **2026-09-15T22:04:32.562637294Z**; difference **0.562637 s**.
- Container ID `f9d8c4c64698d47819651f781e0b3a9e675407521363495b47decce920ff67b8`.
- Image ID `sha256:97f8a62d7b3ab348d768fc7920da34a74d816594760f44fcc36f2a26af0485c6`.
- Previous/rollback Console `82cb8c60f7ad4dbd773bf76b194794ee313165fe`, image ID
  `sha256:612ea08f06c1fc0d7e98c2782a2b8e120ad2cb392c27ff3e35841749fd7a53f7`.
- Assistant remains **2.4.37**, source
  `335a35ad344706062a292581db4d27c5776c4302`; no runtime recreation.

Only `OPERATOR_CONSOLE_RELEASED_AT` was appended to a new mode-0600 private
Console release configuration. The previous configuration is intact. All other
Console env values, auth token, routes, mounts and displayed runtime settings
were compared and preserved. Draft storage remains separate; runtime SQLite
remains read-only. No draft was created for testing.

The seven primary pages show the same server-rendered line:
`Версия 3.1.0 · релиз 15.09.2026, 22:04:32 UTC`.
Help explains settings, numeric limits, editable Markdown and the distinction
between saving a draft and applying it to a bot. Operational errors, unavailable
data, stale drafts and save confirmation remain visible; redundant introductory
and routine loading/success banners are removed. Legacy variants remain intact.

## Evidence

`passed`:

- Integrated Node 20.20.0 root suite: **782 total, 777 passed, 5 explicit skips,
  zero failed**. Counts: Gatekeeper132, runtime416, core114, snapshot4, infra3,
  release61, log safety4, acceptance17, Console31. The source task's preliminary
  781/776 tally was corrected from the completed root TAP summaries.
- Console31/31, Compose3/3, migration safety9/9, scenario texts30/34,
  isolation/whitespace and exact-source gate. Assistant version2.4.37 unchanged;
  the release guard reports `assistantChanged:false` and no changed paths.
- Independent source review found no blocker. Script review fixed absent-
  container rollback and added immediate pre-mutation deadline budgets. The
  build completed at22:03, well before expiry; forward/rollback `up` reserve
  their90-second timeout plus5-second kill grace.
- Read-only preflight21:58:01UTC: both prior services healthy/restart0,
  unchanged runtime/schema, no Console drafts. Build configuration22:03:15UTC
  added exactly one key and preserved the old env/token/routes/mounts.
- Postverify22:05:05UTC: healthy/restart0; **31 deployed source files** exactly
  match the Git archive; unchanged runtime identity/start/env/schema, routes,
  logging configuration and draft fingerprint. Retained rollback image verified.
- All seven pages and authenticated release API agree on version and UTC time;
  rendered timestamp is independently compared with Docker's actual StartedAt.
- Public HTTPS22:05:19UTC: all seven pages and release API return200 with
  existing auth; Help/release API return401 without it; health200. Eleven
  bounded read-only requests, zero writes.
- Settings/domain read APIs and draft-directory access checks passed. Analytics
  read75 recorded questions in11ms; all75 costs remain unknown, not zero. This
  release adds no usage ledger and does not resolve the separate cost-accounting
  backlog.

`not_run`: five tests requiring absent local course/value fixtures; new paid
model/Telegram acceptance; draft-save production smoke; migration execution.
The default nested historical lane remains23passed/6explicit receipt skips;
no new original-receipt lane was claimed in this Console-only release.

Repeated postverify **22:07:10 UTC** also passed: same healthy/restart0
container and release stamp,31 source matches, runtime/schema/config/routes/
drafts unchanged; analytics8.4ms. Lease consumed and SSH master closed at
**22:07:43 UTC**, socket absence verified; one forward recreation, zero rollback.
No authority remains under this lease for another production mutation.

Independent ordinary-Chrome review passed all seven pages, shared header/menu,
Help anchors and removal of old banners without any save/external write. It
found two minor Analytics copy defects: `в 1 чатах` and the visible English
pricing-table identifier. The infrastructure release is verified; those two
UI defects require a separate small Console candidate and lease before the
owner's full cleanup request is closed. Pricing data/calculations stay unchanged.

## Artifacts and rollback

Token-free local evidence: `output/console-v31-release/`; remote release and
private evidence: `/home/agent/aichattg/releases/eb0f7fe8455d0c8339d7332dcefe25423ad9f099/`.
Local helper scripts are retained alongside the receipts, not committed as
general-purpose deployment tools. Private config and raw transcripts are never
committed.

Key SHA-256 values:

- Lease: `039af06d0717675b080d1dcbd23510f02342ba836da4be39b4a90b979e43d25a`.
- Preflight: `06036d033092cfd7a85e3681e4bfc27b5d4b620b3d17d7ac2c2d698564b93aa9`.
- Postverify: `5c4dcf11b49d37a8a6c6bdaf79d9ee83df1ba7adc2bca4ab3376aae978291430`.
- Public probe: `9b3af62ee0d08d80cb879f58917adb327103fa9e9d977ebb9c3b8b65281733ca`.
- Finalverify: `8cb1bee7ba42271bed0360aadf12358c4fa066e879edb9269d770e3a6fcadcdb`.

Rollback recreates only previous Console82cb8c6 with its retained configuration;
it must not restore databases or delete candidate data. An absent Console is
eligible only with this release's exact activation marker and a successful
daemon inventory; an unexpected existing image stops rollback. Transport
uncertainty never triggers automatic retry or rollback.
