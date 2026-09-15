# AIchatTG

AIchatTG is the standalone Telegram product for QuestTales. It unifies three
specialised bots over one product core:

- **Moderator** protects chats and applies moderation policy.
- **Assistant** answers, navigates course material, and supports users.
- **Gatekeeper** verifies entry, runs onboarding, and hands a participant to
  the other Telegram capabilities.

News intake, digest generation, editorial review, and publication — including
publication to a Telegram channel — remain in the separate News Digest project.

## Architecture principle

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

**Current production image: `049cc22`** (started 2026-09-15 00:20:48 UTC;
production-verified). Includes deterministic self-description, hint cleanup,
15s Telegram / 45s provider deadlines and complete-input dialogue budgeting.
Both public webhook paths retain their authentication guard; the container is
healthy with zero restarts. Rollback image `f51753f` is retained. See the
[deployment receipt](docs/reports/2026-09-15-runtime-049cc22-deployment.md).

Two local assistant instances that can hold a recorded conversation with each
other (wave 3) remain a lab tool in scripts, not on the live answer path.

## Known open defects

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
