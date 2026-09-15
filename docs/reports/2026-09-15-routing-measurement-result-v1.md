# Routing-only measurement: partial result, terminal transport stop

## Outcome

Actual provider measurement is **partial**. All47 returned classifications
passed envelope/usage validation. The48th attempt stopped with
`transport_failure`; its provider acceptance/billing is unknown. No retry,
restart, replacement lease, extra model or production action occurred.
Controller independently acknowledged the consumed lease and required offline
closure. Unused call/budget capacity is not permission to bypass that stop.

Candidate lifecycle remains **prepared**, not deployed or accepted into main.
Source: `fc5a741331aa3ae5c39b8227dba23d50ce0f81b5`; baseline `909fad69`.
Execution:2026-09-15 08:51:38.999–08:52:51.762 UTC. One caller, sequential,
OpenAI Chat Completions, GPT-5.6 Luna/low, standard tier, router256/analyzer1536,
store:false,n1. All47 results have request/completion IDs and matching
model/tier/HTTP200 receipts. No question-answer generation or retrieval.

## What was measured

- 48 reserved/dispatched attempts out of104 maximum.
- 47 valid model results:baseline router10,baseline analyzer10,new router14,
  new analyzer13.
- 1 uncertain attempt:`blind-10:candidate:dispatch`.
- 56 never-attempted slots; **57 missing model results**, not counted as passes.
- 8 historical deterministic bypasses are evaluated separately, not paid calls.

The evaluated prefix is not a random sample. Labels remain reviewed proposals.
This does not establish full-set accuracy or production behavior. The frozen
index, questions and expected answers/domains were not tuned during the run.

## Domain selection results

Exact domain-set matches; domain order is not part of this metric.

| Mode and comparable subset | Old final | New raw model | New final |
| --- | ---: | ---: | ---: |
| Router:4 known regressions | 2/4 | 4/4 | 4/4 |
| Analyzer:4 known regressions | 2/4 | 4/4 | 4/4 |
| Router:first10 independent cases | 3/10 | 10/10 | 10/10 |
| Analyzer:first9 comparable independent cases | 3/9 | 9/9 | 9/9 |

Across comparable pairs:router9 fixes/14 pairs;analyzer8 fixes/13 pairs;
no observed paired regressions. The extra old analyzer result forblind-10 has
no comparable new result and is excluded from the paired analyzer row above.

For transparency, the old raw model was correct on0/2 paid regression outputs
in each mode; the other2 regression slots used deterministic bypasses. Old raw
independent outputs:router2/8;analyzer3/8 (the latter includes blind-10).
Raw-model denominators exclude deterministic bypasses.

The new model itself selected the expected domain sets on **27/27 returned
choices**. Two exact-example overrides reordered the self/operations domains
inreg-04, but did not repair an incorrect raw set. Thus this partial improvement
is not merely the index masking these model errors with exact-example rules.

Concrete observed old failures:

- “Кто ты и как тебя зовут?” → no domain; new → assistant-self.
- Self-description plus learning rules → wrong single/no domain; new →
  assistant-self+operations.
- Navigation plus explanation → one part lost; new → navigation+content.
- Value plus organizational conditions → one part lost; new → value+operations.
- Educational mention of system prompts triggered the old internal-information
  bypass; new classified it as subject content.

This supports the index-driven domain-recognition direction on the observed
prefix. It does not prove every paraphrase, dialogue or future domain works.

## Separate risk-label discrepancies

Domain selection and risk flags are separate outputs. The new router disagreed
with proposed risk labels twice while selecting the abuse domain correctly:

| Case | Proposed risk flags | Returned risk flags |
| --- | --- | --- |
| blind-06 | abuse | prompt_injection |
| blind-07 | abuse,prompt_injection | prompt_injection |

These require an explicit label-definition review, not silently changing gold
to match the model. No safety policy or index was changed. The unexecuted
privacy and contextual-follow-up cases remain unmeasured.

## Dollar accounting

