# Console 3.2.0 — question-cost integration candidate

Lifecycle: `prepared`. Exact integrated source:
`f650fe87cabf5cf498a64d48907f7a924861cfd2`.
Local commit only; this report does not grant push or production authority.

## Source and scope

Worker source `c10a837efc12526933b0fad07102f5fb6b9393f7`, based on
`9d326f419818b616d1c8045ae4d9a812f6a0ad04`, was integrated onto root
`a8f258fce3dc974ea6d30ea038726a0c8ffce6d3`. The base already contains
the pending3.1.1 Russian-label fixes; no duplicate application was needed.
Worker branch was verified on origin at the exact source above. Canonical
origin/main remains9d326f4 at this checkpoint; integrated source is not pushed.

The existing authenticated read-only Analytics endpoint adds the newest five
saved questions, bounded240-code-point excerpts, UTC times, standard token
estimates per stage, known-stage subtotals and a priced-only mean with its
denominator. Four questions with full estimates plus one unknown produce a
four-question mean, not a five-question mean or a fabricated total.

Root additions: Console version3.2.0, updated Russian Help, correction of the
partial-question count label found in Chrome, and two persistent regression
tests for malformed receipts, invalid analysis, zero cost, partial/degraded
delivery, failed delivery, correct denominators and database immutability.
The backend is byte-identical to the accepted worker backend. No runtime,
price catalog, Console server/config, schema, manifests, Compose or route edit.
The separate private Moderator review feature is **not** included.

## Evidence

`passed`:

- Integrated Node20.20.0 root suite: **792 total,787 passed,5 explicit fixture
  skips,0 failed**. Console41/41; Gatekeeper132, runtime411passed/5skips,
  core114, knowledge snapshot4, Compose3, release61, log safety4, acceptance17.
- Root exact-source/isolation gate on clean f650fe8 against runtime335a35a:
  Assistant stays2.4.37, `assistantChanged:false`, no Assistant changed paths.
- Independent source assurance found no new correctness/security blocker.
  Worker Console39/39 and additional independent synthetic checks passed.
  Receipt joins match canonical unique keys; no-router evidence is event-level,
  completed, schema-matched and tied to the runtime's analyzer-dispatch branch.
- Ordinary external Chrome, loopback synthetic SQLite and actual Console server:
  five rows, four estimates/one unknown, separate partial subtotal, literal
  hostile HTML, UTC times, correct mean label and updated Help verified.
  Screenshot inspection found no desktop overlap; the count-label defect was
  corrected and rechecked. No real question data or production token was used.
  Preview server and tab were closed after verification.
- Working-tree and staged whitespace checks, no protected runtime/config/rate
  delta. Only synthetic local database writes occurred during tests/preview.

`not_run`: production build/deploy, fresh remote preflight, actual question
prices/eligibility in production, new live model/Telegram tests, mobile viewport
QA and five tests requiring absent local course/value fixtures. No production
write, provider call, paid resource or SSH connection occurred for integration.

Remaining inherited limitation: one synchronous whole-history pass computes
all-time aggregates. The worker removed the previous full sort and retains only
five latest rows; only those five texts are fetched by primary key. Independent
desktop synthetic benchmark:100,006 records in394ms. This is not a VPS capacity
guarantee. Bounded aggregation/all-attempt metadata accounting remains backlog.
The journal is a subset of chats; missing historical proof is not reconstructable,
and standard uncached token estimates are not provider invoices or all spending.

## Exact production decision

Last verified baseline22:33:50UTC: Console3.1.0 source
`eb0f7fe8455d0c8339d7332dcefe25423ad9f099`, image
`sha256:97f8a62d7b3ab348d768fc7920da34a74d816594760f44fcc36f2a26af0485c6`;
runtime source `335a35ad344706062a292581db4d27c5776c4302`. Both healthy,
restart0. That diagnostic master closed22:34:16UTC; all older release leases
are consumed. A fresh baseline check is mandatory before another mutation.

Proposed action after explicit PO approval:

1. Push canonical reviewed history; release only exact source f650fe8 above.
2. Issue a one-time root-owned lease for registered host `news-vps`, project
   `aichattg`, service `aichattg-operator-console`: at most30 minutes from issue,
   one forward recreation and at most one conditional rollback, no blind retry.
3. Build from an exact Git archive and recreate Console only with
   `--no-build --no-deps`.
   Refresh only the existing `OPERATOR_CONSOLE_RELEASED_AT` at activation.
   Preserve all other config, credentials, routes, mounts, databases and drafts.
4. Verify health/restart0, exact image/source hashes, seven headers/release API,
   auth boundaries, timestamp versus StartedAt, real Analytics completeness and
   query duration, unchanged runtime/config/data boundaries, then ordinary Chrome.
5. Conditional rollback, only under the same lease and healthy transport:
   recreate prior3.1.0 from its retained exact image/config; never restore/delete
   databases or drafts. Stop on baseline drift, authentication/transport failure,
   unexpected config/data changes or unknown activation outcome; no blind retry.

Zero provider/Telegram calls or added paid resources. No pricing-policy,
moderation collector, bot behavior, webhook, migration or secret change.
Safe default until approval: keep verified3.1.0 running.

Review URL after deployment:
`https://aikrol.questtales.com/analytics-v3.html` (currently serves3.1.0, not this
candidate). Independent worker will inspect the exact deployed release there.

## Local receipts

Ignored directory: `output/console-v32-candidate/`.
Final root TAP SHA-256:
`25801bf06c933920975aeb28d567bbf905418c9e67b3bffca3bc347b777c9103`.
`source-gate.txt` retains the exact clean-source guard result, SHA-256
`fb2a658865c06b33fc82066423c785bead6d97b3c8768e99bdf282262f971b01`.
Preview inputs are synthetic and retained only as a local test harness.
