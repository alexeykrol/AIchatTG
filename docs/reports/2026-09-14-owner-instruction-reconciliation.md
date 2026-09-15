# Product Owner instruction reconciliation — 2026-09-14

## Purpose

This report reconstructs the recoverable Product Owner instruction/fix history
and compares it with the repository at the candidate prepared on 2026-09-14.
It separates historical proof, local candidate state and production evidence.

Statuses: `passed`, `failed`, `not_run`, `inconclusive`; implementation state:
`done`, `partial`, `superseded`, `proposed`.

## Sources and limits

Primary sources inspected:

- Codex rollout for thread `019fd019-af89-7b50-a16d-8c7928753f24`;
- the attached AIchatTG onboarding continuation text;
- local Claude Code AIchatTG and allcourses JSONL transcripts available on
  2026-09-14;
- Git history and commit bodies through the candidate parent `2a7e764`;
- `.handoffs/`, `CHANGELOG.md`, `docs/OWNER_FEEDBACK_LOG.md`, reports, runtime
  code/configuration and tests.

Limits:

- The four historical Codex executor tasks were read directly by exact thread
  ID. Their current titles are `Ассистент`, `Модератор`, `Привратник` and
  `База знаний`; all four are currently `notLoaded` rather than active writers.
- Historical handoffs prove acceptance/provenance, not current deployment.
- Production below means the last receipt-backed state (`f51753f`) until a new
  read-only preflight and post-deploy verification are recorded.
- The former dialog archive was empty. Available local transcripts can be
  archived now, but already deleted source transcripts cannot be reconstructed.

## Session, ownership and continuity instructions

| Product Owner instruction | Result | Evidence / gap |
|---|---|---|
| Create Assistant, Moderator, Gatekeeper and Knowledge Base executor sessions with ownership, boundaries, integrator handoff and ability to spawn helpers | `done`, later `superseded` | Four thread IDs, charters, isolated worktrees and acceptance records exist in `.handoffs/`; governance later removed permanent per-module executors. |
| Remove `AIchatTG —` and then `Исполнитель` from task names | `done` | Direct reads by exact thread ID return titles `Ассистент`, `Модератор`, `Привратник`, `База знаний`; registry labels match. |
| Create a News-style registry adapted to AIchatTG | `done`, later `superseded` | `.handoffs/active-module-registry.md` contains the exact historical model and now declares itself provenance-only. |
| Transfer unfinished News Assistant/Moderator/Gatekeeper work; no Knowledge Base transfer | `done` | Three accepted handoff hashes and explicit Knowledge Base exclusion are preserved; News retirement was acknowledged. |
| Keep News Telegram publisher in News; isolate AIchatTG runtime/data/secrets | `done` | `AGENTS.md`, Compose/data boundaries and migration docs prohibit direct News DB/runtime sharing. |
| Do not involve the owner in routine executor synchronization | `done` | One active root integrator coordinates bounded subagents; production/decision gates remain with the owner. |
| Replace permanent module executors with one root integrator/executor | `done`, wording corrected | Governance is now tool-independent: exactly one active Codex or Claude Code root session, never two simultaneous controllers. |
| Dialogs must not have a deletion term | `partial` → local fix prepared | Claude's source setting is finite (`cleanupPeriodDays=36500`) and cannot prove literal infinity; project archive was empty. `scripts/save-dialogs.sh` now copies available Claude Code and current Codex JSONL to a Git-ignored local archive with no deletion routine. Disk backup remains open. |

## Product and knowledge instructions

| Product Owner instruction | Result | Evidence / gap |
|---|---|---|
| Build course knowledge from courses 157689 and 143216, local test first, content-addressed admission | `done`, production-verified historically | Package `ai-140310bf9472`, signed manifests, schema/digest checks and production enablement receipt are documented. |
| Support multiple course/domain slices without direct News access | `done` | `org` and `value` slices plus course package have separate validated admission paths. |
| Return complete links as part of the funnel | `done`; content acceptance still open | Link-aware answer path exists; the remaining judge does not verify factual grounding to supplied knowledge. |
| Use site/production source of truth for organization and price; do not invent static values | `done` | Operational slice and source hierarchy are documented and tested. |
| Preserve the value thesis for “magic pill / no time” questions | `done` | Value slice is admitted and routed separately from lessons. |
| Out-of-domain request must return an honest boundary/deficit, not silence | `done` | Code-owned boundary response and deficit classifications exist. |
| Answer with Terra/medium; judge with Terra/high rather than Luna | `done` for live answer model; `proposed` for grounding judge | Runtime tuple is Terra/medium. A content-grounding acceptance leg remains backlog work. |
| Use real questions for evaluation; synthetic traffic only in test chat; iterate 2–3 times | `done` | Analyzer/synthetic gates and production-chat boundaries are recorded in release `0.4.0`. |

