# Review activation attempt — guarded rollback

Candidate lifecycle: `pushed` (not deployed / not production-verified).
Exact source: `7d99ae00533bbf5afe1225510bdb5ed489c8cd2b`, Assistant2.4.40 /
Console3.4.0. Root was the sole remote writer. PO confirmed the proposed exact
activation; lease `review-7d99ae0-20260917` was issued11:36:51UTC and closed
11:51:31UTC. SSH master/socket closure verified11:51:52UTC. Do not reuse it.

## Actual outcome

- `passed`: one separately authorized deletion of comment9709 in the existing
  chat, Telegram acknowledged11:37:21.849UTC. Parent9690 and author untouched;
  no ban or repeat deletion. Independent public browser refresh confirmed the
  comment was absent. This action is irreversible and already consumed.
- `passed`: exact source archive, Linux/x64 Node20.20.0 builds,58runtime and
  43Console deployed-image source hashes, rendered Assistant2.4.40 footer and
  Console3.4.0 identity. Prior full suite1427passed/5fixture-skips/0failed and
  migration9/9 remain source evidence, not live acceptance.
- `passed`: unchanged original environment, approved additional mounts,
  routes/security/health configuration and baseline rollback compatibility.
- `passed`: fresh schema-v2 Review store provisioned once, collection/sender
  not started. Frozen forward-only boundary2026-09-17T11:48:07.284Z.
- `failed`: Console activation11:48:24.569UTC; stability gate stopped the
  operation11:48:29UTC. Runtime was never recreated.
- `passed`: exact Console3.2.0 rollback11:48:36UTC; runtime2.4.39 untouched.
  Final11:51:31UTC both healthy/restart0; schema, drafts, original environment,
  mounts, routes and logging preserved. Public HTTPS health200/auth401 passed.
- `passed`: retained Review database integrity, zero cases/observations/events/
  alerts, no owner and empty IPC directory; private binding preserved unchanged.
- `not_run`: live capture → private notification → Admin decision/erasure test.
  No synthetic production post, paid call, history replay or new sanction.
- `inconclusive`: production browser visual verification: the in-app browser
  returned `ERR_BLOCKED_BY_CLIENT` before loading the page; no bypass attempted.

## Confirmed cause and correction

The integrator's deployment helper used a millisecond timestamp for
`OPERATOR_CONSOLE_RELEASED_AT`. The existing application contract accepts only
UTC seconds (`YYYY-MM-DDTHH:MM:SSZ`). The exception occurs before HTTP/Review
bootstrap. This was a deployment-helper error, not a demonstrated source defect.

The exact VPS candidate image reproduced rejection of the supplied timestamp
and accepted the seconds-only form. A local regression also passed2/2. Image
hash/import tests had not exercised the exact generated production environment.
Before another recreation, validate the complete composed environment with
`loadOperatorConsoleConfig` inside the exact image. Keep Review's separate
millisecond start-boundary contract unchanged.

One same-source retry was requested from the PO; approval is pending at this
checkpoint. A fresh lease/baseline is required; do not reuse the consumed
activation fence, reprovision the retained store, replay history or delete9709
again. Preserve original failed-operation evidence.

## Identities and evidence

- Baseline runtime source2c72e01, image
  `sha256:7fc9a7e61fde4efeca2bc5c3f28a91b6078cb6aadaad0ce1f09a4f505ab36748`.
- Baseline Console sourcef650fe8, image
  `sha256:6f76808829b1c0e4bc2544330f23fadd3f529e2991e98ce3bd1cac6a811af1e9`.
- Built runtime image
  `sha256:20aa9bc3cc6be9967bfc965eb12510f6d8b69a2374c99d07b23d79cb061734a6`.
- Built Console image
  `sha256:66769594e752dd3a3e0f11bd1f552c2efebb1296cbf3c9e03070daf03b9c195a`.
- Source archive SHA256
  `7e4f08e0c5cee9d75a97dace3619202f27be0722da5c93483e98004d163527c3`.
- Ignored local `output/review-activation-7d99ae0/receipts.json` SHA256
  `ca97f8128eede529f246b95ff0818c945b8d29b45f24cbdb2ce916deb2f93199`.
- Ignored local `delete-receipt.json` SHA256
  `8e3e85e8a4bcb7b225a48b276d79147d5dc9bcb9a0a3b55809b33b4d87dd4d6a`.
- Private binding SHA256
  `c48f4370dd4ca80b6f9d51cc9846ebef9ad1fce91fe749fc3a4e6d1fe8119b83`.

Private recipient/config, credentials, production data and raw transcripts are
not committed. The new Review files remain private on the server for controlled
continuation; nothing was deleted or silently reset.
