# Session Continuation: AIchatTG Moderator source provenance

## Metadata

- MODE: continuation
- Transfer kind: worker-continuation
- Reason: final former-News Moderator provenance transfer to its AIchatTG executor
- Created: 2026-08-04T22:03:45-07:00
- Project root: `/Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG`
- Controller generation: 1
- Resume ref: `target=8df2a2d2b67ae3d8b897a85a3204255092525e2d; production=e7ee5d441ce4b95c816b6f063f7b50f0629bcb38; legacy=a729ccd5138288b7c921e0a677b5b9e9281e7399; safety=0a818c5d177bc9f1b57bf2259eaef1d309360dac`
- Relevant dirty paths: target clean; source has pre-existing untracked `.codex/logs/sessions/2026-08-01_22-26.md`, `news-digest-pipeline/.Codex/`, plus this handoff. Do not clean them.

## Goal and Exact Resume Point

Transfer only Moderator/safety behaviour, evidence, residual risks and the unfinished Product Owner UI question from former News task `019fbf1f-e000-7ce1-a485-a01567d13225` to Moderator executor `019fd023-a949-7961-87cd-693bcb893e2c`. Resume at its clean charter branch `codex/aichattg-moderator-executor-v1` at `8df2a2d`; first do a read-only policy/UI inventory. No implementation is authorized by acceptance.

News is now source-only for Telegram AI; AIchatTG owns future implementation. Permanent integrator `019fd019-af89-7b50-a16d-8c7928753f24` remains primary orchestrator and shared-contract/release owner. This worker continuation does not transfer control.

## Authority and Attention Gates

- Authorized now: exact-object inspection, offline ground checks and a read-only Moderator policy/UI report under the successor charter.
- Forbidden: copying News code, `src/pro/index.js`, DB/config/secrets, mutable host prompts, action receipts or user/message history; editing shared runtime/schema/console without an integrator reservation.
- Knowledge Base receives no transfer from this task; course content/retrieval are outside Moderator ownership.
- Production gate: blocked; no deploy, webhook, Telegram/provider or external action without exact PO approval and an integrator lease.
- Spending gate: blocked; no paid/model calls without explicit target and cap.
- Stop/escalate for: editable safety policy, model tuple, enforcement semantics, schema/privacy, provider ambiguity or shared files.

## Active Work Registry

| ID | Executor | Status | Ownership | Ref/worktree | Evidence | Next owner |
|---|---|---|---|---|---|---|
| Moderator | `019fd023-a949-7961-87cd-693bcb893e2c` | ready | safety/Guard/recovery/tests/docs | `8df2a2d`; `d85f/AIchatTG` | clean; 70/70 | successor accepts transfer |
| Core/schema/console | integrator gen 1 | production-verified | shared contracts/release | production `e7ee5d4` | healthy, restart 0, public health 200 | integrator |
| Legacy Moderator | former News task | frozen/source-only | immutable provenance | `a729ccd`; `0a818c5d` | Telegram AI retired from News at `40c1c22` | reference only |
| Knowledge Base | separate executor `019fd023-a999-71d0-841d-89b9e8504eb4` | ready | course packages | separate worktree | separate charter | no transfer |

## Verified Delta

