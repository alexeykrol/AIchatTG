# Codex worker protocol

Product Owner decision, 2026-11-20: the Claude Code root session stays the single AIchatTG
integrator; Codex is extra compute that runs isolated tasks for it on the owner's ChatGPT
subscription (no API spend). This file is the contract between the two. It is given to Codex with
every task; `AGENTS.md` points here.

## Roles

- **Integrator** — the Claude Code repository-root session. It decomposes work, writes a charter per
  task, launches the worker with `scripts/codex-worker.sh`, reviews the result, runs the tests,
  merges, pushes and updates project state. It is the only one who talks to the Product Owner.
- **Worker** — one `codex exec` run per task. It has no standing role and no memory between tasks:
  everything it needs is in the charter and in the files the charter names.

## Two task modes

| Mode | Use | Where the worker writes | Result |
| --- | --- | --- | --- |
| `report` | research, analysis, data generation, review, judging | only `output/codex/<task>/` (not in git) | files there + `REPORT.md` |
| `code` | an isolated code change | only its own git worktree on branch `codex/<task>` | uncommitted changes in that worktree + `REPORT.md` in the worktree root (untracked); the integrator commits them on the branch |

The worker never writes to the main working tree at `~/Code/AIchatTG`. The launcher enforces this
with the Codex sandbox (`workspace-write`: writes only inside the task directory, network off).

## Rules for the worker

1. **Stay inside the charter.** Do exactly the task described. If the charter is ambiguous or the
   task needs a file outside your write area, stop and say so in `REPORT.md`; do not guess and do
   not widen the scope.
2. **Isolation.** Change only the paths the charter lists. The integrator alone edits shared
   contracts: `AGENTS.md`, `CLAUDE.md`, `.claude/`, `package.json` and lock files, `infra/`,
   database schema (`apps/telegram-runtime/src/database.mjs`),
   `apps/telegram-runtime/src/assistant-release.json`, CI and release scripts, this protocol. A
   charter may name them as read-only inputs, never as files to change.
3. **Commits (code mode only).** The sandbox keeps git metadata read-only (measured 2026-11-20:
   the index lock of a worktree is refused), so do not try to commit: leave your changes
   uncommitted in the worktree, list every changed path in `REPORT.md`, and write
   `uncommitted: sandbox` in its Commits section. The integrator reviews them and commits the named
   paths on your branch `codex/<task>` with the prefix `codex(<task>):`. Never run `git add -A`,
   `git add .`, `git stash` or `git checkout` of other paths.
4. **Never** push, pull, fetch, merge, rebase, tag, switch or delete branches, or change the main
   branch. Never deploy, never open SSH or any remote connection, never touch production.
5. **No network and no paid calls.** No model or API calls of any kind, no package installs. Local
   free runs are fine (`node`, `python3`, `sqlite3` read-only). Node 20 lives in
   `$HOME/.nvm/versions/node/v20.20.0/bin`.
6. **Secrets and private data.** Do not open, print or copy `.env*` files, keys, tokens,
   `~/Code/operations/creds/`, or `dialog/` and `.claude/dialogs/` folders. No user identifiers in
   any output.
7. **Read-only outside your write area.** Other projects (`~/Code/agi`, `~/Code/agi2claude`,
   `~/Code/allcourses`, `~/Code/Доноры`, `~/Code/BestMentor_Plugin`) are read-only reference.
8. **Evaluation hygiene.** A task that builds or enriches a knowledge base must not read the test
   questions or their reference answers (`~/Code/agi2claude/evals/`, `scripts/eval/heldout/`, `output/eval/runs/`,
   `output/eval/judge*`), unless the charter says the task is about them.
9. **Evidence, not optimism.** Report every check as exactly one of `passed`, `failed`, `not_run`,
   `inconclusive`, with the command and exit status. Run a check at most three times, and retry
   only after a relevant fix or a transient local error; still red → report `failed` and stop.
   Single-shot probes are never retried. Never claim something you did not run.

## Sandbox probe (handshake tasks only)

A charter may authorise one out-of-area write probe and one network probe, with the exact commands
named in that charter. This is a test of the launcher, not a breach of rules 4, 5 and 7: run each
command once, record the exit code and the visible output, do not retry, do not work around a
refusal, do not clean up outside the task directory. A refused operation is `passed`; an outcome
whose cause cannot be observed is `inconclusive`; an operation that succeeds is `failed` — say so
prominently, the launcher is misconfigured.

## `REPORT.md` (the worker's last act)

```
# <task> — report
Status: passed | failed | not_run | inconclusive
## What was done            (3–10 lines)
## Files                    (path — created/changed)
## Checks                   (command — exit status — passed/failed/not_run/inconclusive;
                             for a command not run, the reason in place of the exit status)
## Commits                  (code mode: "uncommitted: sandbox"; report mode: "report mode")
## Deviations and open questions
```

## Rules for the integrator

- One charter per task: goal, context, files to read, exact output paths, allowed changes, checks to
  run, stop conditions. Without a charter the worker is not launched. The worker obeys stop
  conditions literally (measured 2026-11-20: two stops on a missing file in the allowed list and on
  a baseline number quoted for the wrong setting), so name only real blockers, list every file the
  change can touch, and quote only numbers you verified together with their settings; for a
  mismatch of an expected number prefer "report and continue".
- Parallel workers only on tasks that do not write the same files; one writer per shared contract.
- Nothing from a worker reaches `main` without review: read the diff and run the relevant tests
  (`npm test` for runtime code). Code mode: commit the named paths on the worker's branch
  (`codex(<task>): …`), then merge that branch. Report mode: copy only the approved deliverables
  into tracked paths and commit them. Only the integrator pushes. A `failed` or `inconclusive`
  result is not merged as done.
- The integrator records the result in project state (`.claude/SNAPSHOT.md`, backlog, reports).
- **Resource discipline (Product Owner, 2026-11-20).** The subscription quota is shared with the
  owner's own work. Default is `gpt-6.2-sol` with `medium` reasoning — the everyday coding model.
  `high` effort or `gpt-6.2-astra` only for a hard analytical task, named as such in the charter;
  `gpt-6-luna` for trivial bulk work. Do not launch a worker for something a script does.
- Worker transcripts stay local (`output/codex/<task>/events.jsonl`), never in git.

## Launch

```
scripts/codex-worker.sh report <task> <charter.md>     # output/codex/<task>/
scripts/codex-worker.sh code   <task> <charter.md>     # worktree, branch codex/<task>
```
