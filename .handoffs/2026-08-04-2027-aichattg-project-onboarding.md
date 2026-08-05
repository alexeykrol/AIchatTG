# Session Continuation: AIchatTG project onboarding

## Metadata

- MODE: continuation
- Transfer kind: control-rollover
- Reason: the Product Owner opened AIchatTG as its own Codex project and needs one grounded controller for the extracted Telegram product.
- Created: 2026-08-04T20:27:41-0700
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Controller generation: 1
- Resume ref: `e7ee5d441ce4b95c816b6f063f7b50f0629bcb38`
- Relevant dirty paths: none; canonical `main` was clean and matched `origin/main` when this handoff was prepared.

## Goal and Exact Resume Point

AIchatTG is the standalone QuestTales Telegram product for Moderator, Assistant
and Gatekeeper/onboarding. News is separate and retains digest/editorial work,
Telegram channel publication and editorial Telegram intake.

Moderator, Assistant and the console are production-verified at `e7ee5d4` on
`aikrol.questtales.com`. News was cleaned/deployed separately at `6b9dc31`.
The applications share no database, `.env`, source, Compose or release artifact.

Gatekeeper source is integrated under `apps/gatekeeper`, but it is intentionally
not running: `ONBOARDING_SCENARIO.md` remains `draft` with Product Owner content
placeholders. Course knowledge is intentionally disabled and the old News course
index was not copied. Historical state import is also `not_run` and is optional.

The canonical project folder is `/Users/alexeykrolmini/Code/AIchatTG`.
`/Users/alexeykrolmini/Code/AIchatTG-worktrees` and `.codex/worktrees/**` are
auxiliary Git worktrees, not alternative project roots and not release sources.

## Permanent Integrator and Executor Model

The successor becomes the **permanent AIchatTG integrator**, analogous to the
News integrator. It owns the active-module registry, executor lifecycle,
cross-bot architecture, shared core/schema/entrypoints/Compose, candidate
acceptance, canonical `main`, release queue, production lock, rollback and
receipt acceptance.

The integrator creates Product Owner-facing executors for Moderator, Assistant,
Gatekeeper/onboarding and future modules, plus bounded assurance children. It
classifies each as `user-visible-workstream` or `service-child`; user-visible
sessions remain until replaced/retired, while consumed service children are
archived after their worktree and attention/lease state are clear.

Executors have the same contract as News executors:

1. Own only chartered paths/contracts in an isolated branch/worktree.
2. May inspect, implement, test, commit and push an in-scope candidate.
3. Submit Mandatory Release Visibility: production/base/candidate identities,
   deployed/recovered/new ledgers, stats, migrations/config/shared impact,
   rollback, and `passed`/`failed`/`not_run`/`inconclusive`.
4. The integrator independently accepts/rejects and resolves shared conflicts.
5. Production requires Product Owner approval for the exact candidate, then an
   integrator lease naming SHA, services, scope, rollback, expiry and stops.
6. The executor may mechanically deploy under that lease and return a receipt;
   the integrator accepts it and retains shared production ownership.

Overlays, concurrent rebuilds, unreviewed shared-core edits, secrets, paid
calls and external/production actions outside the charter and gates are
forbidden. The Product Owner decides product and attention gates; Codex handles
session creation, handoffs, integration and conflict prevention internally.

## Authority and Attention Gates

- Authorized now: read-only orientation, local inspection, tests, plans, and reversible candidate work explicitly requested by the Product Owner.
- Production gate: blocked until the Product Owner approves an exact candidate and the controller issues a one-time lease naming SHA, services, scope, rollback, expiry, verification, and stop rules.
- Spending gate: blocked; no paid model/provider call without explicit target and cap.
- External gate: no Telegram message, webhook mutation, Gatekeeper activation, secret/config change, migration, or publication without exact approval.
- Stop/escalate for: new course knowledge admission, Gatekeeper final copy/links and activation, historical-state import, privacy/schema decisions, or any cross-project API contract.

## Active Work Registry

| ID | Executor | Status | Ownership | Ref/worktree | Evidence | Next owner |
|---|---|---|---|---|---|---|
| project-control-g1 | new AIchatTG permanent integrator | prepared | repository, active-module registry, shared contracts, integration queue, production lock and release lifecycle | `main@e7ee5d4` | this handoff | successor integrator |
| runtime-console | controller | production-verified | Moderator, Assistant, operator console | `e7ee5d4` | healthy/restart `0`, public health `200` | controller |

No module writer is currently active. Registry executor names refer to former
News-era provenance; replace them only after successor acceptance and a Product
Owner workstream decision.

## Verified Delta

