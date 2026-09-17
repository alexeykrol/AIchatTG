# Task Charter: complete covert-testimonial review detection

## Metadata

- Task ID: covert-promotion-detector-20260917-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `feb0f0585deff8be9efc4512729170b5b1397f64`
- Worktree/branch: `/Users/alexeykrolmini/.codex/worktrees/moderator-covert-promotion/AIchatTG`, `codex/covert-promotion-review-20260917`
- Controller: root `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: Moderator task `019fd023-a949-7961-87cd-693bcb893e2c`

## Outcome and Acceptance

- Outcome: a bounded deterministic review-only detector identifies covert
  personal-testimonial/book-bait variants even without purchase, referral,
  link or DM language, while legitimate contextual recommendations remain
  negative. This completes an already assigned recognition slice, not a new
  requirement for the PO to restate.
- Acceptance: synthetic same-message/paraphrase/case/punctuation variants,
  no-title books, audio-format bait and generic life/work promises are
  detected when their combined rhetorical cues establish a review suspicion.
  Bare book mentions, specific requested technical recommendations, quoted
  examples, reported spam and classroom exercises remain negative. Preserve
  prior explicit-commercial and bounded-repeat behavior.
- Evidence vocabulary: passed / failed / not_run / inconclusive

## Scope and Exclusions

- In scope: detector module and its tests only; version/reasons/pattern IDs
  within the existing result shape; report concrete cue combinations, local
  limitations and integration metadata. Evidence is review suspicion only.
- Excluded: automatic sanctions, primary semantic/Guard prompts or routing,
  provider/model changes, fuzzy cross-author identity claims, paid evaluation,
  global books ban, capture/IPC/store/HTTP/UI changes and production activation.
- Do not copy real users' profiles, private messages or production receipts
  into fixtures. Build clearly synthetic equivalents of the supplied scenario.
- Do not fabricate context or temporal/repetition proof. Missing supplied
  context remains missing, not evidence of irrelevance. Never expand a single
  book/audio/praise word into an unconditional finding.

## Sources of Truth

- `/Users/alexeykrolmini/Code/AIchatTG/apps/operator-console/src/moderation-review-detector.mjs` — accepted pure API and old seed behavior.
- `/Users/alexeykrolmini/Code/AIchatTG/apps/operator-console/test/moderation-review-detector.test.mjs` — existing positive/negative and native revision invariants.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/reports/2026-09-17-moderator-book-reply-diagnostic.md` — verified incident path and prior-assignment correction; report is a current local artifact outside base commit.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/proposals/2026-09-15-moderation-review-contract-v5.md` — retained complete evidence and grouping fences.

## Ownership

- Owned files/contracts: only `apps/operator-console/src/moderation-review-detector.mjs`
  and `apps/operator-console/test/moderation-review-detector.test.mjs` in the new
  worktree. A new dated result report under `docs/reports/` may be added there.
- Shared-contract writer: root owns result consumers, schema/store, entrypoints,
  IPC/auth, config, UI labels, runtime hooks, release metadata and dependencies.
  Preserve return object keys and `reviewOnly:true`; propose required consumer
  changes in the result, do not implement them unreserved.
- Integration owner/target: root/main. Worker never commits, merges or pushes.
- Unrelated dirty paths: preserve ALL files in old worktree
  `/Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG` at9d326f4, including its
  frozen untracked modules/proposals. Do not reset, stash, clean or rebase it.
  Root's current feedback/report edits are root-owned and not copied as source.

## Authority and Attention Gates

- Allowed: bounded local implementation, offline synthetic tests and fresh
  bounded subagents under this reservation. Main may evolve; do not rebase
  or overwrite shared paths without root coordination.
- Forbidden: SSH/remote access, production reads/writes, Telegram API, secrets,
  provider calls, DB imports, external sends/sanctions, commits/pushes.
- Production: blocked until root accepts exact integrated source, actual
  private recipient/reviewer/chat/start/limits and an exact release lease.
  PO «я даю разрешение заранее» records advance release intent, not fabricated
  bindings, limits or source identity.
- Spending: blocked; this slice uses no paid model or resource.

## Dependencies

- Inputs: exact base and accepted API; prior PO request to recognize covert
  advertising, accumulate patterns and notify the owner for a decision.
- Depends on: none for pure detector. Root records the explicit follow-up
  choices: keep primary moderation operating with honest Review gaps; erase
  linked identifiers without promising post-erasure deduplication.
- Unblocks: root Review capture/intake/notification/UI integration and
  independent detection assurance. Detection never becomes primary sanctions.

## Checks

```bash
git status --short --branch
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH node --test apps/operator-console/test/moderation-review-detector.test.mjs
git diff --check
```

If an existing consumer test expects the previous detector version or pattern
set, report the exact mismatch; root owns consumers. Do not weaken safety
tests or silently reclassify approved negatives to obtain a green suite.

## Stop Rules

- Stop for: write outside reservation, unclear product/retention expansion,
  need for real data/provider call, contradictory current base or API design.
- Do not pause ordinary local work for the already answered privacy/availability
  choices. Neither choice grants live storage/sending authority.

## Result Contract

First return `CHARTER ACCEPTED: covert-promotion-detector-20260917-v1` with
grounded worktree/base/dirty state. Then implement without waiting for the PO.

Return actual diff and file hashes; test results and adversarial negatives;
new version/IDs/reason labels needed by consumers; all risks/limitations;
one next safe action owned by root. Do not claim the full workflow complete
from a detector-only result.
