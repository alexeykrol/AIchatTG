# Exact approval — Review activation23September

Status: approval requested, not a production lease. Candidate lifecycle:
`prepared`. The19September candidate/approval is superseded, not reusable.

## One release decision

Push exact source`8a2b27fb215a19d26cf35b6244dcd4151b7cac4d` on
`codex/review-retry-20260923` and the accompanying docs-only main tip named in
the approval message to existing private origin`alexeykrol/AIchatTG`, no force.
Then activate that exact source for AIchatTG telegram-runtime and
operator-console on the existing VPS: Assistant2.4.42/2026-09-23 and
Console3.4.0. Root owns the only writer/master.

One activation attempt, at most one bounded rollback,60-minute execution lease
issued after exact approval and successful preflight. Activation must be on
23SeptemberUTC; otherwise refreeze dated metadata/source and seek the changed
exact approval. Do not rerun the failed17September helper unchanged.

## Effects explicitly included

- Enable suspected-promotion private Review in the current3 Moderator chats,
  alongside unchanged independent primary moderation. No new automatic
  deletion/ban policy; ordinary book recommendations are not banned.
- Keep exact retained bindingSHA256
  `c48f4370dd4ca80b6f9d51cc9846ebef9ad1fce91fe749fc3a4e6d1fe8119b83`
  and startAt`2026-09-17T11:48:07.284Z`. New deliveries/edits may qualify from
  that earlier boundary; no history fetch/backfill/replay or reset/reprovision.
- Store text/caption≤8192 characters, direct reply context≤2048 and required
  native IDs; allowUserId=false. Retention until manual erasure, caps10000
  observations/40000events/20000erasure receipts. Full caps reject new intake;
  they do not delete evidence. Existing Admin credential holders can read,
  decide and erase cases, not independently authenticated personal reviewers.
- At most6 generic private alerts/hour to the previously verified recipient,
  one initial attempt/case, no resend or source text in alerts. These configured
  ongoing effects continue after the deployment lease until separately disabled.
  No new paid resources, model calls or increased quota.
- Preserve bot/webhook/model/secret configuration, runtime database and
  knowledge mounts. Only exact Review flag/mount/binding activation plus the
  new seconds-format Console release timestamp change.

Excluded: paid evaluations, synthetic Telegram posts, manual decisions/erasure,
new or repeated message deletion (including completed9709), author bans,
runtime DB migrations, rebind, history import, Gatekeeper and all News actions.

## Evidence, checks and rollback

Local1470passed/5explicit skips/0failed, migration9/9, independent regressions
and exact source guard passed. Production baseline refreshed23September15:57UTC:
Assistant2.4.41/e523485 and Console3.2.0/f650fe8 healthy/restart0, Reviewoff;
retained binding/store intact/empty/noowner/socket. Exact new images/live
acceptance are `not_run`. See [candidate report](../reports/2026-09-23-moderator-recurrence-candidate.md).

Before recreation: refresh and compare baseline/config/store, build exact Git
archive, verify source hashes/labels/footer, validate both actual image config
loaders against full Compose pair. Console releasedAt uses UTC seconds; keep
the separate retained Review millisecond startAt unchanged. Stop on divergence.
After activation verify both health/restarts, source/schema/config/route/mount
preservation, HTTPS/auth and authenticated Review live status without creating
a synthetic case. Empty status is not end-to-end delivery proof.

Rollback to exact runtime`e52348537f0445f285487a957e0b43f47bd0018d`, image
`sha256:dc7585b68a99929c0ce88314fe71f86b46b3b24ef2973c8bdcd8c7df63416bf5`,
and Console`f650fe87cabf5cf498a64d48907f7a924861cfd2`, image
`sha256:6f76808829b1c0e4bc2544330f23fadd3f529e2991e98ce3bd1cac6a811af1e9`,
with their preserved base configuration. Keep runtime/Review data and failed
operation evidence. Already delivered alerts cannot be recalled. No rollback
to pre2.4.41 safety sources or blind database restoration.

Stop on auth/transport failure, schema/policy/ownership drift, unsafe mounts,
primary degradation, wrong recipient or uncertain notification. No reconnect
fallback, send retry or stale-owner deletion to force startup.

Safe default until exact approval: no push/deploy/spending/deletion;
Assistant2.4.41/Console3.2.0 and Reviewoff remain unchanged. Full native
capture→notice→decision/erase acceptance remains separately gated and `not_run`.
