# Moderation Review contract v4 — all retained evidence is removable

Proposal to root after independent synthetic assurance. Read v1–v3 first;
this addendum changes only retained-observation visibility and grouping.
All production/activation gates, protected ownership and synthetic-only mode
remain unchanged.

## Problem and required property

Exact repetition requires retaining earlier observations before any suspicion.
In indefinite mode, those observations cannot remain invisible and impossible
to erase. Every retained source revision must be accessible through a private
case and the existing version-fenced manual erasure operation.

## Contract extension

- A native message without a detector match belongs to a `retained` case.
  This means «Сохранённое наблюдение», **not** suspicion, proof, moderation
  verdict or review request. It has no pending alert and no human label.
- Default `/cases?status=pending` remains suspicion-only. List queries now
  also accept `status=retained`; `all` includes retained/pending/reviewed.
  Status counts add `retained`. Existing get/erase/decision contracts keep
  their authenticated UUID and exact-version fences.
- Console queue adds an explicit filter for pending review, retained ordinary
  observations and all cases. Empty retained lists are distinguished from
  unavailable/disabled collection. A retained case displays «Подозрения не
  обнаружены» and «Уведомление отключено», and offers manual material erasure.
- The detector may promote an existing retained case when the required evidence
  appears. It may coalesce only never-reviewed retained cases in the same chat,
  moving all their immutable source revisions into the target before emitting
  repeat claims. Such source cases have no decisions, examples or sent alerts.
  Retired source IDs resolve as missing; target version increments to invalidate
  stale actions. No pending/reviewed case evidence or owner label is stolen.
- A detector claim must be supported by evidence visible in the resulting case.
  If another pending/reviewed case cannot be joined, exclude its messages from
  the repeat decision rather than claim invisible corroboration.
- One initial alert is queued only on the transition to suspicion. Pure retained
  cases cannot be claimed by alert delivery. Further repetitions/edits do not
  create a second alert. Initial negative `ingest` still may return
  `caseId:null` to indicate no review request, while its retained case remains
  accessible in the private retained-observations list.
- Manual removal erases all revisions/drafts/notes/receipts belonging to that
  case; unrelated cases are unchanged. Indefinite retention never implies
  automatic eviction. Capacity backpressure includes retained revisions.

## Mandatory regressions

1. Two benign messages fill a two-revision fixture cap. They are visible in
   retained observations; erasing exactly one frees capacity, then a new
   promotional message can be stored. No orphan raw text/hash/context remains.
2. Three long repeated standard answers become one pending case with all three
   native messages visible and one alert; no orphan retained cases remain.
3. Editing a message in reviewed/pending case A to match case B does not claim
   repeated evidence missing from case A. Case B and its human history survive.
4. Stale version/old source ID cannot erase the merged target. Retained-view UI
   filters do not create network writes or change the selected request target.
