# Session Continuation: AIchatTG Assistant source provenance

## Metadata

- MODE: continuation
- Transfer kind: worker-continuation
- Reason: final former-News Assistant provenance transfer to its AIchatTG executor
- Created: 2026-08-04T22:03:45-07:00
- Project root: `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`
- Controller generation: 1
- Resume ref: `target=8df2a2d2b67ae3d8b897a85a3204255092525e2d; production=e7ee5d441ce4b95c816b6f063f7b50f0629bcb38; legacy=a729ccd5138288b7c921e0a677b5b9e9281e7399; source-candidate=ef1c6ea423dd7499c903eed561e1c7bd150a1ed4`
- Relevant dirty paths: target clean; source has pre-existing untracked `.codex/logs/sessions/2026-08-01_22-26.md`, `news-digest-pipeline/.Codex/`, plus this handoff. Do not clean them.

## Goal and Exact Resume Point

Transfer only Assistant behaviour, evidence and unfinished Product Owner questions from former News task `019fbf1f-e000-7ce1-a485-a01567d13225` to Assistant executor `019fd023-a940-7cf2-864a-75b20fd842ef`. Resume at its clean charter branch `codex/aichattg-assistant-executor-v1` at `8df2a2d`; first do a read-only parity matrix. No implementation is authorized by acceptance.

News is now source-only for Telegram AI; AIchatTG owns future implementation. The permanent AIchatTG integrator `019fd019-af89-7b50-a16d-8c7928753f24` remains primary orchestrator and shared-contract/release owner. This worker continuation does not transfer control.

## Authority and Attention Gates

- Authorized now: exact-object inspection, offline ground checks and a read-only Assistant parity report under the successor charter.
- Forbidden: copying News code, `src/pro/index.js`, old index/database/config/secrets, mutable host prompts or user/message history; editing shared runtime/schema without an integrator reservation.
- Knowledge Base receives no transfer from this task. `/Users/alexeykrolmini/Code/allcourses`, content admission and snapshots stay with its separate executor.
- Production gate: blocked; no deploy, webhook/menu, Telegram/provider or external action without exact PO approval and an integrator lease.
- Spending gate: blocked; no paid/model calls without explicit target and cap.
- Stop/escalate for: product decisions on help/operations parity, knowledge admission, schema, privacy, provider/model or shared files.

## Active Work Registry

| ID | Executor | Status | Ownership | Ref/worktree | Evidence | Next owner |
|---|---|---|---|---|---|---|
| Assistant | `019fd023-a940-7cf2-864a-75b20fd842ef` | ready | Assistant policy/tests/docs | `8df2a2d`; `0f48/AIchatTG` | clean; 70/70 | successor accepts transfer |
| Core/runtime | integrator gen 1 | production-verified | shared runtime/schema/release | production `e7ee5d4` | healthy, restart 0, public health 200 | integrator |
| Legacy Assistant | former News task | frozen/source-only | immutable provenance | `a729ccd`; `ef1c6ea` | Telegram AI retired from News at `40c1c22` | reference only |
| Knowledge Base | separate executor `019fd023-a999-71d0-841d-89b9e8504eb4` | ready; disabled/unimported | course packages | separate worktree | separate charter | no transfer |

## Verified Delta

