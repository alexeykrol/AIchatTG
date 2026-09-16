# Ask protocol: conservative legacy transition candidate

Status: local candidate design accepted by root for implementation/testing.
Not accepted for production; no migration, configuration or deployment lease.

## Evidence requiring a transition boundary

Exact a41518f runtime and original core were run against synthetic databases,
followed by the new source. Independent review reproduced duplicate judgements
for old resolved and safely retryable jobs, and bypass of an old unknown
provider boundary by a late webhook from the other bot. A new-envelope-only
deduplication rule cannot preserve historical native-message ownership.

## Local candidate rule

- Add an indexed identifiers-only set of pre-protocol native chat/message
  coordinates before new-stream admission and legacy recovery can race.
- Derive identifiers from existing native ledger, dispositions, enforcement,
  records and valid legacy job snapshots; exclude already protocol-owned
  native messages. Never copy raw snapshots into this retained fence.
- A quarantined coordinate cannot create another envelope/judge job, replace
  an old verdict or acquire a fresh provider/Guard opportunity. Preserve the
  historical decision and all calling/unknown/uncertain fences.
- Only an original legacy job meeting the already established known-safe
  retry/planned-action rules may finish its original work. Multiple conflicting
  legacy jobs or ambiguous ownership must not be guessed or replayed.
- Quarantine includes edits of legacy native messages: historical edit IDs
  used per-bot update IDs, not a provable shared edit revision. Do not pretend
  these can be safely reconciled by fabricating context, owner or strict trace.
- New native messages remain normally judged and answered under the new
  protocol. Restart must not broaden quarantine to protocol-owned messages.

## Required synthetic evidence

Cover old resolved, safe_retry, calling, manual_review and expired/missing
snapshots; both orderings of late delivery versus recovery; restart idempotency;
unchanged old decisions/unknown boundaries; no new calls/actions/answers from
quarantined late deliveries; new-native behavior and bounded indexed lookups.
Retain exact original runtime AND core for historical-source comparisons.

## Product Owner release gate

The conservative candidate intentionally does not automatically process a new
late delivery or edit of a quarantined old native message. This is a limitation,
not proof that old edited messages remain actively moderated. A production
release must explicitly disclose and obtain approval for the affected legacy
cohort, handling of pending work, and recovery policy, or replace this proposal
with a separately reviewed transition that preserves the required behavior.

An uncontrolled downgrade to a41518f on a new-protocol database is also unsafe.
Safe rollback/stop/drain/quarantine remains a separate unproven release gate;
this forward-transition fence does not make the old binary understand it.
