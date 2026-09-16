# Private Moderation bridge — synthetic acceptance plan v1

Companion to `2026-09-15-moderation-live-bridge-contract-v1.md`.
Status: test specification, NOT executed bridge tests. Exact accepted feature
base1829573015de5d307868afb73e4ef3dcfc0e7fdb. No implementation authorized here.

## Harness constraints

Node20.20.0, fresh synthetic private directories, fake clock, fake authenticated
bindings, fixed clearly synthetic HMAC fixture key, injected one-call sender and
in-memory request/reply transport. Deny external network/fetch by default.
All chats, update IDs, messages, user IDs and destinations are synthetic.
No tokens, environment discovery, recovery snapshots, actual bot/API calls or
production DB/config. Fixture bounds are deliberately tiny and not live policy.
Cross-process owner tests use only uniquely created local temporary paths.

## Acceptance matrix

| ID | Scenario | Required observable result |
| --- | --- | --- |
| C01 | Disabled bridge / missing policy / real mode requested | No capture/store/send work; existing disabled runtime behavior unchanged; real mode rejected |
| C02 | Assistant, unlisted chat, own/exempt bot, service/pin/automatic forward | Skip before persistence/hash/log; no change to existing classification |
| C03 | Non-exempt bot comment in approved synthetic chat | Same review-only path as human comment; no bot/AI certainty or sanction |
| C04 | Names/phone/media/extra JSON/context recursion injected | Only exact allowlisted envelope survives; no private unexpected field in log or storage |
| C05 | No reply / valid same-chat reply / missing proof / other chat | none/supplied/unavailable distinguished; discarded supplied context blocks new claims; no fetch |
| C06 | Pre-start original / new edit after start / pre-activation receipt | Explicit forward-only eligibility, no historical backfill or recovery import |
| C07 | Oversized full text/context with promotional suffix | Clipping flagged; no new claims/grouping/alert; retained prefix visible/erasable |
| C08 | Unsafe IDs/time/unknown schema/additional envelope keys | Deterministic validation failure; zero source/checkpoint mutations |
| C09 | Negative/missing/future time or edit before original | reject/source_time_invalid ->400 before runtime; native head unchanged; later valid edit succeeds |
| I01 | Same source update twice; changed observedAt | One retained revision, first observedAt; identical consumed intake receipt, one initial alert |
| I02 | Same event identity with changed allowed payload while retained | event_conflict; no mutation, sequence or sender call |
| I03 | Distinct update IDs carrying same semantic revision/payload | Native duplicate, no extra revision/case/alert; separately accounted receipt |
| I04 | Higher edit timestamp then older edit/original | Newer stays current; older is explicitly stale/not retained, never relabeled newer |
| I05 | Equal valid edit timestamp with different content | revision_order_conflict ->503 before runtime, no guessed order or numeric revision; missing time follows C09 |
| I06 | Out-of-order update IDs across different native messages | No global update_id watermark drop; each eligible event accounted independently |
| I07 | Crash before evidence+ledger transaction commits | Neither evidence/alert nor consumed receipt/sequence advances |
| I08 | Crash after commit before intake/webhook response | Retry returns same receipt; one evidence set/alert; existing runtime dedupe fences effects |
| I09 | Crash after runtime claim | Review receipt already durable; processing/uncertain runtime semantics remain unchanged |
| I10 | Ingest followed by separately failing checkpoint write | Deliberately broken implementation must fail acceptance; single transaction required |
| I11 | Counter mismatch, missing ledger/schema, unknown epoch/key | checkpoint_unknown/corrupt or binding failure; never reset or silently create fresh live state |
| I12 | Revision/ledger/native-marker/space capacity reached | No eviction, sequence advance, ACK success or paid resource; explicit backpressure |
| I13 | Distinct source bindings; same native integers | No cross-source/chat merge, identity leakage or shared cursor assumptions |
| E01 | Erase with stale version/wrong principal/conflicting request | Existing409 fences, no marker/evidence changes |
| E02 | Exact authorized erase + repeat request | One atomic erase/receipt; all linked content/digests gone; exact receipt replay |
| E03 | Erase then old exact envelope; restart then replay | consumed_erased; no raw text/hash restoration or alert |
| E04 | Erase then same native under new update ID or future edit | suppressed_erased, no detector/raw persistence; retained marker privacy extension explicit |
| E05 | Erase coalesced case then replay EACH donor/revision | Every member native suppressed; no donor-linked hidden digest remains |
| E06 | Crash between marker and evidence removal injection | Whole transaction rolls back or commits; no partial fence/deletion state |
| E07 | Fresh message references erased native as context | Context removed BEFORE digest/storage, context_erased/incomplete visible; no new claim/group/alert |
| E08 | Unrelated case already contains direct context copy | Remains only within its visible unrelated case; no claim of global textual erasure |
| E09 | No marker capacity during erase | Entire erase fails atomically; never delete without anti-replay protection |
| E10 | Epoch change/key replacement/reprovision attempt | Cannot bypass existing source markers/ledger; unauthorized reset fails closed |
| E11 | Fabricated source delete / missing text / source inaccessible | No inferred delete signal, Review erasure or Telegram call |
| E12 | Capture and exact-version erase race | Capture first invalidates erase version; erase first suppresses capture atomically |
| E13 | A-with-context-B -> erase B -> retry A with SAME and NEW update ID, including restart | Original native admission mask yields duplicate, no evidence change/conflict/alert; only a new event ID gets a new linked receipt |
| E14 | Original/edit + semantic duplicate under new ID + stale -> erase | SQL proves ALL related ledger digests/masks/live links removed; replay each cannot restore content |
| A01 | Intake unavailable/timeout/corrupt/capacity before runtime | Explicit proposed503 path, no runtime claim/Guard/provider effects |
| A02 | Intake committed but response lost | No blind success; current request503; subsequent same identity consumes once |
| A03 | Durable receipt then runtime returns uncertain/processing | Review remains durable; HTTP/runtime behavior not falsely described as business success |
| A04 | Disabled or out-of-scope update during intake outage | No new dependency on Review; Assistant/legacy path preserved |
| O01 | Two processes contend before store construction | One owner; loser never opens DB/reclassifies calling/send; no second writer |
| O02 | Owner crash leaves lock / stale PID reused | No TTL/PID-only takeover; explicit controlled recovery required |
| O03 | Owner fence loss while serving | Stop admission/claim; no alternate connection or bypass |
| D01 | Unconfigured destination/origin, overlength, disabled sender | No claim or invocation; never infer recipient from admin/config |
| D02 | Valid complete one-call fake receipt | sent + opaque UUID only; one generic link and zero raw source fields |
| D03 | Explicit verified no-send rejection | failed, no automatic retry; no error body stored/logged |
| D04 | Timeout/disconnect/partial/malformed success/mismatch | uncertain even if headers/HTTP200/partial ok; no fallback or second call |
| D05 | Claim persisted then process dies before/after invocation | Restart calling->uncertain under sole owner; never auto-resend |
| D06 | Duplicate delivery attempt ID at private sender boundary | No second external-call simulation; content-free terminal/uncertain replay |
| D07 | External success then terminal persistence fails | Stop sender; calling fence survives; not reported durably complete |
| D08 | Erase before claim / erase during calling / erase after terminal | Pending cancels; calling refuses erase until finite terminal/recovery; then target erases |
| D09 | Hostile text, URL, token-like errors in inputs/fake results | No source text/native IDs/credential/recipient/raw errors in alerts, logs or receipts |
| R01 | Large clock jump and process restart | Raw evidence indefinite; no expiry or automatic policy reset |
| R02 | User verdict after bridge ingest/coalescing | Version/principal/replay fences survive; uncertain label audit-only; no active rule |

