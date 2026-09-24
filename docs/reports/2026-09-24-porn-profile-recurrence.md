# Short profile solicitation recurrence — 24 September 2026

**Later checkpoint14:04UTC:** the exact conditional card was approved, but real
acceptance failed on case3 (`threat_evidence_not_verbatim`); two porn inputs
passed,17remaining not_run. No push/deploy. The additional advertisement9809
was separately deleted and its author banned. See
[closed execution](2026-09-24-advertising-live-acceptance-stop.md).
The preparation statements below are historical, not the current test status.

Lifecycle: `prepared`. Exact candidate
`d8e5583eb7eef51659d627ed478e0cced3ae391c`, branch
`codex/porn-profile-policy-v2-20260924`, component 2.4.44 / 2026-09-24.
This is not a deployment or a successful real-model evaluation.

## Confirmed incident

The owner reported another missed pornographic advertisement after 2.4.43.
Bounded read-only checks at 06:25–06:29 UTC found the new short profile
invitation intact in the Moderator snapshot. The actual model returned
`clean` (confidence 0.93), the job resolved with provider boundary `returned`,
and the accepted deterministic plan was `none`. The enforcement receipt was
`skipped / clean`, with no ban or delete attempted. There was no exemption,
validator error, pending retry or failed sanction for this event.

This establishes a semantic false negative against the owner's reported
solicitation. It does not establish the unseen profile's contents or the
model's internal reasoning. Private source text and immutable author identity
remain only in ignored, mode-0600 incident evidence; they are not fixtures.

Production was still exact `ccea9af5652250c159169c986f7e531ee1ac1522`,
2.4.43, image
`sha256:203c512895a1fd1c12137695d34678b5592c06dabb3d857160e3d599fe193d97`.
Runtime and unchanged Console 3.4.0 were healthy with zero restarts. Runtime
started 05:26:16.674829016 UTC. Moderator webhook returned HTTP200, pending0,
no last error. Running safety and both supplement hashes matched the source.
No production, configuration, database, Telegram or provider mutation was
performed; the diagnostic SSH master was closed and socket absence checked.

## Repair and limits

The previous positive reference examples all contained explicit adult/sexual
cues. They did not cover a minimal profile invitation whose flirtatious bait
is expressed by kisses/hearts. Passing those injected-label tests never proved
real recognition of such inputs.

The preserved-version v2 supplement makes that combined communicative act
explicit without requiring a URL or adult marker. Missing context, unfamiliar
language, a profile reference or affectionate emoji alone are not spam rules.
Study, portfolio, design, family-photo, report and translation purposes remain
negative controls. The old v1 artifact and corpus remain available.

Model/vendor/effort, output schema, stage limits, evidence validation, warning
rules, protected-author checks, no-retry fences and deterministic enforcement
are unchanged. There is no regex ban, new model call, replay of existing jobs,
database migration or Review change. Runtime source delta is only the new
supplement, its selected version/heading and public release metadata.

## Evidence

- `passed`: full local suite, **1,528 passed / 5 explicit fixture skips**.
- `passed`: migration regressions 9/9; scenario 30 machine / 34 human entries;
  infrastructure isolation and whitespace checks.
- `passed`: exact clean detached source guard against current production,
  including component advance 2.4.43 → 2.4.44.
- `passed`: independent read-only review and 90/90 policy tests.
- `not_run`: real-model recognition, multilingual accuracy, live sanctions,
  new image build, push and production deployment.
- `inconclusive`: whether the proposed v2 wording solves the actual model miss
  until the separately authorized live evaluation succeeds.

The 14 additional synthetic contrast cases (6positive,8negative) are contract fixtures, not measured
precision/recall. A bounded real-provider test (maximum 30 calls / USD2 /
30 minutes, no Telegram or production writes) was requested, not authorized
or executed at this checkpoint.

Private evidence SHA-256 (files under ignored `output/porn-recurrence-20260924`):

- recent.json: `27a07716de74756b093c9f73a578bb97e93cf291ef69ce6673d8f6918a3b8393`
- detail.json: `7e3a6a4d355450cbd00248444d4ea2234f91c8aa78c7aa991767ce032bf50d04`
- trace.json: `50879891927831a747043752bbfd771c26bc68ab5094b444294d10d161b2463d`

## Next gate

Run the bounded actual-provider evaluation only after approval, preserving
exact candidate prompts, production model tuple, strict validation, cost
reservation and no retries. Stop on technical failure, a missed positive or
a false-positive negative control. Never call injected labels recognition.

Push/deployment needs approval naming the candidate above, runtime-only scope,
unchanged Console/config/data/webhooks/Review and verified baseline. Activation
must follow successful live evaluation and fresh baseline/source/image checks.
Failure recovery: identity-verified runtime stop, preserve all data, then a
separately tested forward repair; no blind database restore or old-protocol
downgrade. Deployment does not retroactively moderate the accepted old message.
Any one-off historical delete/ban must have separate exact-target authority,
fresh protected-author/right checks and no replay of prior completed actions.

### Later11:05–11:10UTC update

The owner separately requested immediate removal of two current advertisements.
Fresh diagnosis matched the original9780 and new9799; both were deleted and
their exact authors permanently banned, without replay or a source deployment.
See [separate action receipt](2026-09-24-two-porn-posts-enforcement.md).
The candidate remains unchanged and the paid-test/conditional-release decision
is [proposed, not approved](../proposals/2026-09-24-porn-profile-approval.md).
