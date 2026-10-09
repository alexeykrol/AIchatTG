# Handoff (general): continue AIchatTG root-integrator work on another machine

## Metadata

- Created: 2026-10-09T14:23:03Z
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Branch: `main`
- Stable refs: `051bf9e` (HEAD of `main` and `origin/main`, 2026-09-24 —
  "docs(moderation): record acceptance stop and exact selector gate");
  `c019a35` (prepared source-evidence-selector candidate, planned Assistant
  `2.4.45`, not deployed); `ccea9af` (last production-verified Assistant
  runtime image, `2.4.43`, per SNAPSHOT — not re-verified this session)
- Source description: owner asked to commit everything, push to GitHub, and
  leave a full-status handoff so work can continue from a different machine.
  Nothing was in flight locally — this handoff exists to transfer the
  *current, already-committed* state, not to close out new work.
- TYPE: general

## Role & Scope

You are picking up the same role the previous session held: candidate for
**repository-root integrator and executor** per `AGENTS.md` ("Integrator and
executor protocol"). That role is global for this repo — no module boundary —
but there is **exactly one active root integrator at a time** (Codex or
Claude Code), assigned by the Product Owner. Do not assume you hold the seat
just because you opened the repo; confirm with the owner first (see Open
Questions). Once confirmed, you work autonomously (decomposition, subagents,
tests, commits) and only raise the owner on a production-change stop or a
genuine blocker.

## Project Context

AIchatTG is a Node.js ESM npm-workspace monorepo running three Telegram bots
(Moderator, Assistant, Gatekeeper — Gatekeeper not yet activated in
production) over one shared runtime, plus a read-only operator console. It
lives on a shared VPS (`news-vps`) but owns its own container, database
(SQLite, local-first), secrets and webhook routes — no shared runtime with
the separate News Digest project. Governance since 2026-09-14: a single
root-integrator session (Codex or Claude Code, PO-assigned) does all
decomposition and routine work autonomously; the one hard stop is any
production-affecting change (deploy, webhook, config/secret, migration,
paid-model policy), which needs explicit, change-specific Product Owner
approval and a lifecycle report (`prepared` → `pushed` → `PO-approved` →
`deployed` → `production-verified`).

## Read First

- `/Users/alexeykrolmini/Code/AIchatTG/AGENTS.md` — governance, safety,
  advertising-moderation protocol, release-identity contract
- `/Users/alexeykrolmini/Code/AIchatTG/CLAUDE.md` — operating mode, two-axis
  memory layout
- `/Users/alexeykrolmini/Code/AIchatTG/.claude/SNAPSHOT.md` — dense,
  Codex-style chronological state log (current through 2026-09-24)
- `/Users/alexeykrolmini/Code/AIchatTG/.claude/BACKLOG.md` — Next/Soon/Later,
  current through 2026-09-24
- `/Users/alexeykrolmini/Code/AIchatTG/.claude/ARCHITECTURE.md` and
  `.claude/INVARIANTS.md` — system map and hard product rules
- `/Users/alexeykrolmini/Code/AIchatTG/docs/OWNER_FEEDBACK_LOG.md` — **stale**,
  last entry 2026-09-15 (see Open Questions)
- `/Users/alexeykrolmini/Code/AIchatTG/docs/RELEASE_QUEUE.md` and
  `docs/MODERATION_REVIEW_ACTIVATION.md` — private-Review activation state

## Grounded Facts (verified)

- `git status --short --branch` → `## main...origin/main` with **no other
  output** — working tree clean, nothing ahead/behind.
- `git rev-list --left-right --count origin/main...main` → `0  0`.
- `git log -1 --format='%H %ai %an' origin/main` →
  `051bf9e… 2026-09-24 07:24:28 -0700 Alexey Krol` — **no commits on `main`
  since 2026-09-24**, 15 days before this handoff.
- `cat apps/telegram-runtime/src/assistant-release.json` →
  `{"version":"2.4.45","releasedOn":"2026-09-24"}`. This is the **prepared
  candidate's** version bump (commit `c019a35`), not proof of a production
  deploy — SNAPSHOT.md's own last `production-verified` line names `2.4.43`
  / image `ccea9af`. Don't conflate the two.
- `node -v` → `v24.14.0`. `package.json` `engines.node` → `>=20.20.0 <21`.
  **Mismatch in this shell.** `better-sqlite3`'s native binding must be
  rebuilt against whichever Node actually runs the tests
  (`export PATH="$HOME/.nvm/versions/node/v20.20.0/bin:$PATH"` then
  `npm rebuild better-sqlite3` was the fix used in an earlier session — `nvm
  use` alone did not reliably change what child `npm`/`node-gyp` processes
  saw). **No test run was attempted this session** — don't trust a stale
  green/red claim from SNAPSHOT without re-running `npm test` yourself after
  fixing this.
- `cat manifest.md` → `repo_access=private-solo` — commit-policy allows
  committing everything, including `.claude/`, `CLAUDE.md`, `.handoffs/`.

## Current State

Done (verified):
- Full Claude Code Starter framework install in this repo (`CLAUDE.md`,
  `.claude/{SNAPSHOT,BACKLOG,ARCHITECTURE,INVARIANTS}.md`, rules/skills/
  agents/hooks) — completed and committed in an earlier session
  (2026-09-14), now stable; nothing from that install is pending.
- `main` and `origin/main` are identical at `051bf9e`; no local changes
  anywhere in the tree besides this handoff file.
- Per SNAPSHOT.md's own log (not independently re-verified live this
  session): an extended moderation/advertising/porn-spam enforcement effort
  ran 2026-09-15 through 2026-09-24, with several production deploys up to
  Assistant `2.4.43` / image `ccea9af`, each with a deployment receipt under
  `docs/reports/`.