- `deployed`: current AIchatTG runtime and read-only operator console are exact `e7ee5d4`; fresh read-back: both healthy, restart `0`, public `/health` `200`.
- `legacy deployed source`: `a729ccd` was the last full News parity baseline. Its 99-file moderation tree is `71bfdcd9b217c5930a8d947c94d00626d8fea31a`; final safety source `0a818c5d` is its ancestor. Current News production is `6b9dc31`, healthy/restart `0`, after Telegram AI retirement.
- `recovered/integrated`: safety release `0a818c5d` descends `5cfd0b2` and contributed 41 files, `+5807/-186`: strict router/severity, recovery fencing, additive SQLite state, dashboard truth and assurance. Protected publishing/config diff was zero.
- `unintegrated Moderator candidate`: none. AIchatTG already ports accepted safety artifacts/recovery; future work starts with parity checks, never a News cherry-pick.
- Policy: semantic closed route with priority `threat`, then `abuse`, then `clean`; threat/strong abuse become `ban_purge`; weak abuse becomes `delete_warn_1`, then `delete_warn_2`, then `ban_purge`. Models classify route/severity; code owns actions/strikes.
- Current target fixes OpenAI `gpt-5.6-terra`, reasoning `medium`, policy `telegram-safety-v1`; strict JSON/enums/evidence/content hashes fail closed. Durable flow uses exact-revision dispositions, atomic strike planning, generation fencing and no blind retry after ambiguous provider/Telegram boundaries. Owner decisions are labels, not reversal of enforcement.
- Target-owned: `safety-v3.mjs`, `safety-artifacts/**`, `guard-adapter.mjs`, `moderator-recovery.mjs`, focused tests/recovery script/docs. Shared runtime/database/config/transports/manifests/migrations/console/core are integrator-reserved.
- Legacy reference set, never a copy unit: safety router/policy/libraries/prompts, judge/service/db, Telegram adapter/tests, safety corpora, routes/dashboard and `src/routes/telegram.js` at `a729ccd`/`0a818c5d`.
- Legacy DB objects: events, pending, webhook inbox, weak strikes, message ledger and Assistant dispositions. Retained News count-only snapshot: events `523`, pending `0`, inbox `166`, strikes `0`, ledger `20`, integrity/quick-check `ok`, TG prompt v3 active. It is not an import bundle.
- Unfinished PO question: status of abuse/safety settings. Ground truth: deployed AIchatTG console is read-only and exposes route/abuse-level/policy/trace/receipt status where available, but has no settings or mutation routes. Model tuple, libraries, severity, action ladder and warnings are code-owned. No editable-safety specification is approved.
- UI boundary: a proposal must keep observability/labels separate from policy mutation; it must not reverse completed safety actions, reset strikes, replay uncertainty or weaken fail-closed behaviour.
- Residuals: manual hard-delete racing an active safety worker was not generation-fenced and remains `inconclusive`; admin membership can be stale within five-minute TTL; provider ambiguity needs reconciliation; Assistant at-most-once can prefer omission after crash.
- `passed`: clean target `8df2a2d`, 70/70 runtime tests and diff check; exact `69341e64` resilience assurance 319/319 and threat assurance 213/213; controller full gate for `0a818c5d` 92 Vitest files/1394 tests plus publisher 13/13, zero protected diff.
- `failed`: none in final offline assurances. `not_run`: live Telegram/provider/paid semantics and data import. `inconclusive`: live classifier quality and real process/crash races.
- Migrations/runtime/config/protected effect: none in this transfer. AIchatTG has isolated `runtime_*` state; normalized one-way history import is separately leased, raw News DB/text excluded. News publisher/protected paths remain out of scope.
- Rollback: none for documentation. Future code policy/UI candidates must name prior AIchatTG SHA; schema/external actions need data/reconciliation rollback.

## Integration State

- Accepted: AIchatTG production `e7ee5d4`, executor charter `8df2a2d`, final safety/artifact/recovery provenance.
- Pending: PO decision whether any safety field should be editable; no implementation specification exists. No News Telegram-AI release queue remains.
- Rejected/quarantined: direct copy/cherry-pick of News files/DB/config/secrets; treating labels as reversible enforcement.
- Integration owner/target: permanent integrator gen 1; canonical AIchatTG `main`.

## Read Now

- `/Users/alexeykrolmini/Code/AIchatTG/.handoffs/2026-08-04-2114-moderator-executor-charter.md` — ownership and gates.
- `/Users/alexeykrolmini/Code/AIchatTG/apps/telegram-runtime/src/safety-v3.mjs` — current policy contract.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/ASSISTANT_MODERATOR_PARITY.md` — accepted port boundary.

## Ground Checks

```bash
git -C /Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG status --short --branch && git -C /Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG rev-parse HEAD && git -C /Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG merge-base --is-ancestor e7ee5d441ce4b95c816b6f063f7b50f0629bcb38 HEAD
git -C /Users/alexeykrolmini/Code/News cat-file -t a729ccd5138288b7c921e0a677b5b9e9281e7399 && git -C /Users/alexeykrolmini/Code/News cat-file -t 0a818c5d177bc9f1b57bf2259eaef1d309360dac && git -C /Users/alexeykrolmini/Code/News merge-base --is-ancestor 0a818c5d177bc9f1b57bf2259eaef1d309360dac a729ccd5138288b7c921e0a677b5b9e9281e7399
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix /Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG/apps/telegram-runtime test
```

Expected: clean Moderator branch at `8df2a2d`, exact source objects/ancestry pass, runtime tests pass; preserve unrelated paths.

## Next Safe Action

Moderator executor produces a read-only inventory of deployed console surfaces and `safety-v3.mjs`, then gives the PO/integrator a decision map: observability-only fields, code-owned invariants, and any explicitly requested bounded editable setting. Stop before UI/schema/model edits or deployment request.

## References On Demand

- `/Users/alexeykrolmini/Code/AIchatTG/docs/operator-console.md` — consult for the read-only UI contract.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/RUNTIME_STATE_IMPORT.md` — consult only if history import is separately proposed.

## Successor Directive

```text
Read /Users/alexeykrolmini/.codex/AGENTS.md, every applicable AIchatTG AGENTS.md, your charter, and this continuation. Run Ground Checks without ref substitution. Controller validation marker: CONTROL ACCEPTED: generation 1; this does not transfer control from the permanent integrator. If facts match, reply to the source task exactly TRANSFER ACCEPTED: aichattg-moderator-source-provenance, with checked HEAD and Next Safe Action. Otherwise reply TRANSFER REJECTED with the exact contradiction and stop. Production and spending remain blocked unless a later exact approval and lease say otherwise.
```
