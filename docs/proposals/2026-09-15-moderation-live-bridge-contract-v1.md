# Private Moderation bridge contract v1 — LOCAL proposal

Status: proposed; lifecycle `prepared` (documentation only). Charter:
`moderator-review-bridge-contract-v1`. Accepted source:
`1829573015de5d307868afb73e4ef3dcfc0e7fdb` (Console3.3.0, not deployed).
Production baseline reported by root: Console3.2.0/f650fe8 and
Assistant2.4.37/335a35a. No lease or transport handoff exists.

This is a concrete next LOCAL implementation proposal, not activation approval.
Contracts v1–v5 remain authoritative; the two proposed changes to durable
suppression metadata and webhook admission below require explicit acceptance.
Original worker files/manifest at9d326f4 stay unchanged. Root owns integration.

## 1. Exact-source findings

All pointers below refer to accepted1829573, not the older worker files.

- `apps/telegram-runtime/src/http-server.mjs:48`: authenticated JSON reaches
  `runtime.handleUpdate`; any resolved result receives HTTP200 at51–52.
- `apps/telegram-runtime/src/runtime.mjs:1532`: classification precedes the
  durable inbound claim. Duplicate/processing/conflicting receipts return
  at1546–1547, before Moderator processing. Caught processing failures return
  `uncertain_delivery` at1593–1605; they do not throw an HTTP failure.
- `packages/telegram-core/src/index.mjs:192`: update_id is an identity;
  `messageIdentity` at217 gives edits a string platform identity, NOT a numeric
  monotonic Review revision. Moderator classification at323–348 does not
  include reply context. It does include non-exempt bot-authored comments.
- `apps/operator-console/src/moderation-review-store.mjs:273`: ingest has its
  own transaction, native/revision deduplication and capacity backpressure.
  Evidence plus a separately committed checkpoint would have a crash gap.
  At449–468 erasure removes source evidence and retains only a minimal receipt.
  Native deduplication no longer exists after that evidence is erased.
- Store `OPEN_STORES` at12–13 is process-local. Constructor recovery at167
  marks orphaned `calling` alerts uncertain; an exclusive cross-process owner
  must be established BEFORE opening a future live store.
- `moderation-review-alerts.mjs:34` persists a calling claim before injected
  send, then a terminal outcome. `telegram-runtime/src/telegram-adapter.mjs`
  has general send/render behavior and permissive result normalization; it
  must not be treated as a strict one-attempt Review receipt validator.

Root evidence files were hash-verified: aggregate TAP
`49deaad54e1be022979a4aecaa1c7ab25049ec5bb9af24079259a0b7c572ebe4`,
final Console TAP
`4d23c2156a492dd97ae77fddcd986046c0a61cc8f716830fd4375988bf6c3d19`,
exact source guard
`5c0d8c32e98e472a06ebd1877ca003195986378376cb0bb3ba7139da0b555909`.
These substantiate the accepted feature, not this unimplemented bridge.

## 2. Process boundary and smallest next slice

Proposed topology: authenticated Moderator ingress -> pure projection ->
Console-owned private intake -> existing runtime handling. Console alone owns
Review SQLite, human decisions, intake ledger and alert state. Runtime alone
owns its existing runtime DB, webhook handling and bot credentials. Neither
process opens the other's writable database. No Review read of recovery
snapshots, event-history import, raw capture outbox or shared News resource.

Next local slice uses injected in-memory request/reply boundaries, a synthetic
private SQLite and fake transport. It creates no actual production endpoint,
Unix socket, host mapping, credential or environment switch. Future IPC must
be private/authenticated, bounded and not mounted on the browser/public server;
runtime may submit only its bound Moderator source and send only through a
fixed approved notification binding. Root must separately review concrete IPC
authentication, deployment permissions and credential ownership before wiring.

The factory requires explicit `mode:'synthetic'`; missing mode is disabled or
invalid, never inferred from an available DB/token. Real modes must be rejected
in this next slice. No auto-start, startup seed, fetch default or global sender.

