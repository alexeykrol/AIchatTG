# Primary advertising recognition and enforcement completion

Candidate lifecycle: **`prepared`**. Exact source:
`b891abfde3c176d389ab0cd19d3be9509405974d`, branch
`codex/advertising-policy-20260923`, integrated into local main.
Public shared-runtime component: **2.4.43 / 2026-09-23**.
Not pushed or deployed. Console stays 3.4.0 at the existing source.

## Owner requirement and confirmed causes

The owner requires the full advertising protocol: remove the advertising post
and ban its author. The later clarification, «все регламенты - это по сути код,
а не решение модели», makes the architecture boundary explicit: models
classify meaning and supply verifiable evidence; deterministic, versioned code
selects the sanction, warnings, exceptions and failure behavior.

The reported historical message received a clean primary classification.
Unsolicited promotion already belonged to `spam_or_scam`, but covert testimonial
recognition was specialized only in the auxiliary Review detector. This is a
recognition gap, not absence of the existing code-owned `ban_purge` protocol.

An independent latent defect also allowed a definitively skipped ban followed
by successful deletion to report completed enforcement. It did not cause the
historical clean verdict. Three focused regressions reproduced this false
completion before the repair.

The old post and author were already handled by a separate completed one-off
operation. [Receipt](2026-09-23-advertising-post-9770-enforcement.md).
Do not repeat it or replay historical judgements.

## Exact source effects

- Load and fingerprint a dedicated advertising recognition supplement in the
  existing safety router. No new type, model, provider, output field, request
  stage, confidence threshold, parent context or additional model call.
- Preserve legitimate requested recommendations, substantive product
  discussion, negative reviews, reports and quotations. A Review flag, keyword,
  book mention, missing context or unproved bot identity is not a spam verdict.
- Keep the existing code mapping from validated `spam_or_scam` to immediate
  `ban_purge`; model-selected action fields remain rejected. Protected-author
  checks, strike policy, uncertainty fences and fail-closed outcomes remain.
- Require confirmed ban plus all required deletions before recording completed
  enforcement. A definitive ban skip remains terminal `skipped` with its
  original reason and `ban_unconfirmed`; uncertainty has precedence. No replay
  or rewriting of old receipts.
- Advance the shared runtime's public footer to 2.4.43 / 23.09.2026. Approved
  Assistant answer bodies and footer delivery rules are unchanged.

No database schema, dependency, Compose, route, secret, webhook, Console,
Gatekeeper, Review binding/flags or News change. The new recognition text adds
input to existing safety calls; it can increase input-token usage, but does
not introduce an extra call, new model/resource or paid evaluation.

## Evidence

- `passed`: Node 20.20.0 full root suite, **1512 passed / 5 explicit fixture
  skips / 0 failures** (1517 tests total). Compared with the deployed gate,
  42 additional tests: 34 advertising contract cases and 8 completion cases.
- `passed`: migration regression **9/9**; Gatekeeper scenario validation
  **30 machine messages / 34 human entries**; whitespace/isolation checks.
- `passed`: exact clean source guard against current production source
  `8a2b27fb215a19d26cf35b6244dcd4151b7cac4d`, including 2.4.42 → 2.4.43 metadata.
- `passed`: independent read-only assurance **125/125**, no actionable findings;
  separate controller focused suites also passed with matching source hashes.
- `passed`: injected positive/non-bot classification executes one ban and
  deletion; failure cases stay manual-review/no sanction/no retry. Completion
  tests use the real runtime, Guard and durable store with offline transports,
  including missing author, sender chat, rights, uncertainty and restart.
- `not_run`: actual model recognition, precision/recall and false-positive rate.
  The 24 synthetic labels (12 positive / 12 negative) are injected expectations,
  not predictions. The corpus explicitly retains `evaluationStatus: not_run`.
- `not_run`: candidate Linux image build, deployment and live verification.
  No paid calls, new SSH connection or external Telegram action in preparation.

Ignored evidence: `output/advertising-policy-20260923/` contains
`full-test.log`, `migration-regression.log`, `scenario-check.log` and
`source-guard.log`. Full-suite log SHA256:
`51553ae0d8cab1a0d217766453b7edc6ac7267b1e35cc569ce9abcbd3d0537bf`.

Source file SHA256:

- runtime: `f88ff5e0d11b021fcd25b612d6ea010dbfdca19215ecbf6f19dfc469f448de07`;
- safety router: `6da905c4c9445a004eb5d86fc52e9855fe2572dcf44a6b53cbeacf2f4f237048`;
- advertising policy: `c5aafc08fb4f85ba80bd31bb1256bd564804894107ed187651dc4e891d701a80`.

## Production boundary and next action

Last verified 23 September 23:10 UTC: both services still exact8a source,
healthy/restart0, Assistant2.4.42 and Console3.4.0; Review live. All prior
release/one-off leases and SSH masters are closed. Their approvals are not a
lease for this new source. Runtime rollback image:
`sha256:81e4e7281b152b5ec5bb3136e7eaecfab8ee5ba3a7a9563712ef6282f091fcb7`.

Next external action requires the [exact runtime-only release decision](../proposals/2026-09-23-advertising-primary-approval.md).
No universal recognition guarantee or new production-verified claim follows
from local gates. The separate real Review notification E2E remains not_run.
