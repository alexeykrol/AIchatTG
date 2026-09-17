# Moderation Review bridge — selected implementation contract v3

Status: local implementation with regression evidence, not a deployed or activated feature.
Base: feb0f0585deff8be9efc4512729170b5b1397f64. Root is the sole integrator.
The v1 proposal and v2 addendum remain historical and are not rewritten.

## Product decisions and authority

The owner explicitly selected primary moderation availability with visible
Review gaps, and removal of linked identifiers without a post-erasure replay
guarantee. Existing indefinite retention until manual erasure remains selected.
Covert book/testimonial promotion is review-only; this grants no new sanctions,
model calls, automatic pattern activation or training.

Advance deployment intent is recorded. The PO-supplied private recipient was
verified read-only; its numeric identity stays in private ignored evidence.
Live activation still needs the authenticated reviewer, exact chats/start/bounds, source,
configuration and release lease. No production or external action is authorized
by this local implementation contract. Missing configuration stays disabled.

## Selected technical topology

- Console alone owns the private Review database, intake/event receipts,
  decisions, erasure receipts and alert invocation fences. Runtime owns its
  existing bot credential. No second persistent sender ledger is introduced.
- Use bounded HTTP over two Unix sockets in an explicitly provisioned private
  project-only directory. No public capture/send route, shared secret discovery,
  cross-project mount, raw outbox or delivery retries. An existing socket is
  never automatically taken over. Both processes verify directory permissions.
- A cross-process exclusive Console owner fence precedes database opening and
  recovery. A stale fence requires controlled recovery, never PID/TTL takeover.
- The runtime webhook starts primary handling without awaiting Review. One
  request-scoped projection/capture may run concurrently and is cancelled when
  primary handling completes. No owned raw envelope survives that boundary for
  retries. Review errors cannot change primary status/result/sanctions.
- Runtime keeps bounded, content-free volatile coverage counters separately
  from the private store. Show unknown before this boot and for unavailable
  telemetry. Counts describe attempts, not unique messages or completeness.

## Capture contract

`projectModerationReviewUpdate({role,update,receivedAt,policy})` returns
`{kind:'skip'|'reject',code}` or `{kind:'candidate',envelope}`. Policy includes
enabled, bindingId, epochId, exact chatIds/startAt, allowUserId, exemptBotIds,
maxTextChars and maxContextChars. Primary config must constrain its chat set.

Envelope exact fields: contract='moderation-review-capture/v1', bindingId,
epochId, updateId, kind='message'|'edit', chatId, messageId, sourceDateSec,
editDateSec (null for originals), observedAt, text, userId (nullable),
contextStatus='none'|'supplied'|'unavailable', sourceDigest, context (null or exact
messageId/text/relation='direct_reply'), truncated={text,context}.
IDs are canonical safe integer strings, dates are explicit UTC/source integers.
Reject invalid/future clocks; originals/edits are forward-only from startAt.
Only Moderator text/caption posts in the exact chat set are eligible. Skip
service/pin/top-level automatic forwards and exempt bots; ordinary replies to
automatic forwards remain eligible. Keep only directly supplied same-chat
reply context, no recursive/fetched/profile/media data. Missing or clipped
context/source is visibly incomplete and cannot introduce claims/group/alerts.
sourceDigest is SHA-256 of the canonical pre-clipping semantic source fields
(kind, chatId, messageId, sourceDateSec, editDateSec, text, userId,
contextStatus, context), in that order, using JSON.stringify. It excludes
updateId and observedAt. The private producer supplies this collision fence;
Console can recompute it for complete envelopes. It is never detection proof
and is erased with all linked event/native metadata.

Console validates independently and atomically commits event receipt, native
revision, evidence/case/initial alert and intake counter. Event/native conflict
rejects without partial writes; update IDs are not a global chronology. Receipt
contains contract, bindingId, epochId, intakeSeq and outcome only. Events link to
their native's case and follow coalescing. All linked identifiers/digests are
deleted with a case, including duplicate/stale event receipts. A genuine later
delivery can be admitted again after erasure; no suppression promise.

## Notification and erase race

An initial alert is claimed durably once. Runtime must obtain one final
Console-serialized dispatch authorization for that exact case/attempt before
one external call. This is the chosen authorization cutoff. Duplicate requests
cannot acquire a second authorization, including after either process restarts.
Authorization state remains in Console, not a remote persistence store.

Erase before authorization prevents dispatch. Erase afterwards never waits for
network and may be followed by an already authorized generic notice whose case
URL returns404. Notices contain only fixed copy and an opaque case URL; no source
text/native IDs. No automatic resend, fallback, recall or Telegram deletion.
Late erased-case completion is a terminal no-op based only on the existing
minimal erasure receipt. Missing-but-not-erased state is an integrity error.
On restart, calling remains uncertain and is not requeued.

A persistent content-free hourly counter bounds dispatch authorizations across
process restarts and case erasure. It has no source/case/recipient identifiers.
The explicit binding sets maxAlertsPerHour; no resetting it by case deletion.
An uncertain call halts the current sender run. Manual recovery needs inspection,
not automatic resend. Missing or damaged private storage never creates a new
apparently empty store: explicit fresh-store provisioning is a separate step.

## Reservations and acceptance

- Moderator task: detector and its tests only, separate existing charter/tree.
- Projection subagent: new packages/telegram-core/src/moderation-review-projection.mjs
  and its new test file only. Root owns exports/manifests/consumers.
- Transport subagent: new packages/telegram-core/src/moderation-review-ipc.mjs,
  apps/telegram-runtime/src/moderation-review-sender.mjs and their new tests only.
- Root: store atomicity/owner lifecycle, capture controller, bootstraps/config,
  private routing, UI, integration, tests and release documentation.

Workers use fresh synthetic fixtures and fake external transports. No commits,
remote access, private production data, spending or changes outside reservations.
Return changed paths, API, tests, residuals and next owner. Stop on contract or
ownership conflicts. Root independently reviews before integration.
Required evidence: projection boundaries, atomic commit/rollback, revision
ordering, erasure of all linked metadata, dispatch/erase races, owner contention,
bounded cancellation and unchanged primary handling; full relevant regression
suites, source guard and visible UI checks. Report passed/failed/not_run/
inconclusive honestly. Synthetic success is not live delivery evidence.
