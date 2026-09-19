# Private Review retry — safety-preserving local candidate

Lifecycle: **`prepared`**. Exact candidate:
`ebf0a8acd62974a49f0b99149709bcab196d8394`.
Local ref: `codex/review-retry-20260919`.
Components: Assistant **2.4.42**, planned2026-09-19; Console **3.4.0**.
Not pushed, deployed or newly approved for production in this preparation.
If release occurs on another date, update the planned date and refreeze/retest
the exact candidate before approval rather than claiming a19September release.

## Scope and baseline

This continues the already queued Review preparation after the Assistant
follow-up. The Moderator controller requested safe local continuation only;
it supplied no new production, SSH, notification, spending or deletion approval.
Root remains the shared-source owner; one bounded subagent reviewed the source
and added only a synthetic retained-store regression.

Last production verification in this thread,19.09 22:34UTC:

- Runtime e52348537f0445f285487a957e0b43f47bd0018d / Assistant2.4.41,
  image `sha256:dc7585b68a99929c0ce88314fe71f86b46b3b24ef2973c8bdcd8c7df63416bf5`.
- Console f650fe87cabf5cf498a64d48907f7a924861cfd2 /3.2.0,
  image `sha256:6f76808829b1c0e4bc2544330f23fadd3f529e2991e98ce3bd1cac6a811af1e9`.
- Both were healthy/restart0. No new remote verification was performed for
  this local preparation; refresh the baseline before a future approved run.

The old7d99ae0/2.4.40 retry and rollback to2c72e01/2.4.39 are superseded:
they must not remove the newer safety response-contract repair.

## Candidate changes and preservation

Main already contained the accepted Review implementation plus the integrated
safety repair. This continuation advances public Assistant metadata to2.4.42,
updates its exact footer fixture, adds two canonical regressions and corrects
the activation/rollback procedure. No new Review behavior or safety bypass.

`passed`: e523485 is an ancestor. Eight critical files match the deployed
baseline byte-for-byte: provider adapter, safety validator, safety prompt,
runtime judgement/answer flow, runtime database definition, approved Assistant
copy, domain routing and domain catalog loader. Runtime source changes versus
that baseline are the existing optional Review hooks/modules and release
metadata. Review store/config/projection/provision source is unchanged from
the earlier accepted Review candidate. No runtime schema change versus e523485.

The [updated procedure](../MODERATION_REVIEW_ACTIVATION.md) now:

- uses Assistant2.4.41/e523485 and Console3.2.0/f650fe8 as rollback baselines;
- validates the new Console release timestamp in seconds, separately from
  Review's millisecond boundary; includes the actual failed timestamp fixture;
- makes retained-store reopening the retry path and prohibits provisioning;
- preserves the exact binding/persisted policy rather than resetting its date;
- distinguishes original source dates from edit dates truthfully.

## Retained state and the remaining policy choice

The retained private binding fingerprint is
`c48f4370dd4ca80b6f9d51cc9846ebef9ad1fce91fe749fc3a4e6d1fe8119b83`;
its frozen startAt is **2026-09-17T11:48:07.284Z**. It is part of the stored
policy identity. Changing the boundary, IDs or persisted limits fails closed
even for an empty store; no supported in-place rebind exists.

A fresh activation approval must explicitly accept keeping that earlier
boundary. Only new deliveries are processed, with no automatic history replay,
but an eligible newly delivered event from the gap can enter Review. A genuine
edit uses edit_date and may be eligible even if its original predates the
boundary. Requiring a later cutoff needs a separately scoped transition; do
not obtain it by erasing, recreating or silently editing the retained state.

The earlier comment9709 deletion is complete and must never be repeated.

## Local evidence

- `passed`: final full Node20.20.0 suite **1452 passed /5 explicit skips /0 failed**
  (1457 total). Includes Console237/237 and runtime725/730 with5 fixture skips.
- `passed`: migration/import regression **9/9**; Gatekeeper scenario check
  **30 machine messages /34 human entries**.
- `passed`: retained-store focused suite **10/10**. New case rejects ten
  mutations of boundary/IDs/caps, preserves schema/rows/checkpoint/budget,
  binding digest and database inode, then reopens with the original policy.
- `passed`: actual Console config rejects the failed millisecond release form
  and accepts its seconds-only release form without changing the Review clock.
- `passed`: clean exact-source/version guard2.4.41→2.4.42, infrastructure
  isolation/Compose parsing, source ancestry/preservation and whitespace.
- `passed`: code-owned source footer is `Версия 2.4.42 от 19.09.2026`.
- Initial full run failed only because the public release fixture still
  expected2.4.41; that fixture was updated and the complete suite rerun.
- `not_run`: new exact-image build/config/footer validation, fresh production
  baseline/store checks, actual activation/rollback, browser and live Review
  capture→private notification→decision/erasure acceptance. Prior-version
  image tests are not evidence for this newly frozen source.

No SSH, production changes, private store reads, provider/Telegram calls,
reprovisioning or deletion occurred. Local fixture databases are synthetic.
Available transcripts were archived locally outside Git.

## Remaining gate

Before any production work: obtain fresh exact approval covering this SHA
(or a newly refrozen dated SHA), both services, the retained boundary/binding,
existing private recipient, shared Admin-credential access, capture/notification
limits, expiry and rollback. Push authority remains separate from this local
preparation. Under the approved scope, refresh baseline/state, prepare a new
bounded helper omitting provision/delete, build exact images and validate the
complete composed environment before recreation. Never reuse the old lease
or helper unchanged. Live synthetic posting/decision/erasure needs explicit
acceptance scope; otherwise those outcomes remain `not_run`.

Ignored local evidence: `output/review-candidate-20260919/`.

| Artifact | SHA-256 |
| --- | --- |
| `source.tar` | `a71f5e482b53562dcc3173d4e9f107d8f0fbc702413abc546849ba079f9250f3` |
| `full-suite-final.tap` | `1736836bde80d4c6c256e7750c5b19ed74b2d8e84b34ca2e20f46ad2666903da` |
| `migration-import.tap` | `2f530c79e0121b2ac7e2dc6da81e302f678a8f2d8f77bc52bd34508e18a9f876` |
| `source-guard.txt` | `b8acb485c1112d25f4522ea1f63e238955ce9d08eb17a96273602c1f5a6cd53a` |
| `source-preservation.json` | `e2ee498ea931ed65b02ab765b38c911a6d25194d78cda9a398342947dc9d69ba` |
