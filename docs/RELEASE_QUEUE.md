# AIchatTG release queue

Checkpoint: 2026-09-15 23:13:28 UTC. The root integrator owns shared integration
and this queue. No active production lease or SSH master remains.

## Completed

Console3.2.0, exact source `f650fe87cabf5cf498a64d48907f7a924861cfd2`, lifecycle
`production-verified`. One Console-only recreation; lease consumed/master closed.
[Deployment receipt](reports/2026-09-15-console-v32-deployment.md).

## Position 1 — private Moderator review

- Requested mechanical deployment owner: task «Модератор»,
  `019fd023-a949-7961-87cd-693bcb893e2c`.
- Exact owner instruction re-read: message `01a0a750-c465-7292-ae0f-253ee0ab7a54`,
  «Другая сессия сейчас деплоит, когда завершит - будешь деплоить ты.
  Пока можешь встать в очередь.»
- Root retains shared-source integration, fixes, acceptance and release lock.
- Candidate: frozen worker source at base9d326f4; imported locally with root
  corrections for truncated detector evidence and nonempty preview-root guards.
  Final acceptance is pending: the latest root targeted run was28/29, with one
  failing test still to diagnose. No integrated release SHA/lease exists.
- No Moderator feature from this candidate is deployed. Collection, recipient,
  reviewer identity, source checkpoint, limits and real delivery are still gated.
- Before mechanical delegation: accepted exact source/tests, verified PO scope,
  explicit single-writer/lock handoff, fresh baseline and one-time lease naming
  service/SHA/scope/rollback/expiry/verification/stops. Until then this task has
  no SSH, production or transport authority. No concurrent master is permitted.

No claim of free storage, new spending, synthetic-collector activation, secret
change or guessed notification destination follows from queue placement.
