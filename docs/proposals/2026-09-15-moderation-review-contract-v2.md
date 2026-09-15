# Moderation Review contract v2 — explicit indefinite retention

Supersedes retention/deletion details only in `2026-09-15-moderation-review-contract-v1.md`.
Read v1 and this addendum together. All other ownership, disabled-default,
synthetic-only, no-sanctions and production gates remain unchanged.

## Product Owner decision

The Product Owner explicitly answered: keep source comments/context without a
time limit; the owner will manually remove them after analysis as needed, until
further instructions. This is a retention choice, not a production collector,
recipient, spending or release authorization. No claim about storage cost is
made by this contract.

## Required implementation changes

- `limits.retentionMs` must be explicit: `null` means indefinite retention,
  positive integer is available for bounded synthetic expiry tests. Missing
  retention remains invalid. Indefinite cases have `expiresAt:null`; no automatic
  expiry is scheduled. Status exposes `retentionMs:null` and the UI says
  «Бессрочно, до ручного удаления».
- Storage limits are safety backpressure, not an eviction policy: reaching
  `maxObservations` must reject new intake explicitly, never silently delete
  older evidence or examples. No deployment/paid quota is increased here.
- Add `eraseCase({caseId,expectedVersion,requestId}, principal)` with UUID
  request ID, exact version fence and authenticated server principal. Remove
  case source revisions, retained comments/context, review notes/decisions,
  linked private draft examples and delivery metadata together in a transaction.
  Delete only its own private Review records, never Telegram or runtime data.
- Keep only a minimal non-content deletion receipt for idempotency:
  `{caseId,requestId,principal,deletedAt,erased:true}`. No text, native message or
  user IDs, reason fingerprints, notes or example payload survives in receipts.
  Exact request replay returns the same receipt; collisions fail closed.
- New authenticated `POST /api/operator/moderation/cases/:id/erase` has the
  same CSRF/intent/body/security boundary as decisions. Exact body:
  `{expectedVersion,requestId}`. It is never triggered by opening a deep link.
- UI provides a separate destructive «Удалить сохранённые материалы» action,
  with a second explicit confirmation naming the current case and explaining
  that its source evidence, notes and draft examples are erased, Telegram is
  untouched, and this cannot be undone from the Review UI. Switching cases or
  refreshing cancels the confirmation. Stale/version conflicts do not delete.
- Synthetic tests prove indefinite survival across clock advances/restart,
  manual target-only erasure, body/principal/version checks, repeat-request
  safety and no accidental erase on navigation or failed responses.

Actual SQLite secure deletion is enabled; backup/export copies, if later
introduced, require their own retention/deletion policy before activation.
No backups of private Review data are created by this local slice.