Pending (see `.claude/BACKLOG.md` → `Next`/`Soon`/`Later` for the full,
exact wording — summarized here, do not treat this summary as the source of
truth):
- **SOURCE-EVIDENCE-SELECTOR** — candidate `c019a35` (planned `2.4.45`)
  replaces provider-generated advertising-evidence quotes with a code-owned
  selector; its real-model acceptance run stopped on the 3rd case
  (`threat_evidence_not_verbatim`). Needs a fresh bounded real-model test
  approval before any push/deploy decision.
- **PORN-PROFILE-RECURRENCE** — candidate `d8e5583` (planned `2.4.44`)
  prepared; real-model test (≤30 calls / ≤$2 / ≤30 min) never approved/run.
- **NATIVE-ACCEPTANCE-2.4.41**, **REVIEW-LIVE-ACCEPTANCE**,
  **ADVERTISING-MODEL-ACCEPTANCE** — each a distinct live-acceptance leg
  marked `not_run`, each needs its own owner-authorized test window.
- **ASK-ROUTER-INVALID** — exact root cause of one historical routing
  rejection still unknown; partial mitigation already shipped.
- **KNOWLEDGE-COVERAGE-COPY-1** — a reported stale-knowledge-copy symptom;
  cause not proven live.
- **RISK-1** — durable webhook inbox + per-chat worker recovery; not
  designed. Immediate HTTP 200 without a durable write is a known update-loss
  risk on process crash.
- **HYGIENE-1** — the "delete the triggering `/ask@bot` command, not just the
  bot's hint" half of chat hygiene; Moderator's delete rights are confirmed in
  all three groups, Assistant's only in the test chat; still needs an
  ordinary-user live check, not just a synthetic one.
- **GATEKEEPER-1** — Gatekeeper bot is code-complete but **not activated** in
  production; blocked on Product Owner copy + two HTTPS links + an Operator
  Console placement decision.
- **QUALITY-1/QUALITY-2** — content-grounding acceptance gaps surfaced by an
  earlier live baseline run.
- **SETTINGS-UI-1**, **ARCHIVE-BACKUP-1** — low-priority, `Later`.

## Files / Contracts In Scope

This is a general/root-integrator handoff — scope is the whole repo, not one
module. Load-bearing files to know about:

- `AGENTS.md` — the actual rulebook; re-read before any production action
- `apps/telegram-runtime/src/assistant-release.json` — single source of the
  Assistant's public version/date; bump + date on any Assistant-affecting
  release
- `scripts/aichattg/verify-release-source.sh` — run before any deploy
- `docs/reports/*.md` — one receipt per deployment/acceptance run; the
  pattern to follow for any new candidate
