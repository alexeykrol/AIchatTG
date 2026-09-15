# Routing-only measurement preflight v2

PO approval: explicit “Да” to at most104 model calls, initially USD2 ceiling,
then explicit increase to **USD20** plus per-question/dialogue dollar accounting.
Only classification; no generated domain answers, Telegram or deployment.
Integrator owns review and the exact one-shot experiment lease. Local collector
preparation is authorized; paid execution remains blocked until lease acceptance.

## Measurement correction

The integrator found that baseline analyzer topics `[out_of_corpus, content]`
were wrongly projected to an empty raw domain set. That could hide a spurious
model choice on an unknown-domain case while correctly reproducing the legacy
final refusal. The evaluator now excludes only the sentinel from the raw set;
ordered raw topics and historical final arbitration remain unchanged.

Both mixed orders, duplicate topics, pure sentinel and candidate strict
rejection are covered. A second review correction rejects noncanonical
question/dialogue whitespace, empty projected turns and extra dialogue fields,
so every accepted planned input matches the real provider projection. The
shared dialogue projection is included in source fingerprints. Frozen28 inputs
are unchanged. Targeted evaluator suite: **passed**,11/11,zero skips.
No routing/index/gold/knowledge change. Previous report and fingerprints are
historical; no call may use the old plan.

```text
planDigest: 214b006cdd0d6e0b9e1faaa0472fdf85bddadc7d0cacf6ffca932765e551b3df
casesDigest: d30d4fd9fc0686d61540b7f5d22ab1e194ceba0139e8921a2826a86129f39422
registryDigest: 72a76d18359a0ae24804c82c867c1d7b92cadaaaa6bdf448546e8dc896ecd265
```

## Model and conservative cap

Read-only local configuration presence check found the project-local ignored
`/Users/alexeykrolmini/Code/AIchatTG/apps/telegram-runtime/.env.provider.local`.
Only key presence and non-secret allowlisted values were returned: OpenAI,
`https://api.openai.com/v1`, router `gpt-5.6-luna / low / 256`.
Credential value was not printed, copied or changed. Integrator confirmed
this established route, file ownership and Git-ignore status. Its existing
mode0644 is recorded, not changed under this scope. Billing-account identity
is not independently verified. No other-project or VPS secret access.

Analyzer output cap1536 follows the existing provider adapter. Same settings
for old/new within each lane; standard service tier, one completion, no tools,
store:false. The output cap includes reasoning tokens according to the
[Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

Fresh [official pricing](https://developers.openai.com/api/docs/pricing) gives
Standard Luna input USD0.20, cache writes USD0.25 and output USD1.20 per million
tokens. Use the higher USD0.25 rate for every input token, with no cache discount.

Conservative UTF-8 byte bound plus2048 envelope tokens/request:

- Model calls:104 (eight legacy deterministic slots need no call).
- Input upper bound:1,570,886 total;26,480 maximum per request, below long-context pricing.
- Output hard caps:93,184 total, including reasoning.
- Whole-run upper estimate: **USD0.5045423**, below the revised USD20 ceiling.

This is a conservative preflight calculation, not an invoice. Reserve each
attempt at its full bound before sending, retain uncertainty and never reset
attempted/spent counters. Stop if returned usage exceeds bounds, is missing,
or if the returned model/tier is inconsistent. No extra calls for recovery.

## Limits and status

Sequential requests,45-second request/body deadline,20-minute whole run, no
retry. On auth, HTTP, transport, schema, source, expiry or budget failure stop.
One-shot output directory and immutable manifest prevent restart/replay.
Interrupt is the kill switch; a dispatched request may still be billed, so its
full reservation remains counted. No provider rollback is possible.

Actual model measurement: **not_run**. Cost incurred by this preflight: zero
paid model calls. Lifecycle of local candidate: **prepared**.

Per-request dollar accounting will preserve lane, question/case identity and
synthetic dialogue identity. Router/analyzer expenses are separate from answer
generation, which is `not_run`, not a measured zero. Amounts computed from
conservative token rates must be labelled upper bounds rather than invoices.

## Collector candidate evidence

- **passed:**25 targeted tests:11 evaluator,12 collector safety,2 dollar accounting.
- **passed:**698 full tests, zero failed/skipped:132 Gatekeeper,417 runtime,114 core,
  4 knowledge,2 infra,4 operations,17 acceptance,8 console. Scenario30/34 passed.
- **passed:**actual approved local config parsed as data:enabled=true, key present,
  OpenAI official endpoint, Luna/low/router256. Secret not returned or copied.
- **passed:**R3/R4 independently accepted by integrator; frozen112 planned request
  bytes unchanged,104 model calls. Runtime/index/gold remain unchanged.

```text
collectorSHA256:6ff77d67661904aa633c3d021d9955f5c35030214df403951a62112b67845905
full-suite-log:/tmp/aichattg-domain-tests.acevws/routing-collector-final.log
full-suite-SHA256:9086fcbd99e16d33a79b8912b4af94fb3ea8dd217a1572f711729e2d3d012be3
```

The collector defaults to a read-only preflight and prints an unapproved lease
template. Actual execution needs the exact accepted HEAD/collector/plan, model,
policy, credential and output paths, issue/expiry timestamps. Every reservation
is fsynced before network. Output files0600, directory0700. Existing run directory
rejects all restart attempts. On abrupt termination the journal remains durable;
offline reconstruction may be needed, never a repeated paid request.

Final output with invalid metadata is preserved as rawOutput, but output=null
prevents counting it as a valid classification. Auth/error envelopes and model
reasoning are not persisted. Missing usage keeps the entire reservation uncertain.

After collection, the offline `routing-cost-summary-v1.mjs RUN_DIRECTORY` creates
an exclusive `cost-summary.json`:per-request/case/synthetic-dialogue amounts,
reported tokens and available cache breakdown, estimated token prices, conservative
upper bounds and unknown/not_run entries. Historical synthetic answers are not
charged as newly generated outputs. Invoice total remains unavailable.
