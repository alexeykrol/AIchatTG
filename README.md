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
separate application: it will own its repository, release archive, container,
database, data root, secrets, bot webhook paths, health endpoint, and release
receipt. It must never read the News Digest database directly.

The current migration is documented in
[docs/MIGRATION_FROM_NEWS.md](docs/MIGRATION_FROM_NEWS.md). No production
webhook, bot token, model call, or Telegram message is changed by this initial
repository setup.

## Planned layout

```text
apps/
  gatekeeper/       # entry and onboarding adapter
  telegram-runtime/ # moderator and assistant adapters
packages/
  telegram-core/    # shared event, identity, state and policy contracts
docs/
```

The first port is Gatekeeper because it already has an isolated implementation
and database boundary. Moderator and Assistant move together after their shared
contracts are extracted from the News runtime.