## Evidence required from the later implementation

- Exact base/candidate and changed paths; independent review of atomicity,
  cross-process ownership, replay/erase privacy and webhook availability delta.
- TAP per case plus full Console/runtime/relevant shared suites, with explicit
  pass/fail/skip counts. These cases are not counted among the existing159 tests.
- Crash fixtures inspect both case/source tables and metadata in the same
  synthetic database after restart; row counts alone are insufficient.
- Sanitized assertions prove no sent payload/private log leak and no unintended
  network/dependency/entrypoint/bootstrap/production-mode change.
- Browser QA if new visible missing-context/delivery-inflight wording or status
  changes are implemented; preserve existing Russian Console shell.
- Root source isolation guard and explicit Assistant release effect if a shared
  runtime hook changes Assistant-relevant sources; do not assume it is exempt.

## Checks performed for this contract-only proposal

`passed`: read accepted source through git show; verified base ancestry to
9d326f4; exact accepted store hash matches root report; all18 frozen worker
manifest hashes match; root evidence file hashes match report. Main read
contracts v1–v5 and original/new charters; two read-only bounded reviews examined
capture/ACK and erasure/checkpoint windows.
Final document review `passed` after correcting temporal rejection, context
completeness, immutable exact/native replay masks and duplicate/stale erasure
linkage. All54 matrix scenarios remain specifications, not executed tests.
New-document whitespace/conflict-marker checks passed; frozen18 hashes were
rechecked after document preparation and remain unchanged.

`not_run`: new bridge behavior/tests, fresh rerun of accepted feature suites,
real recipient checks, Telegram/API calls, SSH, live capture, configuration,
migrations, production deployment or spending. Existing root suite evidence is
historical evidence for1829573, not a passing implementation of this proposal.

Root next action: accept/revise the proposed privacy and availability choices,
then reserve source paths and issue a fresh LOCAL implementation charter.
