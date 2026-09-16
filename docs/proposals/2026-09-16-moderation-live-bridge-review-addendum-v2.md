# Moderation bridge review addendum v2 — options only

Status: proposed; documentation only. No architecture/privacy choice, source
reservation, implementation, release or production authority is granted here.
Responds to root `docs/reports/2026-09-15-moderation-bridge-review.md` under the
updated `moderator-review-bridge-contract-v1` charter. Accepted disabled feature
source remains1829573015de5d307868afb73e4ef3dcfc0e7fdb, not this proposal.

Original documents are immutable: bridge contract SHA-256
`cd4859801a8be05a7a5e85cdab0acd42babe325f9bc714ae52a9135ffbd4aa5f`;
acceptance plan
`8a7184c9eefe91efbe40a69773e1ecf675aa1ee2733bd99c6aec79bf66b143d3`.
This addendum withdraws the statements identified below. Other unaccepted v1
proposals remain proposals; corrections do not retroactively approve them.

## 1. Withdraw the receiver-counter replay fallback

V1 section5's alternative that an opaque ordered checkpoint can reject consumed
envelopes is NOT valid for v1 section4's actual protocol. Its intakeSeq is
assigned by the receiver and absent from the producer request. Example:

1. Receiver commits event U as intakeSeq41; response is lost.
2. Owner erases U's case. Assume event/native identifiers are NOT retained.
3. Producer retries U without knowing41. A stored counter41 cannot identify
   that request or distinguish it from different out-of-order source input.

Therefore neither a receiver counter, its maximum value, nor a Telegram
update_id watermark provides the withdrawn guarantee. No ordered-producer
protocol, producer journal, source-ID retention shortcut or raw outbox is added
by this addendum. Such a protocol would be a separate architecture/privacy
proposal requiring stable request identity and crash/replay proof.

Pending PO options, without choosing:

- Accept the proposed persistent event/native markers and future-edit
  suppression: review their exact lifetime/access/capacity/key/copy policy,
  then test the event ledger and marker implementation. Markers are retained
  pseudonymous identifiers, not anonymous/minimal erasure receipts.
- Decline those markers: preserve acceptedv3 deletion semantics, but withdraw
  post-erasure source replay protection for this bridge design. Keep live
  intake disabled until root presents a different accepted protocol or an
  explicitly accepted weaker product guarantee. Do not claim an equivalent
  privacy-free checkpoint solution or import identity from runtime secretly.

This correction is independent of the Guard-availability choice below.

## 2. Conditional availability options — no choice made

### G: preserve primary moderation, with visible Review coverage gaps

If the PO confirms root's recommended Guard priority, replace v1 section6's
pre-runtime admission dependency and its eligible-HTTP200 capture guarantee:

- Existing webhook authentication, parsing, runtime claim, Guard processing,
  runtime return/error and HTTP response behavior remain authoritative.
  No Review validation/storage/IPC result creates a new400/503 or prevents,
  delays by awaiting Review, retries or replays the primary runtime call.
- Review projection/one-shot capture is optional and isolated. Primary runtime
  starts without awaiting it and its response never waits for Review. Pure
  projection rejection, revision conflict, missing identity/key, capacity,
  unavailable owner and uncertain receipt affect only Review coverage.
- Only an immediately available bounded capture attempt may use the existing
  request-scoped projection. No new raw-data queue, retry backlog, outbox,
  post-response application-owned envelope or recovery-snapshot import is permitted.
  If this lifetime cannot be met, skip Review for that request. An actual IPC
  implementation must prove bounded transport copies/cancellation and failure
  isolation in its own charter; no transport is implemented here.
- On primary response completion, cancel any still-owned capture attempt;
  do not await it or retain raw evidence to retry it later. Cancellation is
  NOT proof that the private owner did not commit. A late commitment/receipt
  must not cause a resend, second capture or altered webhook response.
  Dropping owned references is not a promise of immediate memory erasure or
  recall of bytes already in transport; bound and review those lifetimes, too.
- Review failure never authorizes fire-and-forget unbounded work, extra provider
  calls, primary fail-open security changes or changes to existing sanctions.
  Disabled/out-of-scope behavior remains unchanged.

