# Advertising moderation — verified runtime release 2.4.43

Candidate lifecycle: **`production-verified`**.
Exact runtime source: `ccea9af5652250c159169c986f7e531ee1ac1522`.
Public component: **2.4.43 / 2026-09-24**.
Console remains **3.4.0**, exact source8a2b27f, without recreation.

## Authority and release outcome

The owner explicitly approved the renewed24September source and documentation:
«давай, уж наконец - пуш и деплой!» after the exact ccea9af/6734a2c release card.
The expired23September card was not reused. Exact source branch and main docs
were pushed atomically to the existing private origin and read back before
deployment. The frozen branch is `codex/advertising-policy-20260924`.

Root was the sole remote writer. Fresh baseline05:21:26UTC verified both exact8a
containers healthy/restart0, unchanged environment/schema and live Review.
Lease `advertising-ccea9af-20260924` was issued05:24:51.301UTC, expires
06:24:51.301UTC, and was closed **05:26:58.344UTC** after successful verification.
One runtime recreation, zero Console recreations and zero rollbacks.

Runtime started **2026-09-24T05:26:16.674829016Z** from image:
`sha256:203c512895a1fd1c12137695d34678b5592c06dabb3d857160e3d599fe193d97`.
The active Review peer reported boot **05:26:18.436UTC**, tied to that runtime
start. Initial and repeated verification found healthy/restart0.

## Changes now deployed

- Primary semantic recognition explicitly covers unsolicited/covert
  advertising, including testimonial bait without a URL, price or bot flag.
  Legitimate recommendations, discussion, reports and quotation remain protected.
- The model only classifies meaning/type and supplies validated evidence.
  Versioned code retains sanctions, exceptions, warnings and failure handling;
  validated spam uses the existing delete + author-ban protocol. No regex or
  Review-result shortcut to a sanction.
- Complete enforcement requires both confirmed ban and all required deletions.
  A skipped ban cannot become completed merely because deletion succeeded.
  Terminal uncertainty and no-retry fences remain intact.
- Delivered Assistant replies carry the code-owned2.4.43 /24.09.2026 footer;
  approved answer bodies are unchanged.

No additional model request stage, model/provider change, quota increase,
dependency change, schema migration, secret/webhook/route change or Review
reprovision. The recognition supplement adds input to existing metered safety
calls as disclosed in the approval. No paid evaluation, synthetic Telegram
message, manual sanction or operator-triggered historical replay was run.
Completed actions for9770 and9709 were not repeated.

## Verification

- `passed`:1512 candidate tests /5 explicit fixture skips /0 failures;
  migration9/9 and Gatekeeper scenario30machine/34human checks.
- `passed`: exact clean detached source guard versus8a, including public release
  metadata. A first local guard invocation used the main working directory and
  correctly rejected its docs-tip SHA; rerunning in the detached candidate
  worktree passed before any build.
- `passed`: immutable Git archive SHA256 independently matched by the controller:
  `4899c10d7a8fe289c3ac0f48c17720b067f6197b80c035f721ef72a6cc7464a6`.
- `passed`:62 exact runtime/core source and manifest hashes, Node20.20.0,
  image revision and public metadata, before activation and inside the live
  image. A fake Telegram transport verified the actual rendered footer without
  an external send; isolated pre-activation image checks used networknone.
- `passed`: actual runtime config loader accepted the complete composed
  environment and retained Review binding inside the exact new image without
  starting application bootstrap. Original env files, models, routes, mounts,
  logging and security settings are preserved, including the Review overlay.
- `passed`: runtime SQLite schema and integrity unchanged; Review schema,
  policy, binding/start boundary and Console owner preserved. Review collection
  and delivery remain enabled, Review sanctions disabled. Live IPC peer boot and
  counters-known-since-boot were verified, not inferred from socket existence
  or HTTP health alone. Historical coverage still remains unknown by design.
- `passed`: Console's exact container, image, environment and release timestamp
  `2026-09-23T16:28:58Z` unchanged. Public HTTPS health200, unauthenticated
  Admin401, authenticated release3.4.0 and Reviewlive passed.
- `passed`: both getWebhookInfo results HTTP200, expected unchanged routes,
  pending0 and no last error. No webhook registration/change.

Independent source assurance125/125 had no actionable findings. Operational
helper review additionally passed26 focused Review/IPC tests, offline rollback
cases for absent/stopped runtime, rejection of unknown images, and live/stale
peer checks. Before issuing the lease, root corrected helper rollback checks
to use the unchanged Console's read-only database mount rather than depending
on a failed runtime; command/outer time budgets were reconciled. These were
operational helper corrections, not candidate-source changes or production
failures. No rollback was needed.

## Closure, retained rollback and limitations

All remote commands finished before closing the master. SSH returned
`Exit request sent`; the wrapper's immediate socket-absence test raced with
asynchronous closure and returned1. No reconnect or second SSH close was made.
A separate local check verified socket absence at **05:27:52UTC**.
The lease and master are closed; their authority cannot be reused.

Retained runtime rollback: exact source
`8a2b27fb215a19d26cf35b6244dcd4151b7cac4d`, image
`sha256:81e4e7281b152b5ec5bb3136e7eaecfab8ee5ba3a7a9563712ef6282f091fcb7`.
Future rollback requires new authority; it preserves data but cannot undo
already applied bans/deletions. Console remains on image
`sha256:71b8cf9afc8147fd07927af1948c6738104173331e5b9c9697febf75ddd0719b`.

- `not_run`: real model advertising recognition/precision/recall. The24
  synthetic reference labels were injected; no semantic-accuracy guarantee.
- `not_run`: new native Telegram capture→alert→manual decision/erasure E2E.
  Runtime IPC availability is not proof of actual alert delivery.
- `not_run`: new browser-rendered UI acceptance; Console was not changed.

Ignored evidence is under `output/advertising-deploy-ccea9af/`:

- `receipts.json` SHA256
  `eaf7f6d179a272c486ec5897fa8ee1d7a37fb20c5cf1502745248ee1403b0280`;
- `close.json` SHA256
  `8c74ef2bbf1ba5a598f2c88dcbbc7fcf9bbfcd511c7da8166aa85a0ec27ee16d`;
- original issued lease SHA256
  `be665648c5e389b2be028c523ab3e2108160089b4c018eb2b903206058c4e2d6`;
- frozen helper SHA256
  `a6d251d317357d89315ed50a5cbd09b2a8445f29ffbc33311f24e9177c78a5e0`.

The immutable local issuance copy is historical; `receipts.json` contains the
final closed server lease. Raw evidence and transcripts remain ignored, never
committed. No Docker log reader was used during this release.
