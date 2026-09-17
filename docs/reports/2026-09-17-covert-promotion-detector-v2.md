# Covert-testimonial review detector v2 — bounded result

Date: 2026-09-17. Lifecycle: **prepared**; not integrated or deployed by this
worker. Charter: `covert-promotion-detector-20260917-v1`.

## Source and ownership

- Base/HEAD: `feb0f0585deff8be9efc4512729170b5b1397f64`; base ancestry passed.
- Branch: `codex/covert-promotion-review-20260917`.
- Worktree: `/Users/alexeykrolmini/.codex/worktrees/moderator-covert-promotion/AIchatTG`.
- Integration owner: repository-root task `019fd019-af89-7b50-a16d-8c7928753f24`.
- Only the detector, its test file and this new report changed. Old `d85f`
  worktree and all shared consumers remain untouched. No worker commit/push.

Frozen source SHA-256:

| File | SHA-256 |
| --- | --- |
| `apps/operator-console/src/moderation-review-detector.mjs` | `2be8d42d99eb16166980144c145e61a6827e1b5b9e6bc379aeaa5bf04d3a0d6f` |
| `apps/operator-console/test/moderation-review-detector.test.mjs` | `f9475e7656acd0af0a9293db1da35671f6537cb118ff985508b5f54f42a12b53` |

## Implemented boundary

`promotion-review-v2` adds the review-only pattern `covert-testimonial-bait`.
It needs a product/book/course, affirmative narrated experience, a claimed
benefit and at least two distinct supporting cue families:

1. Expected result contrasted with a claimed unexpected benefit.
2. Broad life and work applicability.
3. Audio-format availability.
4. A soft recommendation.

These cues can recognize synthetic no-title and paraphrased testimonials
without a purchase instruction, link, referral or private-message funnel.
Multiple synonyms within one family do not satisfy the two-family threshold.
Invisible separators are ignored only while recognizing cues, never while
computing fingerprints or grouping identities.

The new branch excludes the covered forms of supplied recommendation requests,
explicit spam reports, negative reviews, hypothetical experience and specific
technical answers. Existing quotation/exercise exclusions remain intact.
Contextual exceptions apply to this new branch, not independently established
legacy commercial/repetition findings.

The function still returns the same keys and `reviewOnly: true`. Fingerprints
retain complete normalized message identity, including product names and
case-sensitive URLs; the detector version is part of the fingerprint. No fuzzy
cross-author grouping, account ownership or bot/AI attribution is introduced.
A singleton has only its own related message ID. Paraphrases are individually
eligible suspicions, not evidence of a shared campaign.

## Consumer integration metadata

New pattern ID: `covert-testimonial-bait`.

New reason IDs:

- `personal_testimonial_with_benefit`
- `expectation_reversal`
- `broad_life_work_benefit`
- `audio_format_available`
- `soft_recommendation`

Root must map these to cautious, human-readable suspicion labels in the Review
UI and test the visible rendering. The current base UI otherwise falls back to
an unknown-pattern label. This worker did not edit UI or store contracts.

The pure detector can flag cues without supplied context and explicitly returns
`original_context_missing`; it does not claim the message is off-topic. Root's
selected live-capture contract remains responsible for incomplete-evidence
admission/suppression and visible source/context coverage. This report does not
relax those fences.

## Verification

`passed` on Node 20.20.0:

```bash
node --test apps/operator-console/test/moderation-review-detector.test.mjs
node --test apps/operator-console/test/moderation-review-detector.test.mjs apps/operator-console/test/moderation-review-alerts.test.mjs apps/operator-console/test/moderation-review-browser-state.test.mjs
git diff --check
```

- Detector: **66/66** tests, including all 24 original tests (only the expected
  version changed), 13 positive synthetic singleton narratives, 15 hard-negative
  narratives, identity/normalization/threshold/context regressions and seven
  independent-review repair groups.
- Detector + existing alert and browser-state suites: **122/122**, no skips.
- Independent read-only assurance reran 66/66, diff-check and all seven repaired
  groups against the frozen hashes above; no remaining concrete blocker in that
  bounded review.

Independent findings repaired before freeze:

1. Life/work stems matching unrelated substrings.
2. Plural/singular recommendation requests.
3. Spam-report greetings and explicit labels.
4. Negated experience mistaken for affirmative experience.
5. A later counterfactual conclusion suppressing an actual endorsement.
6. Polite recommendation requests such as "Can you recommend" in Russian.
7. English negative benefit tenses and advice to avoid the book.

`not_run`: full Console/store/HTTP/runtime integration suites, rendered UI,
production deployment, real Telegram notification, live message capture or
provider evaluation. No dependencies installed, real data copied, paid calls,
production access or external effects occurred in this slice.

## Limits and next action

This synthetic targeting corpus is not a precision/recall benchmark. The
bounded lexical heuristic can miss other wording, languages, obfuscation and
attribution forms. Genuine unsolicited endorsements can share all these cues;
only the owner supplies a human decision. No automatic deletion, ban or pattern
activation is authorized by this result. The separate existing porn-spam policy
and primary Moderator/Guard logic are unchanged.

Next safe action: root verifies the hashes, integrates these exact two source
files, adds consumer labels and runs the complete private Review bridge gates.
The workflow still needs real recipient/reviewer/chat/start/limit bindings and
an exact release lease before activation. User choices are settled: continue
primary moderation with visible Review gaps; erase linked identifiers without
promising post-erasure replay suppression. Storage is indefinite until manual
erase. This detector-only result does not complete or prove that live workflow.
