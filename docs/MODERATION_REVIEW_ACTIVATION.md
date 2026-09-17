# Private Moderator Review activation

Status: prepared procedure; not a deployment receipt or activation approval.
Candidate components: Console3.4.0 / Assistant2.4.40. Production baseline:
runtime2c72e01 / Assistant2.4.39, Consolef650fe8 /3.2.0.

## Scope and boundaries

This completes the owner-requested suspected promotion → private Review →
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

Proposed first binding (values still require exact activation approval):

- Current three Moderator chats only; no new group, source or historical import.
- Newly arriving original/edit source dates at or after the frozen UTC activation
  boundary. No automatic recovery/backfill; a later genuine delivery may be
  admitted after erasure. Original messages predating the boundary stay excluded.
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
   Assistant2.4.40/footer and Console3.4.0 inside the images. Never copy dirty
   overlays into a running service or use a synthetic preview store.
3. Compile `docker-compose.yml` plus `docker-compose.review.yml` with the exact
   private environment. The second file is a versioned Compose activation
   extension, not a partial source overlay. Base-only deployment leaves Review
   off. Preserve existing ports/routes, health checks, logging, secrets, models,
   runtime DB, knowledge mounts and other services.
4. Verify private directory ownership/modes (container UID1000), disk capacity,
   no existing owner/socket, canonical paths and no active other writer. Both
   services share only the Review config file readonly and the project-private
   IPC directory read/write. Runtime must not mount Console Review storage.

## Provision and start under the lease

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
collector, socket, timer or sender. It refuses an existing nonempty store.
On error preserve partial state; no automatic cleanup or retry. Normal Console
boot never provisions/rebuilds a missing or damaged database. Policy/hash/schema
and cross-process ownership are verified before intake starts.

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
previous exact runtime2c72e01 and Consolef650fe8 with the prior base configuration.
This candidate changes no runtime DB schema. Verify actual rollback compatibility
before claiming it proven. Preserve the new private Review database, owner
evidence and config; do not migrate it backward into the synthetic-v1 store.

Previously authorized notifications cannot be recalled; their links may become
unavailable after disabling or erasure. Erasure does not delete Telegram posts,
copies in another case's context, snapshots or backups. All linked native/event/
dispatch identifiers are removed, so a new delivery may appear again.
No automatic stale lock/socket takeover: after an unclean stop, prove both
owners stopped and preserve the exact stale artifacts before controlled recovery.

Never roll the runtime back to a41518f/335a35a against the current2.4.39 database.
Those old binaries are not the baseline for this release. No News container,
database, secrets or routes belong to this operation.
