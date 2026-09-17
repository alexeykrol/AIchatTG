# Private Review live-bridge candidate — 2026-09-17

Lifecycle: pushed. This is source acceptance, not a production receipt.
Exact candidate: 7d99ae00533bbf5afe1225510bdb5ed489c8cd2b.
Base main: feb0f0585deff8be9efc4512729170b5b1397f64.
Components: Assistant2.4.40 / planned2026-09-17, Console3.4.0.

## Delivered source

The previously unfulfilled covert book/testimonial promotion workflow now has
a concrete bridge: Moderator webhook projection → bounded private Unix IPC →
Console-owned Review store → generic single-attempt private notification →
authenticated Admin decision/immutable draft and manual erasure. Detection
remains a suspicion and causes no new sanctions or model calls.

PO decisions are recorded in OWNER_FEEDBACK_LOG and the selected v3 contract:
keep primary moderation available on Review failure; erase linked identifiers
without permanent replay markers. Retention remains indefinite until manual
erasure. The PO-selected recipient was verified read-only as a private account
at2026-09-17T10:12:42Z; numeric identity stays only in private ignored evidence.
Runtime remained exact2c72e01 and unchanged; zero sends/mutations, master closed.

Root integrated the isolated detector after exact hash comparison. Other bounded
agents supplied projection/IPC/sender implementations and independent store,
transport, capture/config and provisioning regression checks. Root owns shared
source, store integration, entrypoints, Compose, docs and release authority.

## Safety and repair evidence

- passed: atomic intake receipt/source/case/alert/counter commit; rollback on
  injected receipt failure; same-event/revision conflict rejection including
  historical revisions; native coalescing retains and erases every linkage.
- passed: fresh-only explicit provisioning; owned private paths; cross-process
  fence before SQLite recovery; missing/damaged schema never silently rebuilds;
  ancestor symlink rejection; no synthetic-store conversion/seed/import.
- passed: erase before dispatch prevents sending; authorization is single-use;
  after-authorization erasure permits only an already-authorized generic notice;
  late completion cannot recreate the case. Restart-calling stays uncertain.
- passed: persistent content-free hourly rate cap, no retry/backlog, request
  cancellation before send, one external invocation only, full private recipient
  response validation, bounded IPC bodies/timeouts and exact socket ownership.
- passed: primary starts first; Review throw/reject/timeout/never-resolve/busy
  cannot change webhook result/error. Only bounded content-free coverage survives;
  previous history is unknown, not zero loss. Malformed telemetry is unknown.
- passed: real local IPC end-to-end with fake Telegram, Admin read/decision and
  erasure; no live Telegram send or paid call used as a test.
- passed: Linux IPC20/20 under root and20/20 UID1000 with readonly source and
  network disabled. Local official image Node20.20.2; exact Dockerfile version
 20.20.0 still requires exact-image verification before deployment.
- passed: compiled base+Review Compose and9 mount/security checks: readonly
  binding, shared project-only IPC, Console-only storage absent from Runtime,
  no host ports/new public Review routes and no auto-created host paths.
- passed: local browser visual/interaction check of synthetic covert testimonial
  case, cautious Russian reasons, gap/status language and erase warning/cancel.
  Private content renders as text, not markup. This is not production browser QA.

## Frozen checkpoint

- passed: full Node20.20.0 regression1432 total,1427 passed,5 explicit fixture
  skips,0 failed. Console235/235; runtime702passed/5skips; core268/268.
- passed: migration9/9, clean-source isolation and Assistant2.4.39→2.4.40
  release identity guard against exact production2c72e01.
- passed: `main` pushed and GitHub ref independently checked at exact7d99ae0.
- passed: Review shutdown starts before public HTTP drain; cancellation releases
  sockets/Console ownership and next startup cannot replay uncertain alerts.
