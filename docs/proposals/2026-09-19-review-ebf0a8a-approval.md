# Exact approval request — private Review activation

Status: **approval requested, not approved**. This is not a lease or permission
to connect, deploy, send, delete, provision or spend. Root has received no fresh
exact activation approval for this candidate. The former consumed approval
and the urgent request to finish are not silently reused for the changed source.

## Two explicit scopes to confirm together or separately

1. **Push:** publish the exact candidate branch
   `codex/review-retry-20260919` at
   `ebf0a8acd62974a49f0b99149709bcab196d8394` and the exact documentation-only
   main tip named in the accompanying approval message to the existing private
   `alexeykrol/AIchatTG` origin. No force push, other repository or extra code.
2. **One deployment:** activate that exact candidate for
   `aichattg-aichattg-telegram-runtime-1` and
   `aichattg-aichattg-operator-console-1` on the existing AIchatTG VPS route.
   Assistant2.4.42 / Console3.4.0; retain the2.4.41 safety fix. Root is the sole
   remote writer. One activation attempt and at most one bounded rollback;
   execution window at most60 minutes from the issued lease. No automatic retry.

The candidate's planned release date is19September. Its activation must occur
on that UTC date; if approval/preparation carries over to another date, stop,
update release metadata, refreeze checks and present the new exact SHA.

## External effects and limits

Enable private Review for newly delivered eligible events in the existing
three Moderator chats, using the retained exact binding, recipient and roots.
Keep binding SHA-256
`c48f4370dd4ca80b6f9d51cc9846ebef9ad1fce91fe749fc3a4e6d1fe8119b83`
and startAt **2026-09-17T11:48:07.284Z** unchanged. No history fetch/replay;
newly delivered gap-period sources and new edits can still qualify under that
earlier boundary. Do not claim a new19September source cutoff.

Store message/caption text up to8192 characters, direct reply context up to2048
and required native identifiers, with allowUserId=false. Existing Admin
credential holders can read, decide and erase Review cases; this is not
independent personal reviewer authentication. Retain records until manual
erasure, bounded by10000 observations/40000 events/20000 erasure receipts.
At a cap, reject new admissions rather than deleting retained evidence.

Enable at most6 generic private notifications per hour, one initial attempt
per case and no resend. No source text is sent in these alerts. The feature
continues under those configured limits after successful deployment until
separately disabled; the60-minute window bounds the deployment operation,
not ongoing product operation. Review adds no model calls, new paid resources
or quota increases. Existing primary moderation remains independent.

No reprovision/reset/rebind, secret/webhook changes, new sanction policy,
historical import, new deletion or replay of completed comment9709 deletion.

## Verification and rollback

Local evidence:1452 passed/5 explicit skips/0 failed, migration9/9, source guard,
safety-preservation proof and retained-state/timestamp regressions passed.
Exact new image and live verification remains not_run before approval.

Under the approved scope, first refresh current images/config and retained
store/binding/owner state. Stop on any divergence. Build from the exact archive,
verify labels/source hashes/footer and complete composed config inside both
images before recreation, including Console seconds-format release time.
Then verify both services, health/restarts, HTTPS/auth, source/schema/config
preservation and authenticated Review live status without creating a case.

Rollback to Assistant2.4.41/e523485 image
`sha256:dc7585b68a99929c0ce88314fe71f86b46b3b24ef2973c8bdcd8c7df63416bf5`
and Console3.2.0/f650fe8 image
`sha256:6f76808829b1c0e4bc2544330f23fadd3f529e2991e98ce3bd1cac6a811af1e9`,
with their preserved base configuration. Keep all runtime/Review data and
failed-operation evidence. Never roll back the safety fix or delete a stale
owner/socket merely to force startup. Already sent alerts cannot be recalled.
Stop on auth/transport failure, primary degradation, unexpected ownership,
schema/config drift, wrong recipient or uncertain notification; no reconnect
fallback or send retry.

Synthetic Telegram posts, manual decisions and evidence erasure are **excluded**
from this deployment approval. Full live capture→notice→decision/erase testing
will remain not_run unless separately authorized with exact input/actor/targets.
No paid model test is requested. Safe default: leave Review off and production
Assistant2.4.41/Console3.2.0 unchanged.

## Separate visible-post clarification

The urgent owner quotation is historical, not a verified new post-candidate
report. The prior deletion of message9709 was acknowledged17September
11:37:21.849UTC, with no author ban or parent deletion. The controller's latest
public recheck returned the group/View Post landing without message text,
consistent with that acknowledged deletion; it is not independent proof of
every client's current rendered state. No fresh report identifying another
post has been established. If one arrives, obtain its exact link/message ID.
Do not infer a new target or repeat the acknowledged deletion.
