# AIchatTG release queue

Checkpoint: 2026-09-16 04:34:43UTC, after verified porn-spam deployment. The root integrator owns shared integration
and this queue. No active production lease or SSH master remains.

## Completed

Console3.2.0, exact source `f650fe87cabf5cf498a64d48907f7a924861cfd2`, lifecycle
`production-verified`. One Console-only recreation; lease consumed/master closed.
[Deployment receipt](reports/2026-09-15-console-v32-deployment.md).

### Semantic suspected porn-spam policy — completed

- Exact runtime source `a41518f4a4fd105cf19e7fc1a64fd35b77233084`, lifecycle
  `production-verified`; source pushed, one runtime-only recreation at04:32:23UTC.
- Exact PO approval relayed by Moderator; lease consumed/master closed04:34:43.
  946passed/5fixture-skips;58deployed-file hashes, footer2.4.38, repeated
  health/restart0, unchanged config/schema/Console and HTTPS/auth passed.
  Model recognition remains not_run. Private Review stays off.
- [Deployment receipt](reports/2026-09-16-porn-spam-policy-deployment.md).

## Position 1 — private Moderator review

- Requested mechanical deployment owner: task «Модератор»,
  `019fd023-a949-7961-87cd-693bcb893e2c`.
- Exact owner instruction re-read: message `01a0a750-c465-7292-ae0f-253ee0ab7a54`,
  «Другая сессия сейчас деплоит, когда завершит - будешь деплоить ты.
  Пока можешь встать в очередь.»
- Root retains shared-source integration, fixes, acceptance and release lock.
- Candidate: accepted local source `1829573015de5d307868afb73e4ef3dcfc0e7fdb`,
  Console3.3.0, lifecycle `pushed`; not deployed. Root fixes close
  truncated-evidence, unsafe grouping and nonempty preview-root defects.
  Root905passed/5fixture-skips, Console159/159, independent review and source
  guard passed. [Acceptance](reports/2026-09-15-moderation-review-integration.md).
- The mounted Review API is disabled without storage/collection/delivery.
  The [local bridge contract](proposals/2026-09-15-moderation-live-bridge-contract-v1.md)
  is offered but not accepted: the [root review](reports/2026-09-15-moderation-bridge-review.md)
  identifies PO choices for primary-moderation availability and retained
  pseudonymous markers after erase. No implementation reservation or exact
  release lease exists; do not deploy this as a completed live workflow.
  The v2 documentation addendum resolves the reported specification defects
  conditionally; it selects neither policy. Waiting for the two PO decisions.
- No Moderator feature from this candidate is deployed. Collection, recipient,
  reviewer identity, source checkpoint, limits and real delivery are still gated.
- Before mechanical delegation: accepted exact source/tests, verified PO scope,
  explicit single-writer/lock handoff, fresh baseline and one-time lease naming
  service/SHA/scope/rollback/expiry/verification/stops. Until then this task has
  no SSH, production or transport authority. No concurrent master is permitted.

No claim of free storage, new spending, synthetic-collector activation, secret
change or guessed notification destination follows from queue placement.

## Separate source work — Assistant safety ownership and ask UX

Owner decision relayed by Assistant: Assistant-addressed questions are judged
by Assistant; ordinary posts by Moderator; Moderator performs sanctions from
the accepted protocol. Root received the read-only cross-role arbiter review.
Local implementation was reserved to Assistant in its isolated worktree
under [ask-protocol-v1](proposals/2026-09-16-ask-protocol-charter-v1.md), following
the relayed owner instruction «Давай - все делай.». Root retains main integration,
acceptance and commits; no other writer may touch reserved shared paths.
The work is now frozen and root committed candidate
`2c72e01cb28452c640c033c91a2060a8eca57201`, Assistant2.4.39, lifecycle `prepared`.
It remains in the isolated branch, not merged into main, pushed or deployed.
Root full gates1146total/1141passed/0failed/5fixture-skips, migration9/9 and
clean source guard passed. The30-second prompt/no-silence UX and invalid-router
fallback remain separate from deployeda41518f. No active writer or lease.
[Root verification and release gates](reports/2026-09-16-ask-protocol-root-review.md).

Earlier local review checkpoint: three pure-contract defects repaired and
independently reverified81/81. The later full-suite result is recorded above.
The exact old-a41518f rollback test reproduces a second judge for a late
Moderator webhook after new-source acceptance. Root reproduced1/1; safe
transition/rollback mitigation is not_run and blocks release.
The bounded [local runner extension](proposals/2026-09-16-ask-protocol-local-runner-extension-v3.md)
keeps strict validation and explicitly synthetic safety. The
[answer-claim clarification](proposals/2026-09-16-ask-protocol-answer-claim-clarification-v4.md)
permits replacement of wholly-unsent stale work, not repeat visible answers
after native delivery is calling, partial, uncertain or confirmed.
Timer follow-up68/68 plus4 probes passed on its earlier snapshot. Independent
forward-upgrade review found legacy double-judgement/unknown-fence bypasses;
the [v5 legacy transition](proposals/2026-09-16-ask-protocol-legacy-transition-v5.md)
passed independent10/10 synthetic checks. Quarantined legacy edits/late deliveries and
the still-unsafe old-binary rollback need explicit release treatment/approval.
