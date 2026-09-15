# Private Moderator review — root integration acceptance

Lifecycle: `prepared`. Local source **1829573015de5d307868afb73e4ef3dcfc0e7fdb**,
Console **3.3.0**. Not pushed or deployed. Current verified production remains
Console3.2.0/f650fe8 and Assistant2.4.37/runtime335a35a.

## Accepted slice, not live-product completion

The frozen worker candidate implements a synthetic private review cycle:
observation, visible case, fake alert, authenticated human verdict, draft
examples/history and manual private-store erasure. The root mounts its API
without a store, origin, collector or sender. Status is explicitly disabled;
case/history/pattern/decision/erase calls return503 after existing auth.
No ingestion route, runtime hook, production database or live transport exists.
Help explains this boundary. Existing moderation enforcement is unchanged.

This accepted local slice is not a working live collection/delivery release.
Do not ask for or execute a production deployment as a substitute for the
remaining bridge implementation and product/security decisions.

## Source provenance and root corrections

All18 frozen worker hashes were rechecked against the unchanged d85f worktree
at9d326f4. The original manifest/contracts v1–v4/proposed patch and worker report
are preserved as historical artifacts. Root source differs in exactly four
manifest files: store, preview and their two test files. The Moderation page,
detector, HTTP, alert and other feature tests are byte-identical to the offer.

Root corrections, specified in contractv5:

1. Detector input is retained text/context, not a hidden discarded suffix.
   Any clipping suppresses new claims/reasons/repeat grouping/alerts. Clipped
   latest history is ineligible for corroboration. Full-input hashes remain
   solely for native-revision collision detection.
2. Removed fingerprint-only fallback for case lookup. Qualified related
   messages cover valid repeat grouping. Historical clipped prefixes, edited
   unrelated text, future observations and exercise exclusions cannot bypass
   evidence eligibility. Same-native edits preserve their existing case.
3. Preview refuses nonempty roots, files and symlinks before store construction;
   unrelated files and original permissions stay unchanged.
4. Shared-source additions: disabled authenticated server mount, release3.3.0,
   Help explanation and server regressions. No shared runtime/schema/config,
   dependency, Compose, rate catalog or route edits.

Final accepted store SHA-256:
`3e05c1f87e299da5a7dd7c64980f0ac43c4e59fb3dff5f6ff766f262619ad827`.

## Evidence

`passed`:

- Root aggregate: **910 total,905 passed,5 explicit fixture skips,0 failed**.
  Gatekeeper132; runtime411passed/5skips; core114; knowledge4; Compose3;
  release61; log safety4; acceptance17; Console159.
- Final Console159/159 rerun after Help changes; store/detector/flow55/55
  independently repeated after the final fingerprint correction.
- Independent preview/HTTP/UI/alert65/65 and server6/6; original two P2 findings
  closed. Nonempty0755 root with sentinel was unchanged and no DB created.
- Regression coverage includes clipped suffix/context, conflicting hidden
  revisions, same-native edits, stale fingerprint/exercise/future grouping,
  retained-case visibility/erasure, no invisible repeat proof, two-stage erase,
  immutable decisions, CSRF/auth, one-attempt fake alerts and uncertain sends.
- Source/Assistant-isolation guard on clean exact1829573 passed:
  Assistant2.4.37 unchanged, `assistantChanged:false`.
- Source whitespace checks passed. The preserved original unified-patch artifact
  has one required blank context line containing a space; the precommit staged
  whitespace check excluded that artifact only, preserving its offered hash.
- Frozen unchanged page had worker loopback desktop/mobile390px browser QA,
  literal hostile text and retained/erase navigation evidence. Current actual
  inline-script regression suite passed; root did not repeat visual browser QA.

`not_run`: production deploy/SSH, live capture/import, real alerts/Telegram/model
calls, production private-store writes, migrations, full deployed visual QA,
and five local tests requiring unavailable course/value fixtures.

No accuracy/recall claim follows from synthetic lexical fixtures. SQLite
secure-delete is not physical/backup erasure; ownership is process-local, not
a cross-process lock. Durable consumed-source fencing is required before live
capture so manual erasure cannot be undone by replay.

Ignored evidence: `output/moderation-review-integration-20260915/`.

| Artifact | SHA-256 |
| --- | --- |
| Root TAP | `49deaad54e1be022979a4aecaa1c7ab25049ec5bb9af24079259a0b7c572ebe4` |
| Final Console TAP | `4d23c2156a492dd97ae77fddcd986046c0a61cc8f716830fd4375988bf6c3d19` |
| Exact source guard | `5c0d8c32e98e472a06ebd1877ca003195986378376cb0bb3ba7139da0b555909` |

## Next owner and stop conditions

The Moderator task receives a [local bridge-contract charter](../proposals/2026-09-15-moderation-bridge-charter-v1.md).
Root retains shared integration and release lock. Its position1 mechanical
deployment assignment is recorded in [the queue](../RELEASE_QUEUE.md), but there
is no active lease or SSH authority. Actual recipient/reviewer, approved chats,
fields/limits, backup/copy policy, consumption checkpoint, exact integrated
candidate and rollback must be resolved before any live activation.
