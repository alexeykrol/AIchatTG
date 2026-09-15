# Source-backed question cost: Console candidate

## What a row means

One question is one unique `runtime_assistant_answer_records.event_id`. The
Console reads that table without writing, joins the unique analyzer observation
on `event_id`, and joins a completed Assistant inbound receipt on
`receipt_id = event_id`. One unsorted pass computes period totals and keeps
the five newest answer IDs by `created_at DESC, rowid DESC`; only those five
question texts are fetched by primary key. The API returns a question excerpt of
at most 240 Unicode characters, UTC time, stage estimates and the full estimate
only when every charged stage is accounted for.

For a valid answer/analyzer/router call, the standard uncached estimate is
`(input_tokens × input_rate + output_tokens × output_rate) / 1,000,000` USD.
A deterministic answer with no model or counters is a proved no-call stage.
A router with no counters becomes a proved no-call stage **only** when the same
completed Assistant receipt has the matching event ID, code-owned diagnosis
schema and `origin = analyzer_dispatch`, the observation succeeded, and the
router counters are all absent. `router` and `router_fallback` origins require
actual router token counters. Missing, malformed or conflicting receipts stay
unknown.

The full question price is the sum of answer, analyzer and router only if all
three stages are priced or proved no-call. `—` means the full price is unknown,
never zero. The separate known-stage amount adds evidenced stages from both
fully and partially priced questions; with any missing stage it is not a total
price. The last-five total is unknown if any selected question is unknown.
Its displayed mean uses `pricedCount` as denominator and explicitly says how
many of the selected questions have a full estimate. Day/week/history use the same
rule. A genuine zero is shown only for a fully evidenced zero-cost question;
a small positive estimate below the six-decimal display unit is shown as
`<$0.000001`.

## Current source quality

A single bounded, content-free production metadata diagnostic at
2026-09-15 22:33:50 UTC examined 75 newest saved questions; it exported no
event IDs, question/answer text or user data and made no writes. Among the
latest five, all five answer and analyzer token sets were complete; four had
completed matching `analyzer_dispatch` diagnosis receipts and no router
counters. The fifth had no route origin and must remain unknown. For the latest
75, 33 answer token sets, 14 deterministic no-call answers and 37 analyzer
token sets were complete; only four had event-level no-router proof. These are
metadata coverage counts, **not** measured costs. The Console candidate
could therefore price four of the latest five if their delivery, models and
rate dates also pass its checks; actual post-release values are `not_run`.

The portable diagnostic evidence is the root's committed
[metadata report](../reports/2026-09-15-console-cost-metadata-diagnostic.md).
The content-free receipt is ignored local evidence in the canonical root
checkout at `output/console-cost-diagnostic-20260915/metadata.json`; it need not
exist in a worker checkout. The candidate's synthetic complete/partial/no-call
tests are the reproducible proof of the read-model contract.

## Limits and next source work

The answer journal currently covers analyzer-enabled chats, not all chats.
Historical missing counters or diagnosis fields cannot be reconstructed from
configuration. Saved successful answers do not include every failed paid
attempt; the actual provider invoice can also differ because the journal does
not retain cached input, cache writes or billing tier. Standard short-context
rates in the source catalog match the [Terra model page](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
and [Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
checked on 2026-09-15; those pages do not prove the same vendor rates for every
past date. [Prompt caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching)
explains why a standard uncached figure is an estimate, not a bill.

A future all-chat spending view needs a separately reviewed metadata-only
usage ledger that records each provider attempt and its route/answer/analyzer
stage, model, counters, cache/tier fields when available, and no-call proof.
It must not store raw prompts or invent legacy costs. Runtime/database/provider
hooks, migrations, paid calls and production activation belong to the root
integrator and require their own reviewed contract and release authority.

## Candidate boundary

This worker changes only the Console analytics reader, its page and focused
tests from base `9d326f419818b616d1c8045ae4d9a812f6a0ad04`. It inherits the
already pushed Console3.1.1 Russian-label fix. The existing authenticated
read-only `GET /api/operator/analytics` gains `lastFive` and known-stage
fields; no POST, bot/runtime source, price catalog, Compose or database schema
change is part of this candidate. Production is still Console3.1.0 until the
root integrator reviews, integrates and obtains exact release authority.
