# Ask protocol: bounded revision-aware answer claims

Status: local implementation clarification under ask-protocol-v1; not a new
production approval, paid-call authorization or general edit-to-reanswer policy.

## Confirmed gap

The legacy Assistant claim is keyed only by native chat/message. When an
original question passes safety and starts a slow answer, a newer edit can
obtain its own valid judgement but lose the native answer claim. The original
is correctly fenced before sending; neither revision then answers. A separate
test already covers the earlier race where the original is still in safety.

## Bounded rule

- Preserve at most one visible answer sequence per native question. A revision
  does not authorize another answer after a confirmed, partial, calling or
  uncertain native delivery. Legacy unresolved claims stay fenced.
- A newer genuinely observed revision may replace an obsolete attempt only
  before any native answer send has entered its external boundary. It needs
  its own current strict allow and the ordinary unchanged request quota.
- Revision-aware claims may be additive bookkeeping in the already reserved
  database/runtime paths. Bind completion to the exact claim/generation; an old
  callback must not complete, release or otherwise change the new claim.
- The native delivery reservation and the first-send calling transition must
  be atomic with their ownership/current-revision checks. Recheck before every
  part and any markup fallback. Once any part may have been sent, no replacement
  answer sequence is automatically allowed.
- Do not replay an unknown or interrupted provider call. Duplicate webhooks
  and recovery never create another call for the same revision. Do not refund
  an obsolete call that actually crossed a paid boundary or erase its usage.
- No new user-visible explanatory copy or general reply-after-edit policy is
  authorized. If the safe ownership/uncertainty boundary cannot be proven,
  retain the native fence and report the limitation rather than guessing.

## Required offline evidence

Suspend the original answer before any send; accept the newer edit; release
the original; prove only the current answer is delivered and accounted for.
Also cover the reverse race: first send calling/partial/unknown or already
confirmed before the edit; no second answer sequence. Include duplicates,
restart, old completion attempts and unchanged quota protections. These tests
use synthetic providers and transport only.

Root owns acceptance and the subsequent exact release decision. The separate
old-binary rollback counterexample remains a release blocker until a bounded
transition/rollback plan is tested and its consequences are approved.