Coverage must be honest: `acknowledged` means a verified durable private receipt;
`not_attempted` means no request was issued; `rejected` means verified no commit;
`uncertain` means outcome unknown (including lost response/cancellation);
`unknown` means observation/telemetry itself is incomplete. Record/display
sanitized aggregate attempt counts, reason codes and time intervals only—no
raw text, native IDs, HMACs, recipient or provider error body. Counts describe
observed attempts, NOT unique messages or a percentage of all chat content.

Coverage evidence must not depend on a healthy Review store. Root must reserve
a bounded content-free operational status mechanism and its failure behavior
before implementation. If it cannot durably record a gap or loses volatile
counters on restart, show coverage unknown since the last trustworthy boundary;
never infer zero missed events from zero records. No new telemetry storage is
created now. Lost/uncertain intake is not automatically backfilled. A later
genuine source delivery may be assessed under the approved policy; no promise
is made that it will arrive or that missed evidence can be reconstructed.

Crashes can now leave runtime processing/completion without a Review receipt.
That is an acknowledged coverage limitation, not a failed webhook guarantee.
The atomic private-store transaction still applies to attempts that DO commit.

### R: require durable Review admission before primary handling

Only if the PO instead accepts the availability change, v1's bounded pre-runtime
admission option may proceed to separate review. Review outage/capacity/conflict
can delay Guard. No completeness beyond actually received, eligible, durably
admitted events or upstream retry guarantee follows. G and R are mutually
exclusive policies, not a runtime fallback selected silently on failure.

## 3. Reserve deletion capacity at admission; do not charge erase twice

Conditional on acceptance of persistent markers, replace v1 E09 and the
section5 marker-capacity refusal. Proposed invariant:

`usedNativeSlots = erasedNativeMarkers + reservedLiveNativeSlots <= nativeCap`.

A native's first accepted observation reserves its eventual fixed-size erased
representation in the SAME transaction. Subsequent revisions/duplicates share
that reservation. Erase converts its already allocated row to a marker; it
does not request another policy slot. All coalesced members keep reservations.
Reserve a minimal erasure-receipt slot at case creation too, and account for
every retained event's later content-free representation. Coalescing must not
double-charge, lose a native reservation or leave private ledger derivatives.
Every later admission/attempt increasing that eventual footprint must reserve
its delta in the same transaction; this is not only a first-message check.

Admission, not deletion, rejects new work if reservations cannot be made. At a
full logical marker quota, valid owner erasure of existing reserved cases must
still succeed without quota expansion. Erase atomically converts reservations,
strips all source/digest/mask/live linkage, deletes linked case material and
writes the existing minimal receipt. Its authentication, exact version and
request-replay fences remain unchanged. No new marker-full policy409.

Logical reservations do NOT guarantee writes to a full/broken filesystem.
Root must separately budget/test bounded deletion transaction/journal headroom
and reserve bookkeeping capacity; no guessed byte value or spending is approved.
Actual IO/disk/corruption/ownership failure remains an honestly failed atomic
operation, never a successful erasure claim. Such failures stop new intake and
need bounded recovery; they are not a retention policy allowing indefinite
refusal. Existing unreserved data cannot enter this mode silently: activation
needs a validated reservation plan; keep live capture off if it does not fit.
Acceptedv3 erasure is not retroactively disabled by the proposed migration.
After an ambiguous erase response, resolve the existing exact request receipt
on recovery before reporting success or reissuing a different deletion request.

## 4. Erase without waiting for generic notification completion

Withdraw v1 section5's `review_delivery_inflight` refusal and D08's calling
block. A valid erase does not wait for network/IPC completion and does not fail
merely because an alert is calling. Proposed single-owner race semantics:

- Erase before dispatch authorization deletes pending delivery with the case.
  Root must specify one cutoff: (a) the durable calling claim itself authorizes
  one dispatch, or (b) a final owner-serialized authorization after the claim
  can cancel a case erased before that gate. No network await occurs while
  holding the arbitration lock or database transaction. Neither option is
  selected here. A presence check followed by a later cross-process call is
  NOT an atomic guarantee that deletion cannot occur between them.
- Once dispatch authorization has crossed the selected cutoff, allow erase
  immediately even if external invocation has not yet begun. Abort
  the bounded request best-effort, without waiting or claiming non-delivery.
  An already initiated generic notice may arrive during or after erase and its
  case link returns404. No source text/context/user ID is in that notice.
  No Telegram recall/delete operation is implied.