PO raised the ceiling from USD2 to **USD20**. The stop was transport-related,
not budget exhaustion. Prices were fetched from
[official OpenAI pricing](https://developers.openai.com/api/docs/pricing).

Reported usage from47 returned calls:

- Input101,764 tokens:cached90,536;cache writes9,272;remaining ordinary1,956.
- Output2,780 tokens, including reasoning where used; never counted twice.
- Token-priced estimate for known usage:**USD0.00785592**.
- Conservative known-usage bound:**USD0.028777** (all input at maxinput rate).
- Uncertain48th attempt retained at full bound:**USD0.00840145**.
- Total conservative bound including uncertainty:**USD0.03717845**.
- Invoice/billing-account verification:unavailable; the estimate is not an invoice.

Detailed [dollar ledger](../../.handoffs/local/routing-live-collector-v1/cost-summary.json)
contains per-request, per-question and synthetic-dialogue entries. Amounts for
questions sum experimental old/new lanes, not one production answer's price.

| Question case | Attempted calls | Known usage estimate USD | Total conservative bound USD |
| --- | ---: | ---: | ---: |
| reg-01 | 2 | 0.00154925 | 0.00154955 |
| reg-02 | 4 | 0.00096840 | 0.00229100 |
| reg-03 | 2 | 0.00024565 | 0.00155925 |
| reg-04 | 4 | 0.00047461 | 0.00231450 |
| blind-01 | 4 | 0.00056606 | 0.00240570 |
| blind-02 | 2 | 0.00025245 | 0.00156605 |
| blind-03 | 4 | 0.00053456 | 0.00237450 |
| blind-04 | 2 | 0.00027530 | 0.00158890 |
| blind-05 | 4 | 0.00045101 | 0.00229110 |
| blind-06 | 4 | 0.00049951 | 0.00233960 |
| blind-07 | 4 | 0.00051316 | 0.00235340 |
| blind-08 | 4 | 0.00057456 | 0.00241490 |
| blind-09 | 4 | 0.00063291 | 0.00247310 |
| blind-10 | 4 (1 uncertain) | 0.00031849 | 0.00965690 |

Answer-generation cost is `not_run/null`, not a measured zero. Prior synthetic
answers were not generated by this run and are not charged as new outputs.
All three contextual-follow-up cases occur later in the frozen list and were
not attempted. Consequently completed multi-turn dialogue cost is not measured.
Permanent production dollar instrumentation was outside this experiment.

## Evidence and boundaries

Local evidence folder:`.handoffs/local/routing-live-collector-v1/`.
It is Git-ignored; receipts and content-safe records mode0600, directory0700.
Do not reset/delete it to rerun a consumed lease.

```text
planDigest:214b006cdd0d6e0b9e1faaa0472fdf85bddadc7d0cacf6ffca932765e551b3df
collectorSHA256:6ff77d67661904aa633c3d021d9955f5c35030214df403951a62112b67845905
manifest object digest:909d15b8f4e120842402cfd4cce61faa2464c3430627d8650dcf5047d957a9a8
manifest file SHA256:ea84705079d09b88133ecfcd6da9a28293d0fb654202ed7e59a6161191d9aa45
journal file SHA256:d21ce362f25bfe6b91edc4a86e6af596b5e227efc29a33588b282f2f5e1406b4
capture file SHA256:8b9e3e31620e46e727155c025d6cab22a3426d9864273063e07b7525b317c918
receipt file SHA256:118e228387cbcde52743ef7801cc0be8cc8353286243b3ecca76aa4c2e0354e5
comparison file SHA256:acdcd2e4010fcc07d4b3b16b6a40b5b63c08966130fd233fef76b948c6e5a89d
cost-summary file SHA256:32e0b1bb2deabf7111650e442f3c5d4fdd8b82b89d08ce747e2de49fe4e98d57
```

**passed:**698 local tests,25 targeted tests,47 valid live receipts, protocol
stop/no-retry behavior, captured provenance and arithmetic. **inconclusive:**
full domain accuracy, two risk-label disagreements, provider outcome ofattempt48.
**not_run:**56 remaining calls, generated answers, multi-turn cost, main
integration and production verification. No auth-cause diagnosis is established.

Next safe action:controller review/acceptance of this partial evidence and
planning any separately authorized follow-up; no automatic continuation.