## 3. Pure capture envelope and filtering BEFORE retention

Proposed interface:
`projectModerationReviewUpdate({role,update,receivedAt,policy})` returns
`{kind:'skip',code}`, `{kind:'reject',code}` or `{kind:'candidate',envelope}`.
It performs no IO. In-scope invalid input is reject, never an out-of-scope skip.
Policy must specify source binding/epoch, start boundary, exact allowed chats,
own/exempt bot IDs, allowed fields, bounds and maxSourceClockSkewSec.
Synthetic values are test inputs,
NOT approved live destinations, identities, limits or permission expansion.

Exact candidate shape (no additional keys):

```text
{
  contract: 'moderation-review-capture/v1',
  bindingId: opaque configured source UUID,
  epochId: opaque configured admission-policy UUID,
  updateId: canonical nonnegative integer string,
  kind: 'message' | 'edit',
  chatId: canonical signed integer string,
  messageId: canonical positive integer string,
  sourceDateSec: safe integer,
  editDateSec: safe integer | null,
  observedAt: first receipt ISO UTC time,
  text: string,
  userId: canonical integer string | null,
  contextStatus: 'none' | 'supplied' | 'unavailable',
  context: {messageId,text,relation:'direct_reply'} | null
}
```

Only the authenticated adapter binding, never a Telegram payload, determines
bindingId/epochId. Authenticate and verify the exact binding again at intake.
Reject unsafe integer conversions, malformed envelopes and unknown versions.
Originals require editDateSec=null; edits require a valid supplied edit date.
Dates must be nonnegative; editDateSec must be at least sourceDateSec; neither
may exceed the trusted receiver clock plus explicitly configured tolerance.
The pure projector uses trusted injected receivedAt for the same check. Invalid,
missing, reversed or future dates return reject/source_time_invalid BEFORE any
head/ledger mutation. Runtime admission maps that to sanitized HTTP400 without
runtime invocation; owner intake rechecks time independently. It is not stale
or an allowed skip, and upstream retry behavior is not presumed.
Do not manufacture source timestamps from observation time. First committed
observedAt wins on retry; transport arrival time is not a content revision.

Filtering order, before hashing/durable storage/logging:

1. Require enabled synthetic policy, Moderator role and supported message or
   edited_message shape. Assistant, callback, pin/service/automatic-forward
   events, other chats and own/exempt bot echoes are excluded. Use a separate
   pure Review projection; do not alter Guard classification or sanctions.
2. Apply the exact Review chat allowlist intersected with the Moderator's
   configured chat allowlist, and explicit forward-only start boundary using
   the supplied original/edit event date. Invalid dates follow the rejection
   rule above and cannot advance the native head. A root-owned content-free
   check of existing runtime
   receipts may identify deliveries received BEFORE activation; such events
   are not backfilled. Do not query the runtime DB from Console. Re-enabling
   after a gap needs a new approved admission boundary, not silent catch-up.
3. Keep text OR caption, with documented deterministic text-first precedence;
   no attachments, filenames, media downloads, names, usernames, profiles,
   locations, contacts, nested forwards, raw JSON, entities or error bodies.
   userId is null unless explicitly permitted. Non-exempt bot authors may be
   included in this same scope; that flag is not an abuse label or AI proof.
4. Context is at most the supplied direct reply's text/caption and message ID,
   with explicit same-chat proof (contextStatus=supplied). No reply means
   context=null/status=none. A supplied but unverifiable/incomplete reply means
   context=null/status=unavailable and incomplete evidence: no NEW claims,
   grouping or alerts. Never silently treat a discarded reply as complete.
   Never fetch parent
   history or assume that a reply is the original channel post. No recursion.
5. Validate bounded full projected input, then let the owner apply configured
   retention caps. Never clip before intake and claim the result is complete.
   Any clipping disables NEW detector claims/grouping/alerts per contractv5.
   Intake records missing/suppressed context distinctly from supplied evidence.

