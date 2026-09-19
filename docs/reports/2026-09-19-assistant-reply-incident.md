# Assistant reply incident — read-only diagnosis

PO report: the bot stopped answering or answers strangely. A subsequent explicit
instruction authorized reading the relevant chat messages. Root performed only
bounded diagnosis; implementation, deployment, restart, paid calls and test sends
were not authorized or performed.

## Confirmed production state

Observed2026-09-19T20:36:36–20:41:44UTC. Exact Assistant2.4.39/runtime
`2c72e01cb28452c640c033c91a2060a8eca57201`, image7fc9a7e6; Console3.2.0/source
f650fe8/image6f768088. Both healthy, restart0. Runtime has not been recreated
since16September. Five relevant deployed source hashes match exact2c72e01.
Before/after snapshots of identities, start times and inspected configuration
were equal. The earlier Review activation remained rolled back and disabled.

Both bots' read-only `getWebhookInfo` returned correct routes, pending0, no last
delivery error. Runtime health200. No stuck inbound event or nonterminal answer
claim was found among the bounded recent records. No claim about all historical
events or overall VPS health follows from these application-scoped checks.

## Recent incident evidence

Queries covered the preceding24hours and1hour, cap5000 metadata rows and20
relevant turns. Four Assistant-owned native questions fell within both windows;
none overlapped the legacy quarantine. Only their relevant stored question
snapshots were read, not a bulk Telegram transcript.

| UTC time | Relevant input | Recorded outcome |
| --- | --- | --- |
|19:48:41|Help command|Safety-router result invalid; fallback delivered successfully|
|19:48:48|Help command again|Help reply delivered successfully|
|19:49:05|Bare ask command|ForceReply hint delivered; cleanup finished|
|19:49:38|Question about creating a website|Safety-router result invalid; fallback delivered successfully|

Two judgement jobs ended in `manual_review` with
`provider_safety_router_invalid`, provider boundary `unknown`, retry count0.
Their corresponding Assistant deliveries have `receipt.ok=true`, confirmed
fallback claims and `judgement_unavailable`. Thus this is not demonstrated
total silence or a stopped service: meaningful handling failed before answer
generation, and the operational fallback was delivered instead.

The fallback body reconstructed from exact deployed code is the neutral
cannot-process-now message, with the2.4.39/16.09.2026 footer. Delivery receipts
and route were checked; the actual outgoing Telegram message body was **not**
fetched independently. The affected group is outside the single analyzer chat;
normal answer-body journaling there is not enabled. Absence of an answer-record
row alone is therefore not evidence of silence.

There were zero answer-provider attempts, request reservations, analyzer rows or
coverage deficits in the recent window. These cases never reached course
retrieval/answer generation. No recent cooldown/daily-cap refusal or answer
timeout was found. Configured human limits are20seconds/20per day; their mere
existence is not the cause of these incidents. Separate knowledge-quality
concerns remain untested by this diagnostic.

## Cause confidence and evidence gap

**Confirmed:** the model's safety-router result was rejected by the deployed
contract. This code is distinct from HTTP/auth/transport failures and may mean
invalid router JSON/fields or invalid warning context. Runtime persists the
generic error, but these jobs retain neither rejected verdict, `safetyReason`,
finish reason nor usage receipt. Exact bad field/truncation cannot be recovered
from the available records. Do not call this a proven provider outage or blame
knowledge retrieval.

**Reproducible hypothesis, not historical proof:** local source assurance found
the parser requires `target=none` for a clean verdict, while the prompt does not
explicitly state that implication. A clean verdict with `target=assistant` is
rejected. Router uses JSON-object mode, medium reasoning and1024 output tokens;
these settings alone do not establish which error happened in the real calls.

**Recommended next candidate:** first preserve a content-free specific rejection
reason and safe response-completion metadata, then test and align the prompt/
validator contract without weakening safety. Any paid real-model reproduction
and deployment require their own explicit approval. Do not replay the production
updates, bypass moderation or retry ambiguous paid calls automatically.

## Evidence and closure

- `passed`: current identity/health, webhook delivery status, recent aggregate
  classification and relevant question snapshots, five source hashes, unchanged
  before/after snapshots and single SSH master closure.
- `inconclusive`: exact invalid model field; independent actual Telegram reply
  body; global answer quality outside the observed interactions.
- `not_run`: implementation, deploy/restart, paid calls, production test messages,
  history replay, unrelated project diagnostics and Docker-log reads.

Ignored local evidence: `output/assistant-incident-20260919/`.
Aggregate artifact excludes raw questions/replies; no credentials/user profile
data or chat transcript is committed. SHA256:

- `before.json`:3a254480a3ef8e8927927650f307a8440c96349b8d18ade2ef2bcb57c3a5b904
- `initial.json`:b33116654fbc8c65a46ad8c6a4ca8fe2e2b003260c0444656ee1986095ce79ec
- `aggregate.json`:945a9985833e73c7655d6077ef3097a24855eda67b77f3a8911a7a1c02afed21
- `details.json`:5fe4eaed1b8c40c28f3b90b2caae5ef25fd61c7421950662b901160b18a0f61f
- `after.json`:149dfb6b178d44b5ba8fe5d6872e918b806e92198b99a13e2275a7d9aaad36fb

Master closed after final20:41:44UTC snapshot; socket absence independently
checked20:42:14UTC. No remote process, production mutation or active lease remains.