- `passed`: local and remote `main` were exact `e7ee5d441ce4b95c816b6f063f7b50f0629bcb38`; canonical worktree clean.
- `passed`: production runtime container `9fecd657...` and console container `5df74da7...` were healthy, restart `0`, and labeled with exact `e7ee5d4`.
- `passed`: `https://aikrol.questtales.com/health` returned `200`; unauthenticated console root returned `401`.
- `passed`: the final local aggregate gate on exact source was 220 tests.
- `passed`: Moderator and Assistant Telegram webhook ownership was read back on `aikrol.questtales.com`, with pending updates `0` and no current error.
- `failed`: none at the handoff checkpoint.
- `not_run`: Gatekeeper production activation, new course-index build/admission, historical state import, live Telegram smoke, paid provider call.
- `inconclusive`: future live semantic behavior and Gatekeeper onboarding until their own approved tests run.

## Integration State

- Accepted: standalone repository/runtime boundary, shared Telegram core, Moderator and Assistant adapters, recovery/durability contracts, operator console, isolated Gatekeeper source, deployment infrastructure.
- Pending: no frozen code candidate. Product-stage gates remain Gatekeeper content/activation, a new course knowledge snapshot, and optional historical import.
- Rejected/quarantined: old News SQLite, old News course index, server overlays, dual-write, and auxiliary worktrees as release sources.
- Integration owner/target: exactly one AIchatTG controller; canonical target is `/Users/alexeykrolmini/Code/AIchatTG` branch `main`.

## Read Now

- `/Users/alexeykrolmini/Code/AIchatTG/AGENTS.md` — ownership, release, evidence, and session rules.
- `/Users/alexeykrolmini/Code/AIchatTG/README.md` — product architecture, application layout, and local checks.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/MIGRATION_FROM_NEWS.md` — completed extraction and intentionally independent remaining stages.

## Ground Checks

```bash
git -C /Users/alexeykrolmini/Code/AIchatTG status --short --branch && git -C /Users/alexeykrolmini/Code/AIchatTG rev-parse HEAD && git -C /Users/alexeykrolmini/Code/AIchatTG ls-remote origin refs/heads/main
npm --prefix /Users/alexeykrolmini/Code/AIchatTG test
ssh news-vps 'for c in aichattg-aichattg-telegram-runtime-1 aichattg-aichattg-operator-console-1; do docker inspect -f "{{.Name}} revision={{index .Config.Labels \"org.opencontainers.image.revision\"}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restart={{.RestartCount}}" "$c"; done' && curl -fsS https://aikrol.questtales.com/health
```

Expected: clean `main`, local and remote SHA `e7ee5d4`; aggregate tests pass;
both deployed services report exact `e7ee5d4`, healthy, restart `0`; public health
returns the AIchatTG console health payload.

## Next Safe Action

The new AIchatTG project task reads this handoff, runs the ground checks, and
accepts controller generation 1 as the permanent AIchatTG integrator. It should
then give the Product Owner a short orientation summary, confirm that it will
create and govern module executor sessions under the contract above, and wait
for the first concrete AIchatTG task. It must not activate Gatekeeper, import
course knowledge/history, change webhooks, or deploy anything merely as part of
onboarding.

## References On Demand

- `/Users/alexeykrolmini/Code/AIchatTG/.handoffs/active-module-registry.md` — consult when assigning or retiring a user-visible workstream.
- `/Users/alexeykrolmini/Code/AIchatTG/infra/aichattg/docker-compose.yml` — consult for service/data/route boundaries before a release.
- `/Users/alexeykrolmini/Code/AIchatTG/apps/gatekeeper/ONBOARDING_SCENARIO.md` — consult only when Gatekeeper copy or activation is requested.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/RUNTIME_STATE_IMPORT.md` — consult only if the Product Owner requests historical state migration.

## Successor Directive

```text
You are the permanent successor orchestrator/integrator for
`/Users/alexeykrolmini/Code/AIchatTG`. You own its registry, executor lifecycle,
shared contracts, integration queue and production lock. Executors work inside
charters and deploy only under your exact lease after Product Owner approval.

First read:
`/Users/alexeykrolmini/.codex/AGENTS.md`
and every applicable project-level `AGENTS.md`.

Then read this continuation:
`/Users/alexeykrolmini/Code/AIchatTG/.handoffs/2026-08-04-2027-aichattg-project-onboarding.md`

Read only “Read Now”, run “Ground Checks”, and verify controller generation,
resume ref, relevant dirty paths, active ownership, and integration state.

If they match, reply internally:
CONTROL ACCEPTED: generation 1
Role: permanent AIchatTG integrator
Resume point: AIchatTG main and production are exact e7ee5d4; Gatekeeper, course knowledge, and history import remain gated.

Then continue “Next Safe Action” without asking the user to coordinate sessions.
If they do not match, reply CONTROL REJECTED with the exact contradiction and
enter recovery. Production and spending remain blocked unless the continuation
names a valid explicit approval or strict strategy.
```
