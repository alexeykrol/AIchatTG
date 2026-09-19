# AIchatTG

AIchatTG is the standalone Telegram product for QuestTales. It unifies three
specialised bots over one product core:

- **Moderator** protects chats and applies moderation policy.
- **Assistant** answers, navigates course material, and supports users.
- **Gatekeeper** verifies entry, runs onboarding, and hands a participant to
  the other Telegram capabilities.

News intake, digest generation, editorial review, and publication — including
publication to a Telegram channel — remain in the separate News Digest project.

**Production checkpoint19.09 22:07UTC:** Assistant2.4.41 / exacte523485 and
Console3.2.0 / f650fe8 are healthy. The safety response contract is aligned;
approved irrelevant-question copy is unchanged. Main is pushed but also
contains pending Review code; only the isolated runtime candidate was deployed.
Review remains off. Its old7d99ae0 retry is superseded: a future candidate must
retain this fix and pass new release/approval gates.
[Receipt](docs/reports/2026-09-19-assistant-2.4.41-deployment.md).

**Live acceptance follow-up19.09 22:34UTC:** five safe inputs and12 real model
calls passed bounded technical checks. Website routing differs between legacy
and test-chat dispatch; both observed answers respect their source boundaries.
Native Telegram delivery/cleanup remains untested because the available actor
is exempt. No new deploy; run closed.
[Scope and evidence](docs/reports/2026-09-19-assistant-2.4.41-live-acceptance.md).

**Local Review retry candidate:** Assistant2.4.42 / Console3.4.0, exactebf0a8a,
lifecycle `prepared`. It preserves the deployed safety repair and passes the
local gates; it is not pushed or deployed. Fresh approval must include the
retained Review boundary and current rollback baseline.
[Candidate and remaining gates](docs/reports/2026-09-19-review-retry-candidate.md).

## Architecture principle

The Assistant uses a [universal Markdown domain registry](docs/ASSISTANT_DOMAIN_REGISTRY_V1.md),
deployed in `5600afd`. It separates domain recognition from knowledge organization;
the [release receipt](docs/reports/2026-09-15-runtime-5600afd-deployment.md) distinguishes
verified infrastructure from the still-open live answer-quality acceptance.

The VPS and Traefik are shared infrastructure. AIchatTG is nevertheless a
separate application: it owns its repository, release archive, containers,
database, data root, secrets, bot webhook paths, health endpoint, and release
receipt. It must never read the News Digest database directly.

The current migration is documented in
[docs/MIGRATION_FROM_NEWS.md](docs/MIGRATION_FROM_NEWS.md). Gatekeeper has
been ported with an isolated persistence boundary and a host-portable container
contract. Moderator and Assistant are now ported into their own runtime with a
safety disposition barrier, fenced inbound receipts, bounded per-user dialogue
state and code-owned public fallback replies.
The separate Compose release defines independent images, data roots and routes
at `aikrol.questtales.com`. Moderator, Assistant and the operator console have
completed their application cutover.

**Course knowledge is live since 2026-08-15** (image `8579023`): the reviewed
`ai-140310bf9472` package plus the `org` and `value` slices are admitted, and
`TELEGRAM_RUNTIME_ASSISTANT_KNOWLEDGE_ENABLED` / `..._RETRIEVAL_ENABLED` are
`true` in production. Enablement, layout and rollback are documented in
[docs/ASSISTANT_KNOWLEDGE_ENABLEMENT.md](docs/ASSISTANT_KNOWLEDGE_ENABLEMENT.md).
Question rewriting before retrieval (`..._RETRIEVAL_REWRITE_ENABLED`) stays off.
Gatekeeper activation and any historical state import remain separate reviewed
stages.

**Answer rendering is live since 2026-08-16** (image `0e12a87`): the model's
Markdown is rendered to Telegram HTML at the single call site where the model
wrote the text, and an over-limit answer is split before sending rather than
rejected whole by Telegram. Deterministic and service replies stay code-owned
plain text. See [CHANGELOG 0.3.1](CHANGELOG.md) and
`packages/telegram-core/src/markup.mjs`.

**Release `0.4.0` image: `5e67451`** (built 2026-08-16, deployed
2026-08-17 and later superseded). It added the request analyzer (`observe` / `dispatch` modes;
`dispatch` is on in the test chat only, where the analyzer verdict chooses the
route and the router model is not called), synthetic testing with one named
synthetic bot and its own daily cap, durable question → answer records in
analyzer chats, and token-usage accounting on every paid call including
moderation. Models: answer `gpt-5.6-terra` (medium, 2000), router
`gpt-5.6-luna` (low, 256), moderation `gpt-5.6-terra` (medium, 1024). See
[CHANGELOG 0.4.0](CHANGELOG.md).

