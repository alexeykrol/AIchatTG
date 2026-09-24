# Advertising release 2.4.43 — date-only refreeze

Historical preparation evidence. After fresh exact approval, this candidate
was pushed and deployed24September05:26UTC; current lifecycle is
**`production-verified`**. [Deployment receipt](2026-09-24-advertising-2.4.43-deployment.md).
The not_run states below describe the earlier preparation checkpoint.

Prepared exact source:
`ccea9af5652250c159169c986f7e531ee1ac1522`, branch
`codex/advertising-policy-20260924`, integrated into local main.
Public component: **2.4.43 / 2026-09-24**. Not pushed or deployed.

## Why the requested deployment did not start

The owner said «давай, пуш и деплой» in response to sourceb891abf and docs8a517ba.
Before external action, the clock returned **2026-09-24 05:07:52 UTC**
(still23September in the owner's America/Los_Angeles timezone).
The linked approval explicitly required activation on23SeptemberUTC and a
date/source refreeze with changed exact approval if that day had passed.
No production lease was issued; no SSH connection, push or deployment ran.

Root prepared the permitted local date correction, preserving the earlier
candidate and its evidence. The unchanged semantic/enforcement scope is in the
[original candidate report](2026-09-23-advertising-primary-candidate.md).

## Exact delta and checks

Compared with b891abf, the only non-document changes are `releasedOn` in
`assistant-release.json` and its two exact test expectations. Version remains
2.4.43 because neither candidate has shipped. No policy, runtime action,
provider, schema, dependency, configuration, Review, Console or route change.

- `passed`: repeated full Node20.20.0 suite1512passed/5fixture skips/0failures.
- `passed`: repeated migration9/9 and scenario30machine/34human checks.
- `passed`: clean exact source guard against production source8a2b27f;
  version2.4.42 →2.4.43 and planned date2026-09-24.
- `passed`: runtime/safety-router/advertising-policy SHA256 unchanged from the
  original independently reviewed candidate. No invalidated logic assurance.
- `passed`: controller independently compared exactccea9af againstb891abf in
  apps/packages/infra/scripts and confirmed only the date and two assertions.
- `not_run`: actual model recognition, new candidate image build, current live
  baseline refresh, deployment and production verification. Mocked recognition
  tests remain contract evidence only. No paid or Telegram calls.

Ignored evidence: `output/advertising-policy-20260924/` contains the full suite,
migration, scenario and source-guard logs. Full-suite log SHA256:
`105f3354e1420997df1cf1eaae30c55b79cd791145818d4edd83b6eb66cb1ba7`.

Last production verification remains23September23:10UTC: exact8a source,
Assistant2.4.42/Console3.4.0, both healthy/restart0, Reviewlive. This is a dated
baseline, not a new live check. All old leases are closed; completed actions for
9770 and9709 are not repeated. The new source requires the
[24September exact release decision](../proposals/2026-09-24-advertising-primary-approval.md).
