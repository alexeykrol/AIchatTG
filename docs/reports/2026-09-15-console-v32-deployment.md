# Console 3.2.0 deployment — 2026-09-15 UTC

Lifecycle: `production-verified`. Exact source
`f650fe87cabf5cf498a64d48907f7a924861cfd2`; Console only.

## Authority and exact source

The owner's «Деплой.» in «Админка», message
`01a0a750-3ec3-7552-992f-f25982d366f1`, answered the exact Console-only release
question and was re-read directly. The root also received «Деплой».
These are one approval, not two releases. Root task
`019fd019-af89-7b50-a16d-8c7928753f24` remained the sole SSH writer.

Canonical reviewed history through `cf08ee0` was pushed and origin/main verified.
The release itself used only the exact f650fe8 Git archive, SHA-256
`8b82d8083a1c0aa4ea05e51f98027f87006a95af97d8e478e3680dc29f7aa609`.
The separate unfinished Moderator working-tree files were not included.
An isolated clean detached f650fe8 source passed the release/isolation gate;
Assistant2.4.37 had no source changes versus production335a35a.

Lease `console-v32-f650fe8-20260915` was issued23:09:37UTC with expiry23:39:37UTC:
one forward Console recreation and at most one conditional rollback on confirmed
application failure with healthy transport. One forward recreation, zero rollback.
Lease consumed and master closed23:13:28UTC; socket absence verified.
No production authority remains under this lease.

## Production result

- Console **3.2.0**, release timestamp **2026-09-15T23:12:03Z**.
- Actual container start **2026-09-15T23:12:04.671980044Z**, delta **1.67198s**.
- Container `8ed3a65689c86f6022e4c51a23c44283c3e39543a439dd5ec08e4d40a731594c`.
- Image `sha256:6f76808829b1c0e4bc2544330f23fadd3f529e2991e98ce3bd1cac6a811af1e9`.
- Assistant remains **2.4.37**, source `335a35ad344706062a292581db4d27c5776c4302`;
  same runtime container, start time, environment, mounts and routes.
- Rollback retained: Console3.1.0 `eb0f7fe8455d0c8339d7332dcefe25423ad9f099`,
  image `sha256:97f8a62d7b3ab348d768fc7920da34a74d816594760f44fcc36f2a26af0485c6`.

Only the existing `OPERATOR_CONSOLE_RELEASED_AT` line changed in a new private
mode0600 release configuration. All other bytes, Console token, routes, mounts,
logging configuration and displayed runtime settings were preserved. Runtime
SQLite stayed read-only for Console; schema quick check and draft fingerprint
were unchanged. Rollback preserves all databases and drafts; no data restore.

## Evidence

`passed`:

- Previously completed exact candidate suite: **792 total,787 passed,5 explicit
  missing-fixture skips,0 failed**; Console41/41. Retained TAP and source-gate
  hashes rechecked; fresh clean-source gate passed before build.
- Key-only route preflight and static transport review; one master with direct
  fallback disabled. Independent helper review found no blocking defect.
- Fresh baseline23:08:12UTC: expected Console3.1.0 and runtime335a35a healthy,
  restart0; correct private config, schema and empty draft fingerprint.
- Config/build23:11:49UTC: exact archive, rollback image/config, unchanged
  settings/routes/mounts and Console-only build passed.
- Postverify23:12:16UTC and finalverify23:12:54UTC: healthy/restart0,
  **31 deployed source files** match exact Git source, seven headers and release
  API agree, auth boundaries and three legacy redirects pass. Runtime identity,
  environment/schema, Console mounts/routes/logging and drafts unchanged.
- Public HTTPS23:12:38UTC: seven pages, release API and health passed, unauthenticated
  Help/release API401; eleven bounded read-only requests, zero writes.
- Real Analytics stage arithmetic, completeness and denominator checks passed.
  Latest five contain four fully estimated questions and one partially known
  question. Full-estimate sum **$0.0263592**, mean **$0.0065898 over four**;
  fifth known-stage subtotal **$0.0257546**, full price unknown. Five-question
  full total remains null, all-known-stage subtotal **$0.0521138**.
  Recorded history75 questions,4 fully estimated,71 unknown; not total bot spend.
  Read latency61.63ms initially,13.58ms on final check.
- Independent ordinary Chrome live QA: version/time, seven Russian navigation
  links, last-five rows, denominator, unknown/full/partial distinctions,
  Russian pricing label, coverage and updated Help pass. Desktop top/bottom
  screenshots inspected without overlap/clipping; browser returned to Analytics.

`not_run`: five fixture-dependent local tests, new paid/Telegram acceptance,
production draft-save smoke, mobile QA, collector/alert activation and migrations.
No provider/Telegram calls, bot setting changes, private-data export, new paid
resources or other-service changes were performed by this release.

Standard uncached estimates are not provider invoices. Historical missing
evidence stays unknown. Full-history aggregation remains a separately tracked
scalability limitation; this75-row measurement is not a large-VPS capacity test.

## Receipts and next queue item

Local ignored evidence: `output/console-v32-release/`; remote release:
`/home/agent/aichattg/releases/f650fe87cabf5cf498a64d48907f7a924861cfd2/`.
Raw logs, private env and transcripts are not committed.

| Receipt | SHA-256 |
| --- | --- |
| Lease | `d1d8a88ea3d712c2ee94ea88034d203d88c215d6499ebabd3bec7652f75f1d6e` |
| Preflight | `2526563224e49ad75130a4a602563f49ae557dd572add5e6df4ce1cacf20db62` |
| Postverify | `032daf2d34c5a6e15777b99796def966500d335d7148376b480173c9f51b0032` |
| Public HTTPS | `ee67c3b3acba70db431fc977d45609f283f4fd1a9c3c06869ae09fdbb4757526` |
| Finalverify | `ad4a18215ac8fe9d9fbf402907981977dc65975f07b762349d4dd9b4b1815ebb` |

The Moderator task is next in the [release queue](../RELEASE_QUEUE.md), but its
candidate fixes/tests and exact release scope are not accepted yet. This closed
Console lease does not transfer or create production authority for that task.

Live URL: [Analytics](https://aikrol.questtales.com/analytics-v3.html).