- `.claude/SNAPSHOT.md` / `.claude/BACKLOG.md` — update both when you change
  state, per this repo's own `context-management.md`/`autonomy.md` rules

## Decisions Made

- No code or doc changes were made this session beyond this handoff file —
  the repo was already clean and in sync with `origin/main`. "Commit
  everything and push" resolved to "nothing new exists to commit" once
  verified; only this handoff is new.
- Did not attempt to reconcile `docs/OWNER_FEEDBACK_LOG.md` against the
  September 23–24 moderation/advertising work (see Open Questions) — that is
  a judgment call about what counts as an owner-reported incident, not a
  factual correction, and the skill guiding this handoff says not to
  fabricate reconciliation when it needs an owner decision.
- Treated a prior memory note from 2026-09-14 ("Claude Code sole
  integrator, no Codex controller") as **superseded**: `AGENTS.md` as read
  today again describes a dual-agent model (Codex or Claude Code, exactly
  one active root integrator, PO-assigned). That memory file is being
  corrected separately from this handoff.

## Open Questions / Blockers

- **Who currently holds the root-integrator seat?** Nothing in the repo
  states it as of 2026-10-09 (the last handoff/charter activity is from
  2026-09-15-and-earlier `.handoffs/*-charter.md` files, which `AGENTS.md`
  itself calls historical). Ask the Product Owner before assuming you're the
  active integrator.
- **`docs/OWNER_FEEDBACK_LOG.md` gap:** last entry is 2026-09-15; the
  2026-09-23/24 advertising and porn-spam enforcement work in SNAPSHOT.md
  reads as owner-directed (explicit PO approvals, PO corrections like "Review
  alone is insufficient") but was never logged there. `AGENTS.md` says to
  append an entry "whenever the Product Owner reports something in chat" —
  whether these incidents qualify (vs. being purely agent-run test/deploy
  cycles) needs the owner's or next session's judgment, not a guess.
- **Test suite baseline unknown right now** — Node version mismatch (see
  Grounded Facts) means no one has actually run `npm test` fresh since at
  least this session's start. Don't trust SNAPSHOT's historical pass counts
  as current without re-running.

## Recommended Next Move

Before touching any BACKLOG item: confirm with the Product Owner (a) that you
hold the root-integrator seat for this task, and (b) which open item to work
on first. Then fix the Node version mismatch (`nvm use 20.20.0` + `PATH`
export + `npm rebuild better-sqlite3`) and run `npm run test:runtime` to get a
fresh baseline before trusting any inherited "passed" count. The two
cheapest, most self-contained open items if the owner has no preference are
**HYGIENE-1** (just needs one ordinary-user live check) and **GATEKEEPER-1**
(blocked only on owner copy/links/placement, not code).

## Kickoff Prompt

```text
Ты новая Claude Code / Codex session для
`/Users/alexeykrolmini/Code/AIchatTG`. Сначала открой и прочитай handoff:
`/Users/alexeykrolmini/Code/AIchatTG/.handoffs/2026-10-09-0723-cross-machine-continuation.md`

Затем прочитай AGENTS.md, CLAUDE.md, .claude/SNAPSHOT.md, .claude/BACKLOG.md.
После этого GROUND-VERIFY факты командами из раздела "Grounded Facts" этого
handoff (git status/log, node -v, manifest.md) — не доверяй метафайлам без
проверки, они могли устареть за 15 дней без коммитов.

Твоя роль: кандидат на repository-root integrator (Codex или Claude Code —
ровно один активен за раз, назначает Product Owner). Пока не подтверждено
владельцем, что место твоё — не начинай production-изменения и не считай
BACKLOG приоритеты окончательными без его слова.

После чтения и проверки выдай в чат Verification Report:
- Understood: роль, scope, задача своими словами.
- Verified: какие команды прогнал и совпали ли факты (с реальными числами).
- Discrepancies: расхождения или `—`.
- Questions: вопросы (минимум: кто сейчас root integrator) или `—`.
- Readiness: `ready on confirmation` / `blocked: ...`, плюс предложенный
  первый шаг.

Не начинай работу до подтверждения owner.
```