An explicit source-deletion signal is NOT inferred from missing text, silence,
an unavailable source, or an older revision. No supported general delete-update
path was found in the accepted source. A future authenticated deletion fact
needs its own provenance/interface charter; it must neither erase indefinite
Review evidence nor call Telegram deletion. The next harness tests rejection
of fabricated deletion envelopes, not invented live deletion coverage.

## 4. Receiver-owned checkpoint and atomic intake

Proposed owner method: `applyCaptureEnvelope(envelope, trustedBinding)`.
Only the Console owner calls its store internals. A wrapper that calls current
`store.ingest()` and then saves a checkpoint is explicitly unacceptable.

The RECEIVER assigns a monotonic `intakeSeq` on committed terminal admission.
There is no producer sequence and no Telegram update_id high-water heuristic.
Out-of-order update IDs are independently checked. A consumed-sequence number
alone is not a native replay fence. Producer retries always keep the source
update identity; they cannot choose a fresh ID to bypass the receiver ledger.

Proposed owner-private records (schema changes require root reservation):

- Binding metadata: stable bindingId, approved epochId, stable keyVersion,
  schema/policy version, owner generation and `committedSeq`.
- Event ledger: domain-separated HMAC key of `(bindingId,updateId)`, assigned
  intakeSeq, terminal outcome. Any payload digest/projection mask MUST have a
  live-native linkage, including semantic duplicates and stale events that
  create no new observation. No unlinked private digest is allowed.
- Native registry: domain-separated HMAC key of `(bindingId,chatId,messageId)`,
  current ordering metadata while evidence exists, or an erased suppression
  marker. No user ID, text/reason fingerprint or plain native ID in a marker.

Use HMAC-SHA256 over canonical, length-unambiguous typed tuples with distinct
`review-event-v1` and `review-native-v1` domains. Keys are computed by the trusted
owner, not accepted from the client. A stable
binding/key namespace survives restarts and policy epochs. Resetting epochs or
rotating keys must not bypass old fences. No auto-generated replacement key,
empty-database fallback or checkpoint reconstruction from current cases.
Key provisioning/rotation is NOT authorized; local fixtures inject a clearly
synthetic fixed key. HMAC markers remain pseudonymous retained identifiers,
not anonymous data or the existing minimal erasure receipt (see section5).

Within ONE `BEGIN IMMEDIATE` transaction, under the exclusive owner:

1. Validate binding/epoch/schema/checkpoint and request bounds. Apply existing
   native suppression BEFORE persisting raw evidence or running detection.
2. If event key was consumed, return its content-free receipt. While evidence
   survives, changed same-event allowed payload is a conflict, not an update.
   Compare using the immutable admission-time field/context projection mask,
   NOT today's context suppression state. Only genuinely new evidence revisions
   apply the current context suppression policy in step3. Thus A-with-context-B -> erase B ->
   retry A stays duplicate; it neither restores data nor spuriously conflicts.
   After erasure, do not retain/rebuild its digest: return `consumed_erased`
   without claiming that the supplied payload was revalidated or newly saved.
3. A suppressed native yields `suppressed_erased`; never persist its text,
   context or digest. For a new event ID referring to an already known native
   semantic revision, compare with that revision's immutable admission-time
   mask/digest BEFORE current context suppression. Unchanged source is a native
   duplicate even after its context's separate case was erased: record only
   the new consumed event receipt/link, never new evidence or an alert. Changed
   same-revision source still conflicts. Only a genuinely new evidence revision
   proceeds through current context policy. If its context's native key is suppressed, remove
   that context BEFORE hashing/persistence and record `context_erased` plus
   incomplete-evidence status. This known omission suppresses NEW claims,
   grouping and alerts, just like clipping; do not present it as complete input.
4. Check bounds on retained revisions, ledger entries, native markers and
   storage. No eviction, time expiry, skip-ahead, automatic quota increase or
   fake success. Capacity rejects without any source/checkpoint mutation.
5. Resolve revision order, apply source observation and any case coalescing,
   enqueue at most the existing one initial alert, commit event linkage and
   advance committedSeq in that same transaction. Includes retained ordinary
   cases whose public ingest return currently has caseId=null.

