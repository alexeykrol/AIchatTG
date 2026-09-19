# Assistant 2.4.41 — safety contract alignment candidate

Lifecycle: `prepared`. Planned public release date: 2026-09-19.
This record describes source acceptance, not deployment or live-model acceptance.

## Request and scope

The Product Owner reported an operational fallback instead of the approved
irrelevant-question response, then a correct response on a later question, and
explicitly requested investigation, repair and deployment. Preserve the approved
scenario text; repair the upstream contract, not the text or safety policy.

The isolated release is based on exact running source
`2c72e01cb28452c640c033c91a2060a8eca57201` (Assistant 2.4.39).
It excludes pending Review source `7d99ae0` / Assistant 2.4.40 and does not
activate Review or change Console 3.2.0 (`f650fe8`). Version 2.4.41 avoids
reusing the already allocated 2.4.40 identity.

## Diagnosis and change

- Production evidence confirmed two `provider_safety_router_invalid` outcomes
  before content routing, with one delivered fallback per native message.
  Historical rejected fields and finish metadata were not retained, so the
  exact historical invalid field remains **inconclusive**.
- The prompt did not explicitly explain that an otherwise clean question
  addressed to the Assistant must have `target=none`. A clean verdict with
  `target=assistant` reproduces rejection locally; this is not proof that the
  historical model returned that field. The clarified target/context rules
  now match the existing validator.
- Both existing safety stages request strict closed JSON schemas; no model,
  reasoning effort, output budget, stage count or retry policy changes.
  Refusal, incomplete/filtered/unknown completion and malformed output fail
  closed. Cross-field meaning and verbatim evidence remain locally validated.
- Exact allowlisted rejection categories, completion flags and numeric usage
  metadata are persisted in the existing judgement `result_json` column.
  No prompt, returned text, credentials, request IDs or arbitrary provider
  values are added. Diagnostic tokens describe the failed stage, not total
  spend across both safety stages. No migration or schema change is required.
- Domain-no-signal uses the existing byte-exact approved response. No change
  to that copy, knowledge, domains, sanctions, delivery fences or dialogue.

Strict Structured Outputs and local validation serve different purposes:
[official guide](https://developers.openai.com/api/docs/guides/structured-outputs).
Documented API/model support is not a live endpoint acceptance test.

## Evidence

- `passed`: Node 20.20.0 root suite **1164 passed, 5 explicit skips, 0 failed**;
  migration fixtures **9/9**; isolation and whitespace checks.
- `passed`: new real-runtime/fake-provider scenarios cover raw suffix ask,
  both webhook orders, help repetition, invalid safety followed by a new
  native question, redelivery/restart once-only behavior and valid threats/
  abuse. Existing routing, reply-to-hint, cleanup and analyzer suites also pass.
- `passed`: diagnostic persistence strips unexpected data, preserves lease
  fencing, remains terminal/nonretryable, and leaves schema unchanged.
- `passed`: independent differential parser replay, **4636 cases**, preserves
  previous acceptance/results; no weakening or source-copy changes found.
- `not_run`: additional paid calls, synthetic production questions, real-model
  schema acceptance/classification quality, live sanctions.
- `inconclusive`: exact rejected historical field and the later normal reply
  reported by the owner; the bounded retained records did not establish it.

## Release and rollback boundary

Root is the sole remote owner. Deploy only an exact committed archive/image;
preserve environment bytes, mounts, routes, schema, knowledge and Console.
One runtime activation and at most one rollback to the exact 2.4.39 image
`sha256:7fc9a7e61fde4efeca2bc5c3f28a91b6078cb6aadaad0ce1f09a4f505ab36748`
are the intended bounded lease. Rollback retains all data, performs no inverse
migration and cannot undo already delivered replies or existing live sanctions.
Do not roll back to older pre-ask-protocol binaries. Any real paid acceptance,
Review activation, configuration/secret/webhook or database change is excluded.
