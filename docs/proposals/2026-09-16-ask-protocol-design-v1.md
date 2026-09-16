# Ask protocol v1 — local design

## Decision

An Assistant-addressed message has exactly one semantic judge: Assistant.  An
ordinary message has exactly one semantic judge: Moderator.  The rule is
computed from the code-owned native message identity before either provider
boundary; webhook arrival order never selects a different judge.

The protocol stores an envelope keyed by `chat_id`, `message_id`, and native
revision identity.  It contains hashes of the source, context and policy, the
computed owner, a schedule claim, and per-bot delivery receipts.  It does not
store Telegram update IDs as a cross-bot identity and does not duplicate raw
update payloads.  A differing observation for the same native coordinate is a
conflict/manual-review fence, never a new judgement.

Assistant submits only an opaque envelope claim plus the strictly validated
semantic verdict.  Targets, evidence spans, policy plan, weak-strike
reservation and disposition are derived server-side from the envelope.  The
same submission fingerprint is idempotent; a different one fails closed.
Moderator/Guard consumes only the stored plan after its existing final
revision/rights proof.

The strict submission boundary requires the actual safety trace, literal raw
evidence and trace-consistent confidence; trace-free mocks are not a production
compatibility mode. Canonical semantic hashing ignores JSON property order.
Revoked lease generations are rejected before conflict mutation. Durable
receipts whitelist numeric usage and bounded semantic metadata, not source
snapshots, model quotes or arbitrary provider fields. Policy hashes bind live/
shadow mode, configured chat scopes and exemptions; recovery and final actions
recheck them. Ignored edits create a head tombstone without scheduling a model.

## Invalid judgement

An invalid or unknown Assistant judgement creates one terminal, non-retryable
disposition.  It never answers the question or sanctions its sender.  The
runtime delivers one code-owned operational fallback through normal footer and
delivery fences:

> Сейчас не удалось обработать вопрос. Попробуйте, пожалуйста, позже.

This is intentionally separate from the existing unavailable-materials copy:
the latter says that course materials are under review, which is not true for a
router-contract rejection.  It also does not imply that a benign question is
unsafe. This visible-copy addition requires root/PO review before release.

## Answer delivery and edits

One native question still owns at most one visible answer sequence. A newer
observed revision with its own allow may replace only wholly-unsent preparation.
Native `preparing -> calling -> confirmed/uncertain` delivery state is durable.
Calling, confirmed, partial or unknown delivery cannot be replaced by an edit.
An opaque generation claim fences old completions; legacy unresolved native
claims remain blocked. The normal cooldown and daily quota are unchanged.

The first-send reservation is atomic; the Telegram adapter checks ownership
before each part and markup fallback. Superseded answer-model calls are neither
replayed nor refunded. Identifiers-only attempt records retain their normalized
usage under the original event, without claiming an undelivered answer was sent.

## Bare `/ask` expiry

Successful `forceReply` delivery creates one durable service-pair job for the
literal bare command and its Assistant hint.  Its idle deadline is successful
hint delivery plus 30 seconds.  No existing historical receipt is backfilled:
it has no truthful deadline.

States are `pending`, `question_received`, `calling`, `finished`, `skipped`,
and `uncertain`.  An authenticated nonempty reply atomically changes `pending`
to `question_received` before any routing/provider work.  This cancels idle
expiry; normal successful-answer cleanup owns the pair.  If expiry wins first,
it may attempt each delete once through the existing Assistant/Guard split.  A
late reply remains an Assistant question and is answered even though the
service pair may already be gone.

The candidate hint adds the explicitly requested sentence: `У вас 30 секунд,
чтобы послать вопрос.` This is an idle-cleanup notice, not a late-reply rejection.
Question/confirmed-answer observations reconcile even when the hint's Telegram
acknowledgement is delayed. Cleanup has one opaque persisted claim, a 47-hour
authority bound, indexed monotonic command-edit evidence and independent
one-second polling. Prompt deletion uses the author token; command deletion
uses existing Guard rights and a last-moment edit proof.

The explicit Product Owner rule is: `если вопрос не пришел в течении 30
секунд, то надо удалять и вызов бота и его промпт`; and, if a reply is received
after that, `тогда надо ответить`.  Thus 30 seconds is not a deadline for a
received question or its answer.

## Restart and rollback

An expiry worker drains bounded overdue jobs at startup and then polls.  It
never retries a job in `calling` or `uncertain`.  Cleanup authority remains
separate from reply detection, so deleting a hint cannot disable a late reply.

The new owner/envelope protocol is additive but is not automatically safe to
roll back to the old a415 binary: that binary cannot read its owner fences and
could let a later Moderator delivery create the old judgement path.  Rollback
therefore requires a controlled stop, drain/quarantine of open protocol jobs,
and a root-owned compatibility decision; no blind database restore or automatic
binary rollback is permitted.

Exact-old synthetic testing confirms that uncontrolled rollback rejudges an
already accepted Assistant-owned native message. This is a release blocker,
not a tested rollback plan.

Forward upgrade uses conservative legacy-native quarantine. Startup extracts
only native identifiers from historical ledgers/dispositions/receipts/jobs;
job snapshots are read in keyset batches of at most 500 and not copied. Late
legacy native deliveries and edits cannot create new envelopes or judges.
Single historical safe-retry/planned work retains baseline recovery fences;
multiple historical jobs for one native message cannot recover by guessing an
owner. Hot admission and recovery lookup use indexed identifiers. New native
messages are unaffected, and repeated initialization is idempotent.

Blocking old-message edits is an explicit conservative release limitation
requiring root/PO acceptance, not a new general edit policy. No automatic
allow/strict-trace adoption is inferred from pre-protocol records.
