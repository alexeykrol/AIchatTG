# Exact approval — advertising primary policy 2.4.43

Historical card, execution date expired. The owner's subsequent push/deploy
request was received after the23SeptemberUTC activation boundary. No push,
deployment or lease ran. See the [new24September card](2026-09-24-advertising-primary-approval.md).
The original scope below is preserved, not reusable execution authority.

Decision pending. Candidate lifecycle: **`prepared`**.
The previous Review release and historical moderation operation are complete;
their consumed approvals are not reused here.

## Proposed action

Push exact source `b891abfde3c176d389ab0cd19d3be9509405974d` on
`codex/advertising-policy-20260923` and the accompanying docs-only main tip named
in the approval message to the existing private origin, without force.
Deploy only `aichattg-telegram-runtime` from that exact Git archive on the
existing registered VPS. Public component becomes 2.4.43 / 2026-09-23.
Do not recreate Console3.4.0 or change another project's service.

One activation, at most one rollback, one root remote writer/master and a
60-minute lease issued only after exact approval and successful preflight.
Activation must be on 23 September UTC; if that date passes, refreeze the
release date/source and present the changed exact candidate before deployment.

## Included and excluded effects

The primary safety prompt explicitly recognizes unsolicited/covert advertising
without requiring a link, price or bot flag. The existing code-owned validated
spam → delete + author ban protocol stays in force for new incoming judgements
in the currently configured Moderator chats. Recognition remains semantic, not
a regex or Review shortcut. All sanctions, exceptions and failure handling stay
in deterministic code. The repair also prevents a skipped ban being reported
as fully completed just because deletion succeeded.

Existing model/provider/call count/quotas are unchanged. Added recognition text
can increase input tokens in the already metered safety calls; that source
effect is included in this proposed approval. No paid evaluation, new paid
resource, quota increase, model switch or extra diagnostic model calls.

Keep current runtime config, secrets, webhook routes, database/schema, knowledge,
Review binding/data/mounts/flags, existing alerts and Console unchanged. No
manual Telegram sends, new historical ban/deletion, replay, reclassification,
receipt rewriting, migration, rebind, import, Gatekeeper or News operation.
In particular, never repeat completed actions for9770 or9709.

## Baseline, evidence and verification

Last verified production 23 September 23:10 UTC: both services exact
`8a2b27fb215a19d26cf35b6244dcd4151b7cac4d`, healthy/restart0;
Assistant2.4.42/Console3.4.0, Review live, leases/master closed.
Current runtime image and rollback:
`sha256:81e4e7281b152b5ec5bb3136e7eaecfab8ee5ba3a7a9563712ef6282f091fcb7`.

`passed`: 1512 local tests/5 fixture skips, migration9/9, scenario30/34,
exact clean source guard, independent assurance125/125. Actual model recognition
is `not_run`; mock-label tests are not semantic-accuracy proof. Exact candidate
image/deployment/live checks are also `not_run`.
[Candidate report](../reports/2026-09-23-advertising-primary-candidate.md).

Before activation, refresh baseline/ownership/config/schema and stop on drift;
build an immutable exact-source image, verify all source hashes, release label,
rendered2.4.43 footer and actual composed config using the real config loader
with networking disabled. Check active Review owner/socket behavior for a
runtime-only recreation without deleting stale-owner evidence to force startup.

After activation verify exact image/source, repeated health/restart checks,
unchanged config/schema/Console/Review binding and live status, HTTPS/auth,
unchanged webhook routes/status and rendered footer. No synthetic case or
Telegram publication; empty Review counters do not establish delivery E2E.

## Stop and rollback

Stop on auth/transport loss, unexpected configuration/schema/binding/ownership
drift, wrong source/footer, unhealthy service, Review IPC failure or loss of
primary safety. No authentication retry or fresh-connection fallback.

At most one rollback restores the exact current8a runtime image and unchanged
configuration, preserving all runtime/Review data and operation evidence. It
removes the new recognition supplement and completion-receipt correction;
it cannot undo a ban/deletion already performed during normal moderation.
No database restoration, unban or message restoration is included.

Safe default until approval: keep the prepared candidate local, leave current
production unchanged, perform no additional paid or external actions.
