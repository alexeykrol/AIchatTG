# Routing-only candidate and comparison plan

## Scope and state

Lifecycle: **prepared**. Local only; no deployment, push, paid inference or
external action. Current production verification: **not_run**.

The Product Owner explicitly separated question understanding/domain selection
from domain answering. This follow-up changes only routing, its diagnostic
visibility and its comparison harness. Knowledge Markdown, retrieval sources,
answer policies and generation are frozen.

Follow-up base: `bcd60bfc6d51db4a04ccbf50084c9c2bc5546386`.
Original baseline: `909fad69daf2bed720de075ca2f2fecf9f19afed`.
The base candidate received changes requested, not integration acceptance.
The canonical integrator retains main, shared integration and release ownership.

## Repairs and diagnostic evidence

- R1: the exact compound question “Кто ты и можешь ли объяснить общие правила
  обучения?” is labelled in both assistant-self and operations. Real runtime,
  provider and analyzer boundaries with fake transport preserve both domains
  in router and analyzer-dispatch modes.
- R2: the dry local harness now consumes generic domain hints, not retired
  course-specific fields. The existing long value question remains a regression
  case. Transcript expectations distinguish missing domain knowledge from an
  unrecognized domain. Dry selections are explicitly fake plumbing evidence.
- Domain arbitration is a shared pure function used by runtime and evaluator.
- Existing receipt JSON gains bounded `routingDiagnosis`: registry digest,
  origin, validation status, raw validated choice, post-primacy domains, final
  domains, exact-example override, risk flags and controlled error codes.
  Analyzer fallback retains a bounded failed-attempt summary.
- No question, dialogue, answer, knowledge, raw invalid model text or model
  reasoning is added to this diagnostic object. Persistence, replay isolation
  and concurrent invocation isolation are tested. No database migration.
- Limitation: an unexpected crash that reaches the pre-existing uncertain
  receipt path does not durably preserve this diagnosis. It is not a pre-crash
  event journal. Existing unrelated logging policies are unchanged.

## Frozen comparison set

`docs/evaluation/routing-only-v1.json` contains 28 cases: four regressions and
24 independently authored held-out questions, including three contextual
follow-ups. Labels are reviewed proposals, not Product Owner-approved truth.
The set covers compounds, domain boundaries, unknown subjects, sharp but
legitimate questions, internal-instruction requests and synthetic privacy risk.

Screenshots prove bad displayed answers, not historical internal model choices.
The benchmark never invents those choices. Held-out questions are checked for
exact leakage against positive and negative index examples. This does not prove
semantic independence. Once used to tune the index, this set becomes regression
material and a fresh held-out set is needed.

The four lanes are baseline/candidate × router/analyzer-dispatch. Both candidates
receive the same question and dialogue, never the expected label or rationale.
Legacy baseline files are hash-pinned to the original baseline. Planned prompts
and exact serialized model inputs are checked against fake provider wire calls.

Scoring separates raw model and final rule-adjusted domain-set accuracy, false
refusals, dropped compound parts, false abuse selections and invalid outputs.
Invalid attempted outputs count as misses; missing outputs are `not_run`, not
passes or refusals. Legacy duplicate topics are retained in raw evidence but
domain-set comparisons deduplicate them. Paired changes report fixes and
regressions. Exact-example overrides cannot be presented as model improvement.

## Offline usage

```bash
node apps/telegram-runtime/scripts/routing-only-eval.mjs \
  --cases docs/evaluation/routing-only-v1.json
node apps/telegram-runtime/scripts/routing-only-eval.mjs \
  --cases docs/evaluation/routing-only-v1.json --capture /absolute/capture.json
```

The first command emits a plan; the second scores supplied outputs. Neither has
a live mode, reads knowledge nor generates domain answers. Capture envelope:

```json
{
  "schemaVersion": "assistant-routing-capture-v1",
  "planDigest": "<exact plan digest>",
  "origin": "recorded",
  "records": [{
    "key": "<caseId>:candidate:router",
    "output": "<actual raw model JSON>",
    "promptDigest": "<planned prompt digest>",
    "inputDigest": "<planned serialized input digest>"
  }]
}
```

Unknown/duplicate keys and mismatched fingerprints are rejected. Fixture
captures report semantic quality `not_run`; imported recorded captures remain
`inconclusive` until provenance and labels are reviewed. A supplied JSON file
does not authenticate that a model produced its contents.

## Verification

**passed:** full suite, 682 tests, zero failures, zero skips. Components:
Gatekeeper 132; runtime 401; core 114; knowledge 4; infra 2; operations 4;
acceptance 17; console 8. Gatekeeper contract check also passed (30 machine /
34 human states). Full suite used Node 20.20.0 and existing read-only fixtures:

```text
AICHATTG_KNOWLEDGE_PACKAGE_DIR=/Users/alexeykrolmini/Code/allcourses/code/data/knowledge/packages/ai-140310bf9472
AICHATTG_VALUE_SLICE_PATH=/Users/alexeykrolmini/Code/allcourses/code/data/knowledge/org/value_slice.json
```

No fixture was copied or changed. Knowledge source and answer-policy changes:
none in this follow-up. Migrations, dependencies, secrets and infrastructure:
none. Rollback is an exact Git release rollback; no schema/data reversal is
introduced. This does not authorize deploying either candidate or rollback.

Evidence fingerprints:

```text
suite log: /tmp/aichattg-domain-tests.acevws/routing-final-verified.log
suite SHA256: a4648dc43ff820ee1ca5dfa92e2c806084a569d6523bc219cd2df201a5acf04d
planDigest: 1c9e00e8364604c9d2c960f8f41d77b97521a68796226dda7406866cc26fca2b
casesDigest: d30d4fd9fc0686d61540b7f5d22ab1e194ceba0139e8921a2826a86129f39422
registryDigest: 72a76d18359a0ae24804c82c867c1d7b92cadaaaa6bdf448546e8dc896ecd265
```

**not_run:** actual model comparison, semantic accuracy improvement, answer
quality, live latency/cost, production verification. Fake tests establish the
measurement and routing mechanics, not resolution of the semantic problem.

## Next bounded measurement gate

Proposed experiment: 112 slots, at most **104 model calls**. Eight baseline
slots use the old deterministic self-description bypass and require no call.
Model-call distribution: baseline router 24; baseline dispatch 24; candidate
router 28; candidate dispatch 28. No retrieval, generated domain answers,
Moderator execution, Telegram messages or production changes.

Use the same approved model/settings within each old/new pair, freeze source,
case and wire-input hashes, retain actual outputs and call/token receipts.
Run sequentially, no retries, 45-second request limit and 20-minute overall
limit. Stop on authentication, transport, schema or budget-preflight failure.
No live collector is included or executed by this candidate.

A separate approval must name the model/settings and maximum spend. A proposed
USD 2 ceiling is a permission cap, **not a price estimate**: verify current
pricing and conservative input/output bounds before any call and stop if the
whole bounded experiment cannot fit. Existing release approval would not grant
this spending permission; measurement permission would not grant deployment.

Acceptance review: all four known regressions correct after routing; raw model
choices reported separately; every held-out error and paired regression reviewed
without changing labels to match outputs. No semantic success claim until that
evidence exists. Next safe action now: integrator review of this exact candidate.