**Assistant enabled in 3 chats since 2026-09-14** (configuration only, applied
to image `5e67451` and carried forward): the third chat was added to
`TELEGRAM_RUNTIME_ASSISTANT_CHAT_IDS`. The moderator covers the same 3 chats.

**Release `0.5.0` image: `6c582ec`** (deployed 2026-09-14 21:06 UTC and
later superseded,
`telegram-runtime` container rebuilt and recreated; `operator-console`
unchanged). The analyzer, router and answer stages now share one snapshot of
the last three Q/A turns instead of each re-reading dialogue history on its
own, so a follow-up question in the same conversation is answered as a
continuation. A working-state module (goals/conditions/decisions) ships
disabled by default and is not wired into the live path. See
[CHANGELOG 0.5.0](CHANGELOG.md). Rollback: previous image `5e67451` is kept on
the host at that release point.

**Current runtime: `2c72e01`, production-verified. Assistant2.4.39 — 16.09.2026.**
Started2026-09-16 06:57:40UTC; healthy/restart0. Every delivered Assistant
reply ends with `Версия 2.4.39 от 16.09.2026`, once on its final part.
One native-revision judge owner, fenced answer delivery and30-second idle
`/ask` command/hint cleanup are live; substantive and late questions are retained.
The preceding suspected porn-spam policy remains included.

Root1141passed/5unchanged fixture skips, migration9/9 and source guard passed;
64deployed-file hashes, rendered footer, repeated health/config/Console and
HTTPS checks passed. Additive schema:53old objects unchanged,25added; integrity
and legacy-seeding gates passed. Source integrated into main and pushed.
Config/models/quotas/routes/knowledge/Console are unchanged; lease/master closed.

Legacy native messages, including their late edits, are quarantined against
rejudgement. **No old-binary rollback:** a41518f on this database is unsafe;
use identity-verified stop/preserved data/tested forward repair under a fresh
lease. New paid or live Telegram acceptance was not run. See the
[current release receipt](docs/reports/2026-09-16-assistant-2.4.39-deployment.md).
The separate partial-knowledge answer-quality issue and private Review remain open.

