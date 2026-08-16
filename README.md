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

## Known open defects

- **Telegram markup is not rendered.** `telegram-adapter.mjs` sends no
  `parse_mode`, so `**bold**` and `###` reach the reader literally while the
  answer prompts still produce Markdown. Gatekeeper sends `parse_mode: 'HTML'`;
  the assistant does not. The fix (enable markup with a plain-text fallback on
  Telegram's refusal, or forbid markup in the prompts) is an owner decision and
  is deliberately not applied yet.

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

## Planned layout

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