- `deployed`: current AIchatTG runtime and operator console are exact `e7ee5d4`; fresh read-back: both healthy, restart `0`, public `/health` `200`.
- `legacy deployed source`: `a729ccd` was the last full News Assistant/Moderator baseline used for parity. Its 99-file `src/pro/moderation` tree is `71bfdcd9b217c5930a8d947c94d00626d8fea31a`; current News production is `6b9dc31`, healthy/restart `0`, after Telegram AI retirement.
- `recovered/integrated`: `5cfd0b2` and final safety `0a818c5d` are ancestors of `a729ccd`. The Assistant baseline includes leading `/ask`, deterministic `/help`/identity replies, exact-revision Moderator disposition gating, once-per-native-question claims and dialogue persistence only after successful delivery.
- `accepted but not deployed in News`: `ef1c6ea` from base `507ee2f`, 11 files, `+378/-106`. It isolates course-operations/interface/process questions from content RAG, fails closed on invalid role-gate output, removes the incorrect RAG help example and adds exact 2.4.36 help timestamp. No DB migration, package/config or protected publishing-path delta.
- Target current surface: `apps/telegram-runtime/src/assistant-policy.mjs`; Assistant-specific tests/docs. Shared `runtime.mjs`, `database.mjs`, `config.mjs`, provider/knowledge adapters, transports, manifests, migrations and `packages/telegram-core/**` are integrator-reserved.
- Legacy reference set, never a copy unit: `src/pro/moderation/assistant*.js`, `assistant-profile.js`, `assistant-responses.js`, `chat-profile.js`, `dialog-*.js`, `course-index/**`, `topics/**`, Assistant prompts/tests/eval, shared `db.js`/`service.js`/routes and `src/routes/telegram.js` at exact Git refs.
- Legacy data references were `data/course-index-current-course.json`, `knowledge-*.md`, external build input `courses.db` and News SQLite. None is transferable. Count-only retained News snapshot: Assistant events `109`, claims `128`, dispositions `40`, profiles `2`, dialogues `2`, turns `1`, summaries `0`, traces `1`.
- Unfinished PO issue 1: legacy index admitted title-only/empty lessons and surfaced removed/non-public sections. Never reuse it; knowledge repair belongs to Knowledge Base.
- Unfinished PO issue 2: changed `/Users/alexeykrolmini/Code/allcourses` structure and requested a topic URL. This former task did not complete it; it transfers nowhere from here.
- Unfinished PO issue 3: `ef1c6ea` help/course-operations behaviour was accepted but not deployed. Current AIchatTG help is generic and course knowledge is disabled, so parity must be measured rather than assumed.
- `passed`: successor charter onboarding, clean `8df2a2d`, Node 20.20.0 runtime tests 70/70, diff check; exact `ef1c6ea` object/ancestry/diff and controller review of transition/price/community/course-start fail-closed cases.
- `not_run`: live Telegram/provider/paid semantics, course retrieval, knowledge/history import and any production action.
- `inconclusive`: live answer quality against a future admitted snapshot.
- Migrations/runtime/config/protected effect: none in this transfer or `ef1c6ea`. AIchatTG already owns isolated state; optional normalized one-way history import is separately leased and excludes raw News SQLite/dialogue text. News publisher/protected paths remain out of scope.
- Rollback: none for this documentation. A future code-only parity candidate reverts by SHA; any schema/data candidate needs its own rollback.

## Integration State

- Accepted: AIchatTG production boundary `e7ee5d4`, executor charter `8df2a2d`, legacy fail-closed/durability provenance.
- Pending: read-only parity decision for accepted source-only `/help` 2.4.36 and course-operations routing. No News Telegram-AI release queue remains.
- Rejected/quarantined: direct cherry-pick/copy of News files, index, DB, config or secrets.
- Integration owner/target: permanent integrator gen 1; canonical AIchatTG `main`.

## Read Now

- `/Users/alexeykrolmini/Code/AIchatTG/.handoffs/2026-08-04-2114-assistant-executor-charter.md` — ownership and gates.
- `/Users/alexeykrolmini/Code/AIchatTG/apps/telegram-runtime/src/assistant-policy.mjs` — current target behaviour.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/ASSISTANT_MODERATOR_PARITY.md` — accepted port boundary.

## Ground Checks

```bash
git -C /Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG status --short --branch && git -C /Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG rev-parse HEAD && git -C /Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG merge-base --is-ancestor e7ee5d441ce4b95c816b6f063f7b50f0629bcb38 HEAD
git -C /Users/alexeykrolmini/Code/News cat-file -t a729ccd5138288b7c921e0a677b5b9e9281e7399 && git -C /Users/alexeykrolmini/Code/News cat-file -t ef1c6ea423dd7499c903eed561e1c7bd150a1ed4 && git -C /Users/alexeykrolmini/Code/News diff --check 507ee2fe19c2054ec4cf8e1a46d17c4225ea36f3 ef1c6ea423dd7499c903eed561e1c7bd150a1ed4
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix /Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG/apps/telegram-runtime test
```

Expected: clean Assistant branch at `8df2a2d`, exact source objects/diff pass, runtime tests pass; preserve unrelated paths.

## Next Safe Action

Assistant executor produces a read-only matrix comparing current `assistant-policy.mjs` with exact `ef1c6ea` for `/help`, course-operations questions and invalid role-gate outcomes, then reports deltas/PO decisions to the integrator. Stop before edits, knowledge import or deployment request.

## References On Demand

- `/Users/alexeykrolmini/Code/AIchatTG/docs/PROVIDER_KNOWLEDGE_PORTABILITY.md` — consult for provider/knowledge boundaries.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/RUNTIME_STATE_IMPORT.md` — consult only if history import is separately proposed.

## Successor Directive

```text
Read /Users/alexeykrolmini/.codex/AGENTS.md, every applicable AIchatTG AGENTS.md, your charter, and this continuation. Run Ground Checks without ref substitution. Controller validation marker: CONTROL ACCEPTED: generation 1; this does not transfer control from the permanent integrator. If facts match, reply to the source task exactly TRANSFER ACCEPTED: aichattg-assistant-source-provenance, with checked HEAD and Next Safe Action. Otherwise reply TRANSFER REJECTED with the exact contradiction and stop. Production and spending remain blocked unless a later exact approval and lease say otherwise.
```