**Current operator panel: Russian Console 3.2.0**, image `f650fe8`, released
2026-09-15 23:12:03UTC. Seven pages share Russian navigation, an exact
version/date/time header and detailed Help. Settings and Markdown editors
save versioned drafts only, not changes to the running bot.
Analytics preserves unknown cost and limited journal coverage. The Assistant
container/config/database were not changed by this Console-only release.
Open [the panel](https://aikrol.questtales.com/) with the existing login.
See the [Console receipt](docs/reports/2026-09-15-console-v32-deployment.md).

**Live question-cost analytics.** Analytics shows the five
newest saved questions, standard token-price estimates and a mean over fully
estimated questions only. Missing stage evidence stays unknown; known-stage
subtotals are separate. The read-only journal covers a subset of chats and is
not a provider invoice. This release includes the 3.1.1 label fixes
and updated Help; bot behavior, rates and schema remain unchanged. At acceptance,
four of the last five questions had complete estimates averaging $0.0065898;
the fifth full price remained unknown. Independent ordinary Chrome QA passed.

**Pushed private Review candidate: Console 3.4.0 / Assistant 2.4.40 (`7d99ae0`).**
The previously pushed disabled Console3.3.0 slice is extended with a private
runtime-to-Console collector, durable Review receipts, single-attempt private
Telegram notifications and the covert book/testimonial detector. Primary
moderation continues on Review failure; gaps remain visible/unknown. Erasure
removes linked identifiers without guaranteeing suppression on redelivery.
The PO selected both policies; the private notification account was verified.
Local tests use synthetic content and fake Telegram; this is not live delivery.
Production remains2.4.39/Console3.2.0 until an exact activation lease covers the
source, private binding, reviewer access, limits and rollback. See the
[release queue](docs/RELEASE_QUEUE.md),
[selected contract](docs/proposals/2026-09-17-moderation-live-bridge-selected-v3.md)
and [activation procedure](docs/MODERATION_REVIEW_ACTIVATION.md).
Root1427passed/5fixture-skips and migration9/9 passed. Exact local Linux images,
source hashes, component versions/footer and image-local tests passed after
isolating a stalled local Docker credential helper. Production activation is
still pending. [Candidate receipt](docs/reports/2026-09-17-moderation-review-live-candidate.md).

**Previous production image: `0b54148`** (started 2026-09-15 20:16:45 UTC;
lifecycle `production-verified`). Menu-first Help and the owner's exact three-paragraph
out-of-coverage response are live. The knowledge-enabled boundary now uses
the same approved copy. No moderation rules, config, schema, routes, knowledge
or model limits changed. Root tests 688/688, historical receipt checks 29/29,
migration checks 9/9 and exact 55-file production source match passed.
Rollback `5600afd` retained. New live Telegram/client acceptance was not run.
See its [release receipt](docs/reports/2026-09-15-runtime-0b54148-deployment.md).

**Previous production image: `5600afd`** (started 2026-09-15 16:07:36 UTC;
lifecycle `deployed`). Bundled six-domain routing, multi-domain attribution and
decision diagnostics are live. Exact55-file source match, healthy/restart0,
unchanged environment/schema/routes/Console and offline container checks passed.
Rollback `852a8d2` retained. Routing-only comparison:28/28 router,26/27 analyzer;
one compound-domain miss and two risk-label discrepancies remain. New live
answer/menu acceptance was not run. Knowledge-enabled self questions now use
the existing model path and can cost tokens; configured limits are unchanged.
See its [release receipt](docs/reports/2026-09-15-runtime-5600afd-deployment.md).

**Previous production image: `852a8d2`** (started 2026-09-15 06:49:50 UTC;
lifecycle `deployed`). Restores the course navigator profile and adds durable
command/hint cleanup. Infrastructure checks passed: exact source, preserved
configuration/schema/routes, healthy and zero restarts. Rollback `049cc22`
is retained; Console was not recreated. Live acceptance stopped after six
questions: a compound identity question was refused, and synthetic command
deletion returned not-found after the hint was deleted. Ordinary human-menu
cleanup is still unverified. See the
[deployment and acceptance receipt](docs/reports/2026-09-15-runtime-852a8d2-deployment.md).

Two local assistant instances that can hold a recorded conversation with each
other (wave 3) remain a lab tool in scripts, not on the live answer path.

## Known open defects

- **Profile and menu acceptance are incomplete.** Registry routing now recognizes
  “Кто ты и как тебя зовут?” in the measured candidate; live answer acceptance
  remains open. Synthetic menu-pair deletion was
  not confirmed; no Moderator inbound receipt exists for that synthetic
  command. Do not infer ordinary-user success/failure or change permissions
  from this alone. See `PROFILE-2` / `HYGIENE-1` in `.claude/BACKLOG.md`.
- **Acceptance does not judge answer content.** The deterministic leg checks
  behaviour and the model judge is explicitly barred from judging factual
  grounding, so neither leg verifies whether an answer is true to the
  knowledge it was given. This is a measured hole, not a hypothesis: a
  factually loose answer passed 4/4 with `expectation_met: true` and was
  caught only by a human. Closing it is an architectural choice, not a bugfix.
- **Webhook processing is synchronous.** Telegram and provider calls now have
  finite deadlines, but an immediate HTTP 200 is unsafe without a durable
  inbox/worker recovery contract: a process crash after acknowledgement could
  otherwise lose an update. That queue remains architecture work.
- **Gatekeeper is not production-active.** Its code and scenario tests exist,
  but public copy, two HTTPS links and shared-console placement still require
  Product Owner decisions and a separate activation lease.

## Local checks

Use Node 20.20.x. Each runnable application has its own lockfile, so install
dependencies in the application directories before running the aggregate
checks:

```bash
npm --prefix apps/gatekeeper ci
npm --prefix apps/telegram-runtime ci
npm --prefix apps/operator-console ci
npm test
npm run check:gatekeeper
```

The default suite also runs the frozen September 15 routing experiment's
offline checks against exact Git source `5600afd`, in a temporary isolated
worktree. Current routing/provider regressions still run against current code.
The historical source, gold and paid receipts are not rewritten when Help or
other runtime files change. The pinned Git object must already exist locally;
the checker never fetches, installs dependencies, reads a live credential or
makes network calls. Six receipt-bound checks are explicitly skipped unless
the original hash-validated local artifacts are supplied:

```bash
npm run test:routing-history -- --parent-dir /absolute/path/to/original-parent-artifacts
```

This optional command replays offline checks only; it never resumes the paid
experiment. See [Help candidate and test isolation](docs/reports/2026-09-15-help-menu-candidate.md).

## Layout

```text
apps/
  gatekeeper/       # entry and onboarding adapter
  telegram-runtime/ # moderator and assistant adapters
  operator-console/ # read-only operations UI
packages/
  telegram-core/    # shared event, identity, state and policy contracts
docs/
```

Gatekeeper, Moderator and Assistant each have an AIchatTG-owned code and data
boundary. Course knowledge is built by the `allcourses` laboratory, admitted
here by signed manifest, and never read from News.
