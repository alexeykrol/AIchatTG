# Private Moderator Review activation

Status: procedure; not an activation approval. Exact8a2b27f was deployed and
production-verified23September16:31UTC, Assistant2.4.42/Console3.4.0; see
[current receipt](reports/2026-09-23-review-8a2b27f-deployment.md).
The historical retry steps below describe that consumed release, not authority
to rerun it. Any future operation needs a fresh actual baseline and lease.
The first
approved attempt17.09 was rolled back on deployment-helper timestamp format;
see [receipt](reports/2026-09-17-review-activation-rollback.md). Its lease is
closed; the retained empty store must not be provisioned a second time.
Released components: Console3.4.0 / Assistant2.4.42 (release date2026-09-23),
exact8a2b27f, lifecycle `production-verified`.
The retained rollback baseline for that release, verified23.09 16:26UTC, was:
runtimee523485 / Assistant2.4.41, Consolef650fe8 /3.2.0. Refresh that baseline
before any future approved remote operation. The old7d99ae0/2.4.40 candidate
and its2.4.39 rollback are superseded: neither may remove the safety repair.
This local procedure grants no SSH, deployment, notification or data authority.
The [23September exact gate](proposals/2026-09-23-review-8a2b27f-approval.md)
supersedes the expired19September source/date, not the retained17September
binding. No paid test or new message deletion is included.

## Scope and boundaries

The candidate implements the owner-requested suspected promotion → private Review →
generic personal notification → Admin decision/draft path. It does not add
sanctions, model calls, automatic training, historical replay or imports.
Primary moderation continues if Review fails. Coverage is bounded attempt
telemetry since boot, not a claim of completeness. Indefinite retention until
manual erasure and erasure of linked source identifiers are PO-selected.

The private recipient has been verified read-only. Its numeric identifier is
kept in private ignored evidence, never the repository or synthetic fixtures.
Using the existing Admin credential means **every holder of that credential**
can read, decide and erase Review cases. `reviewerPrincipal=operator` attributes
actions to that credential, not independently to a verified person. This access
effect must be explicitly accepted; do not silently label it personal identity.

## Exact release gate

Before activation record candidate40-characterSHA, both current image IDs,
private bindingSHA256, targets, start boundary, scope/limits, expiry, owner,
verification and rollback/stop rules. Generic advance intent is not this lease.
Root owns the single shared-host master; a delegated operator needs an exact
acknowledged handoff. Use safe-remote-deploy and never unbounded Docker logs.

## Retained binding: mandatory retry distinction

The17September attempt already provisioned a private schema-v2 store. Reuse
requires the **exact retained binding bytes and persisted policy**, including
bindingId, epochId, startAt, limits and caps; expected private binding SHA-256:
`c48f4370dd4ca80b6f9d51cc9846ebef9ad1fce91fe749fc3a4e6d1fe8119b83`.
The frozen start boundary is **2026-09-17T11:48:07.284Z**, not a newly generated
19September timestamp. Store policy identity includes this boundary; changing
it fails checkpoint validation even when the store is empty. There is no
supported in-place rebind/migration. Do not delete, reset or reprovision to
make a changed binding fit.

A fresh approval must explicitly accept retaining that earlier boundary.
Collection processes new deliveries only; it does not fetch history or replay
the gap automatically. Nevertheless, a newly delivered source or genuine edit
dated since that boundary can be eligible, including gap-period material. If
the owner requires a later source cutoff instead, stop for a separately scoped
policy-transition candidate; do not silently reset the retained store.

Retained binding scope to reverify under a fresh exact activation approval:

- Current three Moderator chats only; no new group, source or historical import.
- Newly delivered original events use their original date; edited events use
  edit_date. The applicable event date must be at or after the frozen boundary.
  A genuine later edit can be eligible even when its original message predates
  the boundary. No automatic recovery/backfill; a later genuine delivery may
  be admitted after erasure. Do not describe this as a fresh19September cutoff.
- `allowUserId=false`; only text/caption, supplied direct same-chat reply context
  and required native IDs. Own/exempt bot IDs match the exact runtime configuration.
- `limits`: retentionMs=null, maxTextChars=8192, maxContextChars=2048,
  maxNoteChars=2000, maxObservations=10000; maxEvents=40000,
  maxErasureReceipts=20000. Caps reject new admissions, not delete old evidence.
- maxInflight=4, captureTimeoutMs=1500, ipcTimeoutMs=2000,
  notificationTimeoutMs=5000, notificationIntervalMs=10000,
  maxAlertsPerHour=6. One initial generic notification per case, no resend.
- `recipientChatId`: exact verified private numeric account; `consoleUrl`: exact
  existing HTTPS Admin origin; `reviewerPrincipal=operator` with the access
  consequence above. `deliveryEnabled=true` only under the activation lease.
- `ipcRoot=/run/aichattg-review-ipc`;
  `storeRoot=/var/lib/aichattg/operator-console/review`.
- Stable opaque bindingId/epochId and contract=`moderation-review-binding/v1`.
  All fields are explicit; the file loader rejects additional fields, unsafe
  paths, wrong IDs, modes, ownership and malformed clocks. Do not commit it.

These are proposed bounded operational choices, not a promise of free storage
or an increase in any paid quota. No paid model call is part of Review.

## Prepare and verify the exact source

1. Freeze/commit source, run the complete Node20 suite and migration regression,
   `scripts/aichattg/verify-release-source.sh <candidate> <runtime-baseline>`.
   Preserve current untracked work. Push and verify the exact remote ref.
2. Build both images from `git archive` of that exact source. Check labels,
   Assistant2.4.42/footer and Console3.4.0 inside the images. Never copy dirty
   overlays into a running service or use a synthetic preview store.
