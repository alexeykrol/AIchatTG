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

## Root scope finding after the timer checkpoint

Root found new Assistant-self routing changes in the evolving worker diff:
generic «ИИ-ассистент» plus architecture/training/upload/custom-task wording
was being classified as internal details. This is outside the ask-protocol
reservation and risks suppressing legitimate course questions. Root rejected
that addition and its new self-routing assertion pending separate explicit
owner scope; baseline public/course routing must remain intact. New timer
Help/hint sentences are visible-copy candidates, not automatically approved
wording, and must not imply that a late question will be rejected.

## Pure submission-contract review and repair checkpoint

Independent strict-trace synthetic reproductions found three additional
defects: a stale opaque claim could mutate a newer generation through the
conflict path; equivalent semantic objects with different JSON key order could
conflict; arbitrary usage metadata could persist private text in decision JSON.
Root forwarded all three before acceptance. Original reproduced hashes:

- judgement-envelope.mjs: `e4dedde62101d514c53e0c88e377cfd5b743ef0f2cfecec30efbd0168d69678a`
- judgement-store.mjs: `c3612bda38fdcdead38334828c00d2d581a05de4d3901604583fab369928f1ab`
- safety-v3.mjs: `57f1709fc508bbf1445ce4732645a786c03f32d61f4ba18fc5875ce34e04a5c2`

After repair, independent reproductions and contract/Guard suites passed81/81:

- Stale generations cannot affect current jobs/dispositions/actions before or
  after generation2 accepts; identical/different/invalid old results are fenced.
- Top-level and recursively reordered keys replay the original receipt.
- Arbitrary/nested private usage fields are omitted from durable records;
  only the bounded accounting projection remains.

Stable hashes before/after this follow-up review:

- judgement-envelope.mjs: `b1c17f4a73bb9dfe2902b6884bb6c6d16006ffe2c360c46708b26d991603955d`
- judgement-store.mjs: `564794b0edc14a2bb973fa6823e4ad1f5b8ba1e5786541a5bc98a46b547b0d75`
- safety-v3.mjs: `10990981efe1d72882fa9ee0c82915d223061b50a04a2853cab9591860b23f5b`

This is `passed` for those findings on that snapshot, not full candidate
acceptance. Runtime, timer and local runner integration were still changing.

## Rollback limitation reported by implementation

The worker reports a synthetic exact-a41518f rollback counterexample: new
source accepts an Assistant-owned question, old code opens the additive DB,
then a late Moderator webhook makes a second semantic call for that native
message. Its local regression reproduces the defect1/1; root independently
reran it with Node20.20.0 and reproduced1/1. Schema readability is not safe rollback. A controlled
stop/drain/quarantine mitigation remains `not_run` and a release blocker.

## Repaired timer follow-up

Independent follow-up:68/68 repository tests and4/4 extra synthetic probes
passed. Delayed-ACK reply/answer reconciliation and indexed native edit proof
close both initial findings. Additional held-delete races covered expiry-first
and answer-first; a held judgement cancelled idle while another user's pair
expired after runtime/store recreation; late reply after uncertain expiry
answered without retrying deletion. The four probes were not yet checked in.
Real process-signal shutdown was inspected, not exercised.

Stable follow-up source hashes:

- database.mjs: `66fa9b210b3f7c2fb084acd96e74244c3a560b6ced3b43582ab035dcde5e4fce`
- runtime.mjs: `7df8ddb2533543fad5434a592f02a64901cd36d02035a00a09281f3b51711d3d`
- assistant-ask-expiry.mjs: `d1a7277fd8de4bb601e3311fb88c8497f3b41ccd7a54490104de4d8575dda16c`

Runtime/database subsequently change for v4 answer claims and v5 transition;
the passing checkpoint does not accept those later changes.

## Forward-upgrade counterexamples

Independent exact-a41518f runtime+core to scratch-frozen new-source checks
found a release-blocking legacy ownership gap:

| Legacy state and ordering | Observed defect |
| --- | --- |
| Resolved clean, then late Assistant webhook on new code | Second judge/job/record; prior allow replaced by block and fake ban/delete |
| safe_retry, new legacy recovery first, then late Assistant | Second judge; same overwrite and fake sanctions |
| Unknown/manual_review, then late Assistant | Fresh judge bypasses unknown boundary, replaces error by allow/fake answer |
| safe_retry, new Assistant acceptance first, then legacy recovery | Passed: stale legacy work fenced; new allow preserved |

Four assertions passed as reproductions; three demonstrate compatibility
failure, not acceptance. Node20.20.0 with socket/fetch-denying guard, synthetic
databases and fake actions only. Root did not claim a second independent rerun.
Source hashes: runtime `7df8ddb2533543fad5434a592f02a64901cd36d02035a00a09281f3b51711d3d`,
judgement-store `564794b0edc14a2bb973fa6823e4ad1f5b8ba1e5786541a5bc98a46b547b0d75`.
The source was a scratch-frozen uncommitted candidate on b1c19c5.
Local reproduction/result: `/tmp/aichattg-forward-assurance.Bwfaxp/`.

The [v5 transition proposal](../proposals/2026-09-16-ask-protocol-legacy-transition-v5.md)
is authorized only as local candidate work. It deliberately quarantines old
native edits/late deliveries; this limitation and safe rollback remain explicit
release decisions. No live schema change or migration is authorized.
