# Suspected porn-spam — exact runtime candidate

Current lifecycle: `production-verified`. Source
`a41518f4a4fd105cf19e7fc1a64fd35b77233084` was pushed and deployed at04:32:23UTC
on2026-09-16. [Deployment and closed lease](2026-09-16-porn-spam-policy-deployment.md).
The remaining text preserves the earlier pre-approval candidate checkpoint;
its pending/not-run deployment statements are historical, not current status.

## Requested outcome and source

The owner requested immediate ban and cleanup for suspected pornographic
spam/profile solicitation, including varied wording, without warnings or a
manual-review wait, then requested deployment/activation. See the attributed
quotes and scope in [Owner Feedback](../OWNER_FEEDBACK_LOG.md).
The exact release/risk decision below is still pending; no lease is active.

Only three runtime source paths differ from current production335a35a:

- `apps/telegram-runtime/src/safety-artifacts/porn-spam-policy-v1.md`: versioned
  semantic supplement under existing `spam_or_scam`. Grounds for suspicion
  suffice; no exact string, identity, bot attribution, repetition or high
  confidence required. Genuine reports and educational quotations are not
  themselves solicitation; promotional quotation pretexts are not exemptions.
- `apps/telegram-runtime/src/safety-v3.mjs`: load supplement last and record
  its SHA-256 alongside existing artifact hashes.
- `apps/telegram-runtime/src/assistant-release.json`: component2.4.38,
  planned2026-09-16, required by the shared-source release guard. Assistant
  body behavior is unchanged; footer becomes `Версия 2.4.38 от 16.09.2026`.

No classifier schema, provider/model/effort/output limit, runtime action path,
Guard, database, configuration, routes, dependencies or migration changes.
The supplemental text lengthens the prompt of existing paid moderation calls;
input cost can increase. No additional call/stage, paid test, quota increase or
new provider is introduced. Existing requests remain under existing limits.

Worker policy SHA-256:
`3d7cdbcc8323c406fe9b5e1f79dc9b48575b1c1e25d1e959319824912324ee9e`.
Synthetic corpus SHA-256:
`c77a6270aa7da02d952a4c6f2eb59059d21bf8da4ddf322f58d5c260cd4bf632`.
Both canonical copies equal the frozen worker artifacts; other worker files
remain unchanged. Root owns executable tests and release integration.

## Fresh baseline — read-only

Verified2026-09-16T04:08:03UTC via one key-only `news-vps` master, closed after
the read; socket absence checked. Only named AIchatTG containers inspected.

- Runtime source `335a35ad344706062a292581db4d27c5776c4302`, Assistant2.4.37;
  image `sha256:6c94e20ead5b17f4d50c82447d65d20f70d180df0ec8e222d29e8a73669a8b30`.
- Runtime container `2ced0e9713f5ad49fa156b7f0ef8e29ee38654b006a2dbccf652349ea95e60b8`,
  StartedAt2026-09-15T21:01:48.806052837Z, healthy/restart0.
- Console3.2.0 source `f650fe87cabf5cf498a64d48907f7a924861cfd2`,
  image `sha256:6f76808829b1c0e4bc2544330f23fadd3f529e2991e98ce3bd1cac6a811af1e9`,
  same container/start as deployment receipt, healthy/restart0.
- Runtime live mode, ingress enabled; existing three-chat Moderator allowlist
  and Assistant allowlist retained. Exact IDs are in the private local receipt.
  No new chats. No live ban/delete, provider call, log read or data query was run.

## Verification

`passed`: Node20.20.0 full suite **951 total,946 passed,5 fixture skips,0 failed**:
Gatekeeper132; runtime457=452passed+5skips; core114; knowledge4; infra3;
release61; log safety4; acceptance17; Console159.
Additional migration-safety9/9, scenario30machine/34human, isolation and whitespace.
Exact clean-source comparison against335a35a passed;2.4.38 >2.4.37.

New40-case test count includes36 labelled synthetic corpus replays,18positive/
18negative, plus four contract/metadata tests. Expected model outputs are injected:
this is **not semantic recognition, precision or recall evidence**. The integrated
runtime test sends a valid low-confidence spam verdict through real local
judgement/enforcement persistence, fake Guard/Telegram, and proves one router
call, immediate ban+delete, no warning/strike and no duplicate action. Separate
contract tests cover confidence0,0.35,1. Independent read-only review accepted
policy, loader/hash, tests and action boundaries with the limitations below.

`not_run`: real model evaluation, multilingual accuracy, live detection or
sanctions, valid Telegram/webhook smoke, production build/deploy, data replay.

Known limits: native blockquote/code/forward/reply metadata is not supplied to
the model. Textual report intent can be evaluated, but formatting-only quotation
cannot be guaranteed distinct. Existing default hard-link policy may still ban
a URL-containing report even after a clean model verdict. This release does not
alter that policy. Invalid provider results, unknown outcomes or unavailable
Guard rights still stop enforcement; no-review applies to a valid spam verdict,
not an instruction to bypass operational safety.

## One exact release decision

Approve pushing reviewed canonical history and building/recreating **only**
`aichattg-telegram-runtime` from exacta41518f, preserving current config and
the same three chats. This activates the supplement for subsequently processed
live messages; no explicit replay/backfill or real-person ban test is included.
Console3.2.0 is not recreated. Local private Review3.3.0, capture, notifications,
Gatekeeper, News and both unresolved bridge decisions remain excluded.

An accepted spam verdict uses existing `ban_purge`: at most100 oldest eligible
locally known same-chat/author messages plus current, deduplicated (max101),
not full history. Other known messages from that author can be removed too.
Already deleted/calling/uncertain targets are excluded. Missing sender ID does
not justify inventing an account or another chat.

After approval root issues a fresh exact30-minute lease, one forward runtime
recreation and at most one rollback to335a35a on verified application failure.
Check fresh source/image/config baseline before mutation; stop on drift or
transport/auth failure, without reconnect loops. Verify exact image/source
hashes, healthy/restart0, unchanged env/schema/routes/mounts/Console, public
health/auth and offline loaded supplement/footer in the deployed image.
No new paid or Telegram-message test is part of verification.

Rollback restores prior code with current data preserved; **it cannot restore
deleted Telegram messages and does not automatically unban users**. No database
restore, compensation or broad cleanup is authorized. Safe default pending
decision: leave335a35a running unchanged, with no open SSH master or release lease.

## Retained local receipts

Ignored `output/porn-spam-policy-v1/`; no raw transcripts/private specimens in Git.

- Full tests: `04201e198371037b09c0219a557cff780bec09676ad669f4d1bfd377032f9398`.
- Migration tests: `bdd01bd612577245c03a53aafe75d7946ccae4287779e72ab10aa5b523fc9102`.
- Read-only preflight: `d4aa455534e2b5ffddf0de211c5bd2fff555069bf4f140a029a913f267ab36e3`.
- Source guard: `35b155d3542e9615be47fea384d82c176a9b145b6ff2934e66af68756de8337d`.