## User experience and reported live defects

| Product Owner report/instruction | Result | Evidence / gap |
|---|---|---|
| Retire `/ai`; accept `/ask` anywhere, mention anywhere, reply to bot; stay silent when unaddressed; hint on bare `/ask` | `done`, production image `f51753f` | Detection, privacy-mode behavior and forced-reply flow are covered by tests and `0.5.1`. |
| Empty service reply must not poison dialogue history | `done`, deployed before current candidate | Regression described in changelog/history. |
| Do not assert an unstated “managerial literacy” fact | `done`, deployed before current candidate | Answer path and historical fix are preserved in Git history. |
| Render Markdown safely and split long Telegram answers | `done`, production release `0.3.1` | Single render call site and chunked delivery are documented/tested. |
| “Что ты можешь?” must describe the assistant, not return course-boundary refusal | `done` locally, not yet production-verified | `2c02c56`; deterministic self-description runs before knowledge retrieval. |
| Help/profile must describe reply, `/ask` and mention consistently | `done` locally | Help was fixed in `2c02c56`; current candidate fixes profile copy and tests it. |
| Temporary `/ask` service prompt should disappear after a real answer | `done` locally | Exact-text-scoped delete; Telegram refusal is now logged without costing the answer. |
| Delete the user's own `/ask@bot` clutter too | `partial` | Requires `can_delete_messages`; rights were not checked and no permission change is authorized. |
| Add a simple web UI for basic Assistant settings | `proposed` | Product scope is not specified; retained in backlog. |
| Status messages should show concrete work/progress | `partial` | Operating rules now require evidence-led updates, but historical chat style is not machine-testable. |

## 2026-09-14 runtime, documentation and infrastructure findings

| Finding / instruction | Result | Evidence / gap |
|---|---|---|
| Enable Assistant in the third chat | `done`, production-verified historically | Configuration-only receipt, same coverage as Moderator. |
| Deploy shared dialogue snapshot (waves 1–3) | `done` | Waves 1–2 live in `0.5.0`; wave 3 intentionally remains a local lab tool. |
| Add bounded Telegram/model calls | `done` locally | Defaults 15 s / 45 s; validated range; one attempt; timeout remains ambiguous and non-retryable. |
| Acknowledge webhook immediately and process in per-chat queue | `proposed`, intentionally not faked | In-memory ACK can lose an update after HTTP 200 and crash. Requires durable inbox, recovery semantics and a migration/release plan. |
| Pass rewrite model/reasoning through Compose | `done` locally | Compose and compose-contract test include both variables; rewrite remains off pending paid-call approval. |
| Remove hidden hardcoded 3-turn dialogue cap | `done` locally | Store query's configured limit controls turn count; projection retains the newest complete tail under an independent 50k serialized-size safety budget. |
| Reconcile drifted README/CHANGELOG/config/status docs | `done` locally | Current production baseline is consistently `f51753f`; older report is explicitly historical. |
| Keep a durable owner feedback/history log | `done` with recovered-history limitation | This report adds source inventory and full matrix; `OWNER_FEEDBACK_LOG.md` now allows partial/superseded/inconclusive outcomes. |
| Prevent Docker-log incident globally for every deployed project, Codex and Claude Code | `done` for repository/global rules | Safe bounded wrapper and global/project rules require `timeout`, `--tail`, `--since`, no background follow and no looped retry on exit 124. |
| Fix unsafe Claude framework automation | `done` locally | PreCompact is read-only; finish fails closed; repo-access switch avoids bulk staging; SQLite migration skill matches this runtime. |
| Activate Gatekeeper in production | `proposed`, not a generic bug | Requires owner copy, two HTTPS links, console placement and a separate exact activation lease. |

## Candidate conclusion

- `passed`: every recoverable instruction is classified; locally actionable
  runtime, documentation and framework defects are repaired in this candidate.
- `proposed`: durable webhook inbox, grounding acceptance, settings UI and
  Gatekeeper activation remain product/architecture work, not silently claimed
  as fixes.
- `inconclusive`: only source transcripts already removed before archiving;
  their absence cannot prove what they contained.
- `not_run`: new production state until exact candidate deployment and
  post-deploy verification.
