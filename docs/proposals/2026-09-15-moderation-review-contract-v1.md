# Moderation Review v1 — local contract proposal

Status: proposed to the root integrator; synthetic/local only. Base `9d326f4`.
Owner: Moderator task, branch `codex/moderation-review-v1-20260915`.
The root charter controls scope. This document does not authorize collection,
production configuration, Telegram delivery, sanctions or pattern activation.

## Separation and safe defaults

- New code is under `apps/operator-console/src/moderation-review-*.mjs`, with
  feature-local tests. Only `moderation-v3.html` changes in existing sources.
- A private, separate Console-owned SQLite store holds explicitly supplied
  synthetic observations, cases, decisions, pattern drafts and alert receipts.
  It never opens the runtime database. No bootstrap collector is added here.
- Store construction requires `mode: 'synthetic'`, an absolute private `root`,
  and explicit fixture `limits`: `retentionMs`, `maxTextChars`,
  `maxContextChars`, `maxNoteChars`, `maxObservations`. No retention default.
- Source fields: `chatId`, `messageId`, numeric monotonic `revision`, `text`,
  ISO `observedAt`; optional `userId`, `context: {text, messageId}`. A missing
  original-post context is reported as missing, never reconstructed. Input
  character limits and truncation are recorded; original timestamps are not
  invented from observation time. No cross-chat history or identity inference.
- Private text, IDs, hashes and notes remain in the private store. All checked-in
  fixtures are synthetic. Expiry removes evidence, decisions, notes and draft
  examples together; static pattern definitions contain no private examples.

## Detector and store interface

`detectPromotionReview(observation, {history = []})` returns
`{version, fingerprint, patternIds, reasons, relatedMessageIds, reviewOnly:true}`.
History contains latest bounded observations only. Reasons are machine codes;
positive signals are suspicions, not proof of bots or abuse. A book mention,
ordinary link or polished writing alone must not produce a case.

`createModerationReviewStore({root, mode, limits, now = Date.now})` exposes:

- `ingest(observation)` -> `{caseId|null, duplicate, stale}`. Native identity is
  `(chatId,messageId)`. Retries are idempotent; old revisions never replace new
  evidence; same-revision different-content collisions fail closed. Immutable
  revisions are retained to fixture expiry. Repeats group only within one chat.
- `status()` -> `{mode:'synthetic', collectionEnabled:false,
  deliveryEnabled:false, decisionsEnabled:true, patternActivationEnabled:false,
  sanctionsEnabled:false, retentionMs, counts:{pending,reviewed,patterns}}`.
- `listCases({status='pending',limit=30,offset=0})` -> `{cases,total}`; summaries
  have `id,version,status,chatId,updatedAt,preview,patternIds,messageCount,label`.
- `getCase(id)` -> case or null, including summary fields plus `messages`
  (each `messageId,revision,text,userId,observedAt,context, truncated`),
  `reasons`, `detectorVersion`, `alert:{state}`, `decisions` and `expiresAt`.
- `decide({caseId,expectedVersion,decisionId,label,note}, principal)` ->
  `{caseId,version,decisionId,label,patternDraftId,replayed}`. Labels are exactly
  `hidden_advertising`, `legitimate`, `insufficient_evidence`. Authenticated
  principal is injected server-side, never read from JSON. UUID decision ID
  gives same-request replay; a conflicting ID or stale case version is 409.
  Every human decision is immutable, bound to the evidence version and creates
  a versioned **draft** example (including negative/uncertain labels), not an
  active detector rule. New evidence reopens a reviewed case.
- `listPatterns({limit=30,offset=0})` -> `{patterns,total}`; draft examples
  include `id,caseId,revision,label,note,createdAt,principal,patternIds,state`.
- `listHistory({limit=30,offset=0})` -> `{history,total}`; entries include
  `decisionId,caseId,evidenceVersion,label,note,createdAt,principal`.
- `claimAlert()` -> pending alert `{caseId,attemptId}` or null. Persist `calling`
  before send; reopening a store changes orphaned calling to `uncertain`.
- `finishAlert({caseId,attemptId,state,receipt})`: accepted terminal states
  `sent`, `failed`, `uncertain`; exact attempt required. No automatic retry of
  failed/uncertain delivery; repeats/edits never enqueue another alert.
- `purgeExpired()` and `close()`. No unrelated store deletion or mutations.

## Authenticated HTTP adapter (root mount proposal)

New namespace `/api/operator/moderation`; legacy POST rejection stays intact.
The exported handler receives a trusted server-authenticated principal. With
no store, status reports disabled and other endpoints fail `503 review_disabled`.
All responses are no-store and contain no filesystem paths/stack traces.

| Method | Path suffix | Result |
| --- | --- | --- |
| GET | `/status` | store status or disabled capabilities |
| GET | `/cases?status=pending&limit=30&offset=0` | case summaries |
| GET | `/cases/:opaqueUUID` | selected case, 404 if missing/expired |
| POST | `/cases/:opaqueUUID/decisions` | bound human label; no sanctions |
| GET | `/patterns?limit=30&offset=0` | immutable draft examples |
| GET | `/history?limit=30&offset=0` | review audit history |

Writes require JSON, `X-Operator-Intent: moderation-review`, same-origin Origin
and non-cross-site Sec-Fetch-Site, a bounded body and exact validated fields.
Body: `{expectedVersion,decisionId,label,note}`. The URL owns the target case.
No ingestion/delivery/test-seed HTTP endpoint is exposed. A local-only harness
may directly inject fixture observations and a fake sender before listening
on loopback. The production server remains unchanged until root integration.

## Console and delivery

Existing Russian navigation and release stamp remain unchanged. Moderation
contains Review queue, Pattern drafts, Review history and existing Model/rules
reference. Authenticated link is `/moderation-v3.html?case=<opaqueUUID>`; no raw
text, native ID or auth token. GET/opening a link performs no moderation action.
Save is disabled during loading/saving; selected case/version are fenced;
stale responses cannot relabel another case. Hostile text is textContent only.

`deliverNextModerationReviewAlert({store,send,consoleUrl})` is injection-only,
used with a fake transport locally. No Telegram token, HTTP client, destination
or production switch is present. Payload contains generic notice + deep link,
not raw private evidence. Thrown/ambiguous results become `uncertain`; explicit
definite failure becomes `failed`; all are persisted without blind retry.

## Proposed root integration, separate release slice

After accepting this contract, root may mount the handler **after existing
authentication**, initially without a store (disabled). The actual authenticated
principal is `operator`, not an invented personal identity. Production store,
collector, reviewer authorization, evidence limits/retention and Telegram owner
delivery require the specific PO decisions and exact integrated release review.
No runtime/Compose/shared-schema change is proposed in this synthetic slice.