- failed, then resolved (local environment): both first image builds stopped while
  resolving official `node:20.20.0-bookworm-slim` metadata: DeadlineExceeded.
  No application build step ran in those attempts. A bounded standalone pull
  exposed the stalled credential helper; it was cancelled without a retry loop.
  A fresh temporary Docker client config pulled the same public official base
  anonymously, without changing saved credentials or restarting the daemon.
  Base digest: d8a35d586fad3af7abb6fdb9ba972388395405f4d462da9e4a4ddcde67b5e0fb.
- passed: both exact7d99ae0 images built from its Git archive with Node20.20.0,
  source labels correct. Runtime58 and Console38 packaged source files match;
  Assistant rendered footer2.4.40/17.09.2026 and Console3.4.0/imports verified.
  Local architecture is linux/arm64, not a claim about the VPS image ID.
- passed: exact-image runtime capture/sender/service53/53; Console standalone
  provisioning/browser-state/server57/57 passed. No external network or real
  messages: readonly containers, UID1000, temporary synthetic storage only.
  The first broader Console harness could not import a runtime-only test helper;
  that cross-role service suite remains covered by the full source suite, not
  incorrectly bundled into the Console image just to make its harness run.
- Activation approval was requested for this exact source and documented bounds,
  access consequences, existing3 chats,6 notices/hour and45-minute release window.
  No active production lease was opened; production remains unchanged.

Ignored evidence under output/review-bridge-v3 (SHA256):

| Artifact | Digest |
| --- | --- |
| root-tests-final-freeze.tap | b1a4329fdd1492572311c090096d745f08b84e1ec3bcf4590e7a01e0ddcd1d0c |
| migration-combined.tap | 276d6df357846944c2145a263141e5f701531f13ffa7f58937cf00b7f11f63a6 |
| linux-ipc-uid1000.tap | 9eb8d7e9d196f65d1b40ba0668fcfaefac8cd0e90966458694d17846a71324ce |
| compose-review.audit.json | e1eb7311b7e5d498b35e26e77fb62956956bbe0480dd923959238822a0b7f061 |
| image-runtime.json | f159d1d6bef00064d2be12d106a363eb7a2221f404d12b1393bd8e17e781ca62 |
| image-console.json | ac23d26fb52da5650b24aaeba959ea5e2b261fcbe2e419e9dba8a39f7fdebc83 |
| image-runtime-tests.tap | 6044923bb788e871a09ec016d6bf63410e7d8f64057406d87c38d5299b8ccbc2 |
| image-console-self-contained-tests.tap | bfbde7a67042d0c2c36361e2f303cfd15fa33365aea3cb463c645f92db10eb36 |

No raw private transcripts/logs or numeric personal recipient ID enter Git.

Local image IDs (not VPS deployment receipts):

- runtime: sha256:b2421979a1fba47b643924cebe24ee90cbb78016bd337d56112fd8e44e438651
- Console: sha256:0d6d98f897615bc16a70f8c72a635dc7074914db3f0e4e831abf14bd437274fc

## Residuals and exact production gate

- not_run: new feature deployment, live capture/notification acceptance,
  production Admin decisions/erasure, exact binding and filesystem provisioning.
- inconclusive: real-language precision/recall and real notification delivery
  until scoped live acceptance. Unit fixtures are not performance/quality claims.
- Current production remains Assistant2.4.39/runtime2c72e01 and
  Console3.2.0/f650fe8. No schema/config/token/webhook or other-project mutation.
- Reviewer access matters: reusing the existing Admin credential grants all its
  holders access to the new Review data/actions. It is credential attribution,
  not an independently verified personal identity. Exact approval must include
  this consequence plus chats/start/caps/recipient/source/rollback and a lease.
- Rollback target is the current2.4.39 runtime and3.2.0 Console, retaining the
  separate Review store. No runtime schema change is introduced. Never use
  a41518f/335a35a with the current runtime DB. Rollback execution is not tested
  in production by this candidate and needs its own explicit lease allowance.

See [activation procedure](../MODERATION_REVIEW_ACTIVATION.md). A disabled-only
deployment must not be called completion of the requested live workflow.