Return only `{contract,bindingId,epochId,intakeSeq,outcome}` across the boundary.
Outcomes are `stored`, `duplicate`, `stale`, `suppressed_erased`,
`consumed_erased`; no source text/native ID/case contents in the receipt.
Skipped pre-filter events do not advance the private checkpoint. A stale
revision is explicitly accounted for, but not retained, matching current
ingest semantics; do not claim preservation of every delivered historical edit.

Revision order is per native message, never arrival order or global update ID:
original < edit; increasing supplied editDateSec can advance an edit. Identical
semantic revision+allowed payload is duplicate even under a new update ID.
Lookup uses the retained source-revision metadata/mask, not today's policy;
being a new delivery ID does not by itself make evidence new.
The semantic digest excludes updateId/observedAt, includes source kind/time and
the exact allowed text/user/context fields and context status AFTER admission-time
context suppression, and never
normalizes case/whitespace/URLs to hide a source collision. It remains private
and linked to live source evidence, then is removed on case erasure.
An original arriving after an edit is stale. Equal editDateSec with differing
payload or contradictory valid original payload is a
`revision_order_conflict`: no new numeric revision, no detector, no commit.
The producer cannot label it newer. No claim is made that second-resolution
timestamps totally order edits; ambiguous cases stop this lane for explicit
resolution. Root may propose a separately reviewed quarantine format later.

Map accepted revisions to a per-native monotonic safe integer for the existing
store, atomically with the ledger. Source ordering metadata stays tied to
retained evidence and is erased with it. Same-chat coalescing must carry ALL
observation/ledger links; it cannot leave content hashes attached to retired
donor cases. A partial/damaged ledger or counter/row disagreement fails closed
as `checkpoint_corrupt`. Only explicit synthetic provisioning creates a fresh
store; live recovery requires reviewed evidence, not a reset-to-zero.

## 5. Erasure fence — explicit extension requiring acceptance

Recommended future guarantee: erasing a case also suppresses its native
messages from later capture, including retries under another update ID and
future edits. Before deleting, derive native markers for ALL member messages,
including coalesced donors. In the SAME erase transaction: insert markers,
remove linked raw revisions/context/notes/examples/alerts and payload digests,
strip ledger observation/case/live-native links and projection masks, and write
the unchanged minimal receipt. This includes ALL ledger entries linked to any
case member native, not just entries that inserted an observation: semantic
duplicates and stale-revision digests cannot survive as unowned derivatives.
No source text or content hash survives as an anti-replay shortcut.

This is a PROPOSED PRIVACY EXTENSION to v3, not already approved behavior:
pseudonymous event/native keys persist until an explicit lifecycle decision.
They are separate from the minimal content-free receipt. PO/root must accept
their purpose, duration, capacity, key management and the consequence that
future edits of that native message remain suppressed before live activation.
They grant no cross-chat profiling or sanction. Keys include chat/source scope.

Alternative if such identifiers are declined: keep only an opaque ordered
source checkpoint. It can reject already-consumed envelopes in that exact
stream, but cannot detect native redelivery rewrapped with a new identity or
future edits. That weaker design is NOT accepted as equivalent replay safety.
Resolve the privacy/behavior choice explicitly; do not silently choose it.

Erase is case-targeted, not global erasure of all quotations or runtime history.
Already visible context copies in unrelated cases survive until their own
manual erasure; list this limitation in approval/UI wording. New direct context
of a suppressed native is omitted as above. Text independently pasted without
source identity cannot safely be identified without retaining erased content;
do not promise global textual suppression. No backups/exports are created by
this slice; future copies/restore require a policy that cannot resurrect fences
or evidence. SQLite logical deletion is not physical-media erasure.

Prevent erase/send races: pending alerts cancel atomically with erasure;
`calling` blocks erase with `review_delivery_inflight` until bounded send
completion or startup recovery to uncertain. A stopped/crashed owner must not
send again. After terminal state, manual erase is available. An already sent
generic Telegram notice may remain with a now404 link; erasure never calls
Telegram. No private evidence was included in that notice.

