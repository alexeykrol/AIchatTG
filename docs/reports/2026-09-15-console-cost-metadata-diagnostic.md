# Question-cost metadata diagnostic — 2026-09-15 UTC

Evidence: `passed`. Read-only diagnostic, not a feature release or price audit.
Root integrator alone used the registered key-only `news-vps` route. The source
request is the owner's last-five cost task, message
`01a0a72c-6e0d-7722-8dba-1ac2e4fd24d7` in «Админка».

## Scope and result

At **22:33:50.631 UTC**, one bounded aggregate query inspected metadata for
at most the latest 75 answer records, including a latest-five subset. It opened
the runtime SQLite database read-only, with `query_only=ON`, a one-second busy
timeout and a 20-second outer deadline plus five-second kill grace. Query time
was **7.18 ms**. Only aggregate counts left the container: no question/answer
text, native identifiers, model names, individual usage values or credentials.

| Evidence count | Latest 75 records | Latest 5 records |
| --- | ---: | ---: |
| Records examined | 75 | 5 |
| Analyzer observation present | 67 | 5 |
| Complete answer token fields | 33 | 5 |
| Answer no-call marker | 14 | 0 |
| Complete analyzer token fields | 37 | 5 |
| Complete router token fields | 0 | 0 |
| Observation present, router fields all null | 67 | 5 |
| Completed Assistant inbound receipt | 75 | 5 |
| Receipt result event matches answer event | 75 | 5 |
| Exact diagnosis schema, origin `analyzer_dispatch` | 4 | 4 |
| Origin absent | 71 | 1 |
| Qualified no-router proof and complete answer/analyzer tokens | 4 | 4 |

All five latest records have answer and analyzer tokens. **Four** additionally
have event-level evidence that no router call occurred: completed Assistant
receipt joined by `receipt_id = answer.event_id`, matching result event ID,
schema `assistant-routing-diagnosis-v1`, origin `analyzer_dispatch`.
The fifth lacks that proof. Missing router fields alone do not prove zero cost;
neither does the currently configured routing mode.

The accepted local Analytics contract may use this qualified no-call evidence
when estimating supported stages. It must still verify model/rate support,
delivery eligibility and required stage coverage. This diagnostic does **not**
prove four fully priced questions, any exact price, provider invoice, account
total, cache/tier treatment or complete historical spending. Known-stage amounts
must remain separate from a full-question estimate; missing evidence stays
unknown. These are records in a bounded window, not a complete billing ledger.

## Safety and closure

`passed`: offline summarizer assertions for the 75/5 bounds, schema/event guards,
missing origin/tokens, invalid flag values and empty input. Offline route check
and three-file transport audit passed. No Docker logs were read. One key-only
master was reused, then closed at **22:34:16 UTC**; socket absence was verified.
There was no retry, production write, provider/Telegram call or new paid resource.

Before/after app snapshots are byte-identical. Runtime remains Assistant2.4.37,
source `335a35ad344706062a292581db4d27c5776c4302`; Console remains3.1.0,
source `eb0f7fe8455d0c8339d7332dcefe25423ad9f099`. Both remain healthy with
zero restarts and unchanged container IDs, start times and env/mount/route
digests. No new release lease is active; standalone3.1.1 remains held for the
combined Analytics candidate.

`not_run`: price calculation, model-rate/delivery eligibility audit, feature
production deployment, paid acceptance, full-history scan and data backfill.

## Retained evidence

Ignored, content-free artifacts: `output/console-cost-diagnostic-20260915/`.
The source query, offline test, snapshot helper, metadata, both snapshots and
closure are retained locally. SHA-256:

- `metadata.json`: `6984c1e82a43d1e6bec53ee66d34928ab597b4ea8e8da1be3d5976bc5c62392e`.
- `query.cjs`: `5ab780659007c38c7eb30507cc0f732c5a9f980165a20113dfce48dbac75eaa6`.
- Both app snapshots: `ea4a4226b6138358f08eb40eb428332c3406af8e9e515876f1737a06fe7c9695`.
- `closure.json`: `92c999dc158c4b4f4b0dcd3084b2361b8a6287655ee42254e3a684683bcb0a2d`.

Next owner: the isolated Analytics worker implements and tests the accepted
reader/UI contract; root reviews and integrates its evidence. This report
grants no new remote or production authority.