- Erase removes the case's alert/attempt linkage in the same transaction as
  evidence. Late completion for an erased case is a terminal no-op: discard
  receipt/body, do not insert/update an alert, recreate a case or retry a send.
  The existing minimal case erasure receipt may identify this finalizer branch;
  no attempt ID/provider receipt is added to it. Missing-but-not-known-erased
  state remains an explicit integrity fault, never an invitation to recreate.
- The current1829573 finishAlert throws404 after erasure. Root must explicitly
  reserve the no-op finalization change in a later charter; it does not exist
  today. Non-erased cases retain exact attempt and terminal-state fencing.
- After crash/restart: a committed erase has no case/alert to claim; it cannot
  cause resend. If erase rolled back, existing calling recovery remains
  uncertain, never auto-retry. A remote sender's own invocation fence cannot be
  reopened by erasure. Any separate persistent remote attempt ledger remains
  an unaccepted metadata/privacy design, not silently exempt from deletion.

Race caveat must be disclosed in future UI/approval: local deletion is not
revocation of an already initiated generic notification. No indefinite sender
deadline, waiting for provider response, or extra policy gate on manual erase.

## 5. Changed acceptance IDs only (v1 files remain unchanged)

All entries are specifications, `not_run`. G/R and marker choice must be fixed
in a later charter before the corresponding implementation tests are claimed.

| ID | Replacement/additional requirement |
| --- | --- |
| I08 / A02 | Keep marker-backed replay proof, but explicitly fail any counter-only substitute after commit/lost-response/erase/retry without producer sequence. No private receipt known to the sender may be assumed. |
| C08 / C09 / I05 | Under G, Review validation/time/order failure affects only capture; no new webhook400/503 or skipped primary call. Under R, only the separately accepted admission policy determines those statuses. |
| I09 | Under G, crash after runtime claim may lack private admission; record coverage gap/unknown, not a promised Review receipt. Under R, verify pre-admission invariant. |
| I12 / A01 | Full/unavailable/corrupt Review rejects capture, never evicts. G: primary processing/response unchanged, visible gap/unknown. R: approved backpressure before effects. |
| A03 / A04 | Neither successful primary response nor processing/uncertain result proves capture under G; disabled/out-of-scope parity remains. |
| E03 / E04 / E10 | Retain anti-replay/future-edit expectations ONLY for accepted marker-backed design; no claim that identifier-free receiver counters satisfy them. |
| E06 | Crash around reservation conversion/evidence deletion: all-or-nothing marker/receipt/evidence state. No partial deletion or reservation leak. |
| E09 | Fill policy quota after valid native/case reservations; existing exact-version erase succeeds without increasing quota. Further new intake rejects. Separate actual IO-failure injection rolls back and reports failure honestly. |
| E05 / E14 | Coalesced/duplicate/stale source entries preserve one reservation per native; erasure clears ALL linked digests/masks while converting reserved rows, without charging a new slot. |
| D08 | Test pending/claimed/authorized/invoked/terminal phases using an explicit chosen cutoff. Erase never awaits send; before authorization cancels, after may deliver a bounded generic notice with case404, no raw content or calling-state409. |
| D05 / D07 | Crash or terminal persistence failure followed by erase/restart never replays send. Late erased-case finalization is no-op, no upsert or receipt resurrection; unrelated missing state remains a fault. |
| A05 (new) | G: slow/never-resolving fake intake cannot delay runtime/response; at completion cancel/drop request-scoped work, no backlog/retry. Unknown outcome is NOT counted as definite loss or successful capture. |
| A06 (new) | G: Review down AND coverage sink down/restart; expose coverage unknown, not empty/complete. No IDs/raw text in operational evidence and no automatic gap backfill. |
| E15 (new) | Startup/migration with insufficient native/case/transaction reserve cannot activate capture; does not replace existingv3 erase with a new policy refusal. |

## 6. Return boundary

Root retains the two PO choices and their wording. This addendum neither
selects G/R nor accepts persistent suppression. Next safe action: review these
corrections, obtain the choices, then issue a bounded local implementation
charter if the resulting design is consistent. No source reservation follows
from this document alone.

Evidence: exact1829573 erase/finalize read-only check and original v1 hashes
`passed`; new behavior/tests/network/production/spending `not_run`. Frozen
source and the two original proposals are unchanged.