3. Compile `docker-compose.yml` plus `docker-compose.review.yml` with the exact
   private environment. The second file is a versioned Compose activation
   extension, not a partial source overlay. Base-only deployment leaves Review
   off. Preserve existing ports/routes, health checks, logging, secrets, models,
   runtime DB, knowledge mounts and other services. Before any recreation, run
   the actual config loader inside the exact image with the complete composed
   environment. Console `OPERATOR_CONSOLE_RELEASED_AT` requires UTC seconds
   (`YYYY-MM-DDTHH:MM:SSZ`); Review `startAt` separately requires milliseconds.
   Never reuse one timestamp formatter for both contracts without validation.
   For the Console release only, normalize the new release instant with
   `new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z')` and pass it to
   the actual config loader. Preserve the retained Review startAt unchanged;
   do not derive it from the new Console release time. The tracked Console
   regression includes the actual failed17September millisecond form.
4. Verify private directory ownership/modes (container UID1000), disk capacity,
   no existing owner/socket, canonical paths and no active other writer. Both
   services share only the Review config file readonly and the project-private
   IPC directory read/write. Runtime must not mount Console Review storage.

## Reopen the retained store under a fresh lease

This is the current retry path. **Do not run the provision command.** Before
recreation, verify the retained binding digest, policy/schema identity,
integrity, directory modes/owners, counts and absence of owner/socket using
approved bounded checks. Compare with the last retained-store receipt; any
unexpected evidence or ownership is a stop, not permission to clear it.
The store opens with its exact policy and preserves all retained data.

The prior release helper/lease is closed and has the wrong runtime baseline.
Do not rerun it unchanged. Any future helper must name the new exact candidate,
baseline runtimee523485 image and Consolef650fe8 image, preserve the binding,
and omit provisioning/deletion. Validate the full composed environment inside
both exact images before recreation. A new lease must cover both services,
private capture/notification effects, limits and the rollback below.

## Historical first provisioning — not the retained-store retry

Provisioning is an explicit production data mutation, not ordinary bootstrap.
The approved new Review root must be fresh/empty. Create its Console-owned
parent and the project IPC/config directories with mode0700; private binding
file0600, UID1000, no symlinks/hardlinks. `create_host_path:false` forbids Docker
silently creating substitutes. Preserve any existing unexpected state and stop.

From the exact candidate Console image, with only the Console data mount and
readonly approved binding, run once as UID1000 (network disabled):

```text
node src/moderation-review-provision.mjs --provision /run/aichattg-review-config/binding.json
```

It creates an empty private schema-v2 store, closes its owner and starts no
collector, socket, timer or sender. It refuses any existing store, even empty.
On error preserve partial state; no automatic cleanup or retry. Normal Console
boot never provisions/rebuilds a missing or damaged database. Policy/hash/schema
and cross-process ownership are verified before intake starts.

The command above describes only a separately approved fresh installation.
It is not idempotent and is forbidden for this retained-store retry.

## Start and verify under the lease

Start the exact runtime and Console through the approved Compose pair. A brief
Review-unavailable interval during recreation is an acknowledged gap, never
invented capture success. Review failure does not stop the main webhook. A
missing/invalid Review binding reports unavailable in Admin when configured,
not a misleading empty queue or disabled-by-choice status.

## Acceptance and stop rules

- Verify exact image/source manifests, both health endpoints/restarts, public
  health, existing auth and all preserved config/schema/mount/route boundaries.
- Authenticated Review status: live, store integrity/ownership valid; content-free
  capture counters available (or explicitly unknown); sender state explicit.
- One PO-authorized synthetic comment in an approved closed test chat can prove
  actual capture → generic private Telegram notice → authenticated case/decision.
  Posting that comment, saving a production decision and erasing evidence are
  separate external/data actions that must be included in the exact acceptance
  lease. Do not replay private historical content or call a model for this test.
  Without that permission mark semantic/live delivery acceptance `not_run`.
- Any uncertain notification halts this sender run; durable calling state
  becomes uncertain after restart, never automatically requeued. Rate cap is
  persisted without source identifiers and cannot be reset by case erasure.
- Stop on ownership/schema/policy mismatch, auth/transport failure, unexpected
  runtime/config change, unsafe mounts, primary degradation or misdirected
  notification. Do not compensate by deleting data, retrying sends or opening
  another SSH connection.

## Disable, rollback and retained data

Review configuration/activation rollback is a production mutation. Under its
lease, gracefully stop the Review-capable services first, then recreate the
previous exact runtimee523485 (Assistant2.4.41) and Consolef650fe8 (3.2.0) with
their prior base configuration. Known baseline images at the last checkpoint:

- runtime: `sha256:dc7585b68a99929c0ce88314fe71f86b46b3b24ef2973c8bdcd8c7df63416bf5`;
- Console: `sha256:6f76808829b1c0e4bc2544330f23fadd3f529e2991e98ce3bd1cac6a811af1e9`.

Refresh image/config identities before an approved attempt. Do not use2c72e01
as this candidate's rollback: that would remove the safety contract repair.
This candidate changes no runtime DB schema versus e523485; verify exact
source/schema compatibility and actual image/config readiness before claiming
a rollback proven. Preserve the private Review database, owner
evidence and config; do not migrate it backward into the synthetic-v1 store.

Previously authorized notifications cannot be recalled; their links may become
unavailable after disabling or erasure. Erasure does not delete Telegram posts,
copies in another case's context, snapshots or backups. All linked native/event/
dispatch identifiers are removed, so a new delivery may appear again.
No automatic stale lock/socket takeover: after an unclean stop, prove both
owners stopped and preserve the exact stale artifacts before controlled recovery.

Never roll the runtime back to a41518f/335a35a against the current database.
Those old binaries are not the baseline for this release. No News container,
database, secrets or routes belong to this operation.