## 6. Ingress acknowledgement and failure boundary

Proposed integration point is AFTER existing webhook authentication/body parse
and BEFORE `runtime.handleUpdate`/inbound claim. Await private admission only
for eligible candidates. On durable stored/duplicate/stale/suppressed receipt,
continue existing runtime behavior. On missing/uncertain receipt, unavailable
owner, deadline, capacity, unknown/corrupt checkpoint or revision conflict,
return a bounded sanitized HTTP503 BEFORE runtime side effects; no in-handler
retry loop. Malformed source input is a distinct validation failure, not a
transport failure or a fabricated accepted observation.

This changes enabled Moderator availability/ACK behavior: Review outage/full
storage can delay Guard moderation. It therefore needs explicit root/PO
acceptance before activation. Disabled mode must preserve existing behavior
exactly; Assistant and unsupported/out-of-scope updates do not wait on Review.
If this tradeoff is declined, a separate durably buffered design is needed;
fire-and-forget is not equivalent and raw recovery snapshots are not a queue.

Guarantee ONLY: an eligible successful webhook response under the enabled
policy has an already durable intake outcome. Do not promise Telegram retries,
unlimited upstream retention, total historical completeness, or exactly-once
external delivery. Existing runtime processing/uncertain results remain what
they were; private admission does not heal or replay Guard/Assistant effects.

Crash after private commit but before response: next arrival repeats intake
identity and receives the consumed result, then existing runtime receipt logic
controls effects. Crash before commit: neither evidence nor receipt/cursor
exists. Crash after runtime claim cannot create a missing Review observation
because admission was already committed. This is two serial ownership domains,
not a cross-database transaction or permission to reset runtime receipts.

## 7. Owner fencing and private intake failures

All ingest/erase/decision/claim/finish operations go through the sole Console
owner. Acquire an exclusive process-lifetime fence BEFORE opening SQLite or
recovering calling alerts. For the next harness, use an injected fence with
cross-process regression plus a fail-closed exclusive local lock directory;
never unlink a stale/unknown lock automatically. On restart after a crash,
controlled recovery must prove the old process cannot serve/write before
releasing that lock. No TTL/PID-only automatic takeover or dual instances.
After fence loss, stop intake/delivery; do not downgrade to another connection.
Actual production lock primitive/deployment serialization remains root-owned.

Private failures use allowlisted codes: `disabled`, `binding_invalid`,
`schema_invalid`, `source_time_invalid`, `owner_unavailable`, `owner_fenced`, `checkpoint_unknown`,
`checkpoint_corrupt`, `capacity_reached`, `revision_order_conflict`,
`event_conflict`, `deadline_exceeded`, `receipt_uncertain`. Logs/metrics expose
only code, duration and aggregate count, not input IDs/keys/text, raw exception,
URL tokens, provider bodies, recipient or database paths. Failures do not
produce fake Telegram notifications or call a paid provider.

## 8. Alert delivery contract

Keep Console claim/finish state machine and generic opaque case deep link.
Exactly one outstanding attempt per case, no automatic replay of failed or
uncertain outcomes. Further edits/repeats never schedule a second alert.
An injected adapter receives `{text,url}`; destination is bound outside the
payload. Validate configuration, allowed Console origin and message length
BEFORE claim. No parse mode, inline decision buttons, raw text/context/native
IDs, recipient override, multipart send, URL preview, footer or fallback send.

Future real transport should remain in the credential-owning runtime under a
separate private send-only binding; no bot token moves into Console. Its private
command includes an opaque attemptId and fixed destination binding, not an
arbitrary chatId. Repeated attempt IDs must not issue another external call;
durable calling/terminal fencing is needed at that boundary too. Its minimal
content-free attempt ledger and deletion/retention policy need root review;
do not reuse runtime Guard/Assistant receipts or persist rendered link/text.
The next slice tests this with a fake one-call adapter only.

