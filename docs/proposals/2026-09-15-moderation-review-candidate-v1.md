# Private Moderator Review — candidate and verification v1

Lifecycle: **prepared**. Synthetic/local feature completed; live collection,
Telegram delivery, active pattern rollout and production deployment are **not**
implemented/authorized by this slice. This is not a deployment receipt.

## Identity and ownership

- Worker: `/Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG`.
- Branch: `codex/moderation-review-v1-20260915`.
- Base/HEAD before root integration: `9d326f419818b616d1c8045ae4d9a812f6a0ad04`.
- Root integrator/deployer: `019fd019-af89-7b50-a16d-8c7928753f24`.
- Worker/controller of follow-through: `019fd023-a949-7961-87cd-693bcb893e2c`.
- Root accepted contracts v1–v4, newest definition takes precedence.
- PO retention decision `01a0a734-795a-7be0-b11d-c1e4ca568c14`: indefinite,
  until manual deletion / new instructions. No automatic eviction or claim
  that storage is free. All current limits are explicitly synthetic fixtures.
- Production baseline supplied by root, last checked 22:07:10 UTC: Console
  3.1.0 `eb0f7fe`, runtime/Assistant 2.4.37 `335a35a`. Not independently read
  remotely by this worker. Other root releases may supersede this baseline.

## Completed local behavior

- Conservative same-chat promotion and exact-repeat seed detector. A single
  book mention, ordinary link or polished writing is not proof of abuse/AI.
- Separate private Console SQLite; immutable revisions, edit/replay fencing,
  visible supporting evidence, case grouping, exact-version human decisions.
- Queue, ordinary retained observations, positive/negative draft examples,
  review history, existing model/rules/reference surface. Existing navigation
  and common CSS are preserved; page-local Russian labels and mobile layout.
- `insufficient_evidence` is audit-only; no example, training or activation.
- All stored evidence is reachable and manually erasable, including ordinary
  messages retained for future repetition detection. Erasure is target-only,
  version/request/principal fenced, with a minimal content-free receipt.
- Fake/injected delivery persists a calling fence before sending a generic
  notice and opaque deep link. Failure/uncertainty is never blindly retried.
- Existing threat Guard, strikes, delete/ban and Assistant behavior unchanged.

## Exact feature files

Existing file changed: `apps/operator-console/public/moderation-v3.html`.

New source modules under `apps/operator-console/src/`:
`moderation-review-detector.mjs`, `moderation-review-store.mjs`,
`moderation-review-alerts.mjs`, `moderation-review-http.mjs`,
`moderation-review-preview.mjs` (explicit loopback synthetic harness only).

New tests under `apps/operator-console/test/`:
`moderation-review-detector.test.mjs`, `moderation-review-store.test.mjs`,
`moderation-review-alerts.test.mjs`, `moderation-review-http.test.mjs`,
`moderation-review-flow.test.mjs`, `moderation-review-browser-state.test.mjs`.

No deleted files, dependency/lockfile edits, runtime edits, common CSS/nav
edits, Compose/env/secret changes, runtime-DB writes or protected-source edits.
Other preserved untracked proposal artifacts are not part of this candidate.
Content fingerprints are in the sibling `...-source-manifest-v1.md`.

## Evidence

All commands use `/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin` first
in PATH; local dependencies installed from the existing lockfiles, offline.

| Check | Result |
| --- | --- |
| `npm --prefix apps/operator-console test` final suite | passed: 146 / 146, zero skipped |
| `npm --prefix apps/telegram-runtime test` unchanged runtime | passed: 411, failed: 0, skipped: 5 (416 total) |
| UI actual inline-script, deferred-response/race suite | passed: 39 / 39 |
| Store suite including v4 and prior assurance regressions | passed: 25 / 25 |
| Independent store/HTTP assurance rerun | passed: 31 / 31 plus asserted reproductions |
| `git diff --check` | passed |
| Proposed root disabled patch `git apply --check` | passed against worker base; not applied |
| Browser Basic auth, opaque selected-case link, positive/negative drafts | passed on loopback synthetic harness |
| Hostile source rendered literally | passed: zero generated `img` DOM nodes |
| Mobile 390 × 844 | passed: document/client width both 390; selected evidence before queue |
| Ordinary retained case / no-alert / two-step erase and cancel | passed in browser; actual erase round trip passed in HTTP/store tests |
| New production collection, real alerts, model calls, release | not_run |

Browser captures were inspected in the worker conversation. They show synthetic
content only, not production UI or a deployed release. Temporary preview is
loopback-only; it is not a public deliverable URL or production proof.

Independent assurance reproduced and then verified fixes for three issues:
invisible cross-case corroboration after edits; unerasable negative observations;
preview reseeding failure leaving a store open. Retired merged IDs and stale
target versions cannot delete/relabel the merged case. Prior reviewed evidence
and owner decisions remain unchanged.

## Root integration proposal and rollback

`2026-09-15-moderation-review-root-disabled-v1.patch` mounts the authenticated
versioned HTTP handler **without a store**. Review status is truthfully disabled;
no collector, config variable, transport, recipient or production DB is created.
The legacy moderation POST 409 rejection is preserved. Root alone applies this
protected patch and reruns its integrated checks before committing.

If root elects to release this disabled UI slice, source rollback restores the
previous Console image; runtime and Telegram remain untouched. A future writable
production store/collector has separate data rollback, migration and deletion
requirements and is not covered by this source-only rollback statement.

## Remaining work / attention gates

- Root source review, integration/commit and exact integrated candidate identity.
- A separately chartered, locally tested runtime capture / private-store import
  / real Telegram sender integration. No live wiring currently exists.
- Explicit owner recipient and authenticated production reviewer identity;
  exact approved collection chats, evidence fields/limits, durable ingestion
  checkpoint and handling of backups/exports. Retention itself is decided.
- Evaluation before activating seed/pattern rules; no accuracy or bot-detection
  claims from synthetic tests. No paid model purpose/limits approved.
- Exact candidate/config/rollback approval and root release lease, deployment
  receipt and independent production checks before claiming completion.

The store's ownership fence is one-process/single-instance, not a distributed
lock. SQLite secure-delete is a precaution, not a physical-erasure guarantee.
Erasing stored evidence must not later be undone by replaying an old live source;
a future collector needs a durable consumed-source checkpoint before activation.

Next safe action: root reviews the frozen source and disabled hook, commits the
accepted local feature, then charters the remaining local integration. This task
retains release oversight; the root remains the sole production writer.
