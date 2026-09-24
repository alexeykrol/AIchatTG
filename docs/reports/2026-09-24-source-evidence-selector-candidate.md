# Code-owned source evidence — candidate2.4.45

Lifecycle: `prepared`. Exact source
`c019a35a93ba46ebdf449e81b156a6043843b531`, branch
`codex/moderator-evidence-selector-20260924`, planned24September2026.
Not pushed, not deployed; no real-provider evaluation of this source yet.

## What changed

The preceding actual evaluation [stopped on a non-verbatim quote](2026-09-24-advertising-live-acceptance-stop.md).
The new provider wire contract asks for IDs of code-derived source excerpts,
not model-written quotations. Its strict schema contains only IDs actually
offered in the current request; no private source text is placed in a schema.
Excerpt text remains in the user payload alongside the original message.
The per-call catalogue cannot be changed by message text or another concurrent
request. Code resolves IDs to original slices without translation, trimming or
Unicode normalization, then invokes the unchanged canonical semantic validator.
The existing provider adapter still owns its pre-existing outer input trim.

The selector instruction is last, after recognition supplements, so later
literal-quote wording cannot override the wire rule. The frozen2.4.44 profile
recognition policy remains included. The router wire name, catalogue digest,
selector-policy digest and schema digest distinguish the new protocol from old
verbatim traces. No model-selected action fields are accepted.

There is no new call, retry, model, threshold, punishment or exemption. Existing
warning, protected-author, idempotency/revision and deterministic deletion/ban
paths are unchanged. Canonical traces still contain literal evidence, not IDs.
Console production code, database/migrations, Review, env/secrets and webhooks
are unchanged. The shared-runtime public footer advances to2.4.45.

## Bounds and honest limits

Each excerpt is at most240 UTF-16 units with grapheme-safe boundaries. At most
128excerpts and65,536 serialized catalogue bytes are admitted. Overlapping
windows cover original content; whitespace-only windows advance coverage but
are not evidence. All original text is sent unchanged. Fine word/2–4word
options are interleaved and bounded, with omissions explicitly recorded.

This is not a guarantee that every possible meaningful short span is offered.
If the source cannot fit mandatory coverage, has malformed Unicode or a single
unrepresentable grapheme, classification fails before a provider call. The
existing60,000-character maximum is not a promise that every such input fits
the new catalogue; the tested60,000-character case explicitly fails rather
than truncating. Normal4,096-character coverage and padding resistance passed.
Very unusual grapheme/cap cases remain an explicit availability limitation.

The catalogue increases input tokens per ordinary moderation request, without
changing the fixed model, stage output limits or call count. It uses the same
message content and provider, not a new data destination. A bounded real-model
evaluation must still establish recognition and false-positive behaviour; IDs
prevent rewriting a selected quote but cannot make a wrong classification true.

## Evidence

- `passed`: full Node20.20.0 suite **1,542 passed /5 explicit fixture skips**,
  zero failures; scoped worker checks207/207.
- `passed`:9 new selector tests: Unicode/whitespace, full ordinary input,
  cross-window cue, before-call caps, exact ID schema, unknown/duplicate/raw IDs,
  concurrent/injection isolation, independent dual evidence and unchanged
  overlap/action guards.
- `passed`: independent review found two implementation defects before freeze:
  contradictory prompt order and blank-window padding rejection. Both repaired
  and covered by regressions. No claim that these were production defects.
- `passed`: controller final review of exactc019a35, independent113/113 selector,
  canonical safety and advertising/porn policy tests, zero skips/failures; no
  remaining blocker in the reviewed scope. This is not production authority.
- `passed`: migration-bundle verifier3/3; Gatekeeper scenario30machine/34human;
  whitespace/isolation and clean detached exact-source/version guard against
  currentproductionccea9af (2.4.43→2.4.45).
- `not_run`: actual-model evaluation ofc019a35, new image build, push, deployment,
  automatic live Telegram sanctions for this source.

Current production remains2.4.43/runtimeccea9af and Console3.4.0/8a2b27f,
last checked healthy/restart0 at14:04UTC. All three identified current ads have
already been removed under separate exact actions, with their authors banned.
They must not be replayed by this candidate or its evaluation.
Independent native inspection14:25UTC found9809 still absent and only ordinary
latest discussion in the visible viewport. It was not a full-history audit and
made no native mutation.
