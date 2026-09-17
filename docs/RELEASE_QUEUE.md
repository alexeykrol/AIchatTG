# AIchatTG release queue

Checkpoint: 2026-09-17, local Review bridge implemented; production remains2.4.39/Console3.2.0. The root integrator owns shared integration
and this queue. No active production lease or SSH master remains.

## Completed

Assistant2.4.39, exact runtime `2c72e01cb28452c640c033c91a2060a8eca57201`,
lifecycle `production-verified`; source main-integrated/pushed, one runtime-only
recreation06:57:40UTC. PO delegated remaining technical decisions; conservative
legacy quarantine and tested emergency stop/preserve/forward-repair selected.
No old-binary downgrade.1141passed/5fixture-skips, migration9/9,22helper tests,
64source files/footer, exact additive schema/legacy invariants and repeated
health/restart0/config/Console/HTTPS passed. Lease/master closed06:59:32UTC.
[Deployment receipt](reports/2026-09-16-assistant-2.4.39-deployment.md).
Paid/live Telegram acceptance and the separate knowledge-quality issue remain
not_run/open. The private Review below was not part of this release.

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

- Latest checkpoint17.09 11:51UTC: approved exact7d99ae0 attempt stopped on
  deployment-helper timestamp format; Console rolled back to3.2.0, runtime
  unchanged2.4.39. Both healthy/restart0. Fresh empty Review store/config retained;
  collection/delivery off. Candidate lifecycle `pushed`. Lease/master closed;
  one corrected same-source retry needs the newly requested PO approval.
  [Attempt and rollback receipt](reports/2026-09-17-review-activation-rollback.md).
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
- The disabled3.3.0 checkpoint is now extended by the local **Console3.4.0 /
  Assistant2.4.40 candidate7d99ae0, pushed**. Both PO choices are resolved:
  primary moderation continues independently on Review failure; erase removes
  linked identifiers without a future suppression guarantee. See the
  [selected v3 contract](proposals/2026-09-17-moderation-live-bridge-selected-v3.md).
  Runtime projection/cancellation, private Unix IPC, Console-only store/owner,
  atomic receipts, generic one-attempt notification and manual decision/erase
  are implemented with synthetic tests. Covert testimonial/book promotion is
  review-only, not a new auto-ban/delete policy.
- Frozen evidence: root1427passed/5fixture-skips, migration9/9, source guard
  and GitHub ref passed. Exact local Node20.20.0 Linux images/hash/footer/import
  checks passed after isolating the stalled local credential helper; saved
  passwords/daemon/base version unchanged. Subsequent VPS attempt rolled back;
  newest checkpoint above is authoritative, not this prepared evidence.
  [Candidate receipt](reports/2026-09-17-moderation-review-live-candidate.md).
- The PO-selected private recipient is verified read-only. Reviewer access,
  exact chat/start/bounds/configuration and source were approved for the first
  consumed lease. Retry approval and actual live delivery remain open gates.
  No collection or notification is live. Follow the
  [activation procedure](MODERATION_REVIEW_ACTIVATION.md); ordinary base-only
  Compose leaves the optional feature off. Do not call that a completed workflow.
- Before mechanical delegation: accepted exact source/tests, verified PO scope,
  explicit single-writer/lock handoff, fresh baseline and one-time lease naming
  service/SHA/scope/rollback/expiry/verification/stops. Until then this task has
  no SSH, production or transport authority. No concurrent master is permitted.

No claim of free storage, new spending, synthetic-collector activation, secret
change or guessed notification destination follows from queue placement.

## Assistant safety ownership and ask UX — completed release

Owner decision relayed by Assistant: Assistant-addressed questions are judged
by Assistant; ordinary posts by Moderator; Moderator performs sanctions from
the accepted protocol. Root received the read-only cross-role arbiter review.
Local implementation was reserved to Assistant in its isolated worktree
under [ask-protocol-v1](proposals/2026-09-16-ask-protocol-charter-v1.md), following
the relayed owner instruction «Давай - все делай.». Root retains main integration,
acceptance and commits; no other writer may touch reserved shared paths.
The work is frozen and root committed candidate
`2c72e01cb28452c640c033c91a2060a8eca57201`, Assistant2.4.39,
lifecycle `production-verified`; integrated by762c251, pushed and deployed.
After the dated [initial push/gates](reports/2026-09-16-ask-protocol-push.md),
PO instructed root to decide remaining technical matters and deploy. Root
accepted conservative legacy-native quarantine and the neutral fallback,
repaired/tested the STOP procedure, then issued and consumed the exact lease.
No active writer/master remains. [Final receipt](reports/2026-09-16-assistant-2.4.39-deployment.md).
Root full gates1146total/1141passed/0failed/5fixture-skips, migration9/9 and
clean source guard passed. The30-second prompt/no-silence UX and invalid-router
fallback are deployed in2c72e01; real-model acceptance remains not_run.
[Historical prepared review](reports/2026-09-16-ask-protocol-root-review.md).

Earlier local review checkpoint: three pure-contract defects repaired and
independently reverified81/81. The later full-suite result is recorded above.
The exact old-a41518f rollback test reproduces a second judge for a late
Moderator webhook after new-source acceptance. Root reproduced1/1; old-binary
rollback remains prohibited. The alternative stop/preserve/forward-repair was
tested22/22, including the repaired complete command-budget reserve.
The bounded [local runner extension](proposals/2026-09-16-ask-protocol-local-runner-extension-v3.md)
keeps strict validation and explicitly synthetic safety. The
[answer-claim clarification](proposals/2026-09-16-ask-protocol-answer-claim-clarification-v4.md)
permits replacement of wholly-unsent stale work, not repeat visible answers
after native delivery is calling, partial, uncertain or confirmed.
Timer follow-up68/68 plus4 probes passed on its earlier snapshot. Independent
forward-upgrade review found legacy double-judgement/unknown-fence bypasses;
the [v5 legacy transition](proposals/2026-09-16-ask-protocol-legacy-transition-v5.md)
passed independent10/10 synthetic checks. Quarantined legacy edits/late deliveries
are the accepted conservative transition, not restored moderation of old edits.
Any further production action now needs a fresh exact lease; do not reuse closure.
