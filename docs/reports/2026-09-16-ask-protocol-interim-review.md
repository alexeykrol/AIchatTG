# Ask protocol — interim independent timer review

Status: candidate not accepted; implementation in progress. This is a dated
partial-source checkpoint, not the final candidate or a production receipt.
Root main at this review:88a4691; worker base:b1c19c5 with uncommitted edits.
Worker owns implementation; root/assurance reviewer made no source edits.

## Confirmed findings

1. **Reply before hint transport acknowledgement loses idle cancellation.**
   A synthetic test held the receipt of an already visible hint, delivered a
   same-user nonempty reply, held answer delivery, then released the hint
   acknowledgement. The newly created timer job remained pending;30seconds
   later both service messages were deleted while answer delivery was pending.
   The unmatched early reply was discarded before a job existed. Persist and
   reconcile that authenticated reply instead. Reproduction: `passed`.
2. **Edit proof scans all inbound receipts synchronously.** The new
   `revision_identity LIKE ? LIMIT 1` query reported
   `SCAN runtime_inbound_update_receipts` under SQLite EXPLAIN QUERY PLAN.
   LIMIT1 does not bound the unedited/no-match case. Use indexed durable native
   edit evidence, not a full scan or an unsafe bounded-window absence inference.

Root forwarded both before final acceptance. Required extra coverage includes
question cancellation with suspended judgement/answer and restart; real
expiry-versus-answer races in both orders; expiry-worker startup/overlap/stop
and slow-judge isolation; skipped edited overdue job followed by valid jobs;
late replies after restart and uncertain cleanup.

## Evidence boundary

Independent Node20 targeted run:38passed/1failed,39total. The failure was an
Assistant-self route assertion added concurrently, not a confirmed timer bug.
The worker later reported39/39 after its correction; this report does not
pretend those were the same frozen test snapshot. Full suite, final candidate,
cross-role arbiter and actual rollback compatibility remain not_run here.
No provider, Telegram, SSH, production or private-data access occurred.

Revalidated inspected source SHA-256:

- database.mjs: `bb3c1683666aa78cc61b6ed6deba3498c5f04ea5846631afce19cfce6d2958de`
- runtime.mjs: `aaf043bfe295ac146695c73c877ac4391209965cdf5193b4cd34fe6bbe54e9b9`
- assistant-ask-expiry.mjs: `d1a7277fd8de4bb601e3311fb88c8497f3b41ccd7a54490104de4d8575dda16c`
- server.mjs: `384f726a83ad3b6e2d28558ef0152b56f7375dc49e9f27a4e27c24fcb7b59768`

All subsequent repairs need a new frozen-diff review. The production release
remainsa41518f/Assistant2.4.38; its lease was closed before this local work.