The accepted sender currently receives only `{text,url}`, so it cannot enforce
the proposed remote attempt fence by itself. Root must reserve a compatible
internal call extension `send({text,url}, {attemptId})` from the already durable
claim (not a new random ID in the transport). This metadata is never appended
to the Telegram text/URL. Existing one-argument fake senders remain valid.

Transport classification is conservative:

- `sent` only after a full, explicitly successful, valid receipt for the single
  requested send and bound destination. Persist only opaque internal UUID.
- `failed` only for verified non-delivery, including rejection BEFORE invocation
  or a validated explicit unsuccessful response; preserve no raw description.
- `uncertain` for timeout/abort, disconnect, partial/truncated response,
  malformed success, destination mismatch or exception after invocation.
  HTTP200, headers alone or `ok:true,partial:true` are not success proof.
- Persistence failure after external result stops the sender; the durable
  calling fence becomes uncertain on controlled recovery. Never send again to
  compensate for a missing terminal receipt. Success is not exactly-once proof.

No new Telegram API method/option is claimed validated here. A later real
adapter requires current official protocol review, fake-response tests, exact
recipient approval and a bounded send lease before any actual call.

## 9. Proposed source reservations (NOT authority to edit yet)

| Proposed new module/test pair | Sole intended implementation owner |
| --- | --- |
| `apps/telegram-runtime/src/moderation-review-capture.mjs` + matching test | chartered bridge worker, pure projection only |
| `apps/telegram-runtime/src/moderation-review-admission.mjs` + matching test | chartered bridge worker, bounded injected client only |
| `apps/operator-console/src/moderation-review-intake.mjs` + matching test | chartered bridge worker, injected owner facade |
| `apps/operator-console/src/moderation-review-owner-fence.mjs` + matching test | chartered bridge worker, local synthetic ownership |
| `apps/operator-console/src/moderation-review-send-contract.mjs` + matching test | chartered bridge worker, fake one-call normalization |
| `apps/operator-console/test/moderation-review-bridge-flow.test.mjs` | chartered bridge worker, synthetic end-to-end |

Root exclusively reserves any changes to existing Review store transactions,
schema/erase/alert internals (including the attemptId invocation extension),
HTTP error/UI disclosure, runtime http-server and
server entrypoints, runtime receipt eligibility helper, manifests, releases,
Compose, config and identity/IPC policy. No adapter opens a second SQLite
connection or imports a mutable shared runtime store. No public intake/send API.
Root chooses a fresh isolated implementation base before any source edit.

## 10. Decisions and next safe action

Settled: raw comments/context kept indefinitely until manual removal;
human verdict in Admin; only generic Telegram notice; no autonomous sanctions,
paid inference, pattern activation, fine-tuning or cross-chat profiling.

Before LIVE, decisions required (not blockers to this local contract):

1. Approve exact monitored chats/start boundary, allowed fields/context/user ID,
   evidence/ledger/space bounds and explicit failure behavior. Values are not
   inferred from the existing runtime's broader chat/config permissions.
2. Approve durable pseudonymous suppression metadata and future-edit behavior,
   or choose a different deletion/replay design; define backup/copy/restore
   handling. No claim of free storage or quota expansion.
3. Approve capture-before-runtime ACK/availability change and concrete private
   process authentication/ownership deployment. Disabled defaults stay intact.
4. Confirm actual authorized reviewer identity and private Telegram recipient,
   approved alert text/origin, exact integrated release, rollback and bounded
   activation/send authority. Synthetic `operator` is not a personal identity.

Next root action: review these two explicit architecture/privacy deltas and
the acceptance matrix, then issue a LOCAL synthetic implementation charter
with exact file reservations and clean accepted base. Do not deploy disabled
3.3.0 as a substitute for implementing/approving the live bridge.

Evidence: source/manifest/report verification `passed`; bridge behavior tests
`not_run` (specified, not implemented); live/deploy/network/spending `not_run`.
See sibling `2026-09-15-moderation-live-bridge-acceptance-plan-v1.md`.
