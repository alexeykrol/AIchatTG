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
[docs/MIGRATION_FROM_NEWS.md](docs/MIGRATION_FROM_NEWS.md). Gatekeeper has
been ported with an isolated persistence boundary and a host-portable container
contract. Moderator and Assistant have their own runtime, safety disposition
barrier, idempotent event state, and verified local knowledge-manifest seam.
The separate Compose release defines independent images, data roots and disabled
Traefik routes. Approved knowledge content, provider configuration, historical
state import, public hostname selection, and the live webhook cutover remain
separate reviewed stages. No production webhook, bot token, model call, or
Telegram message has been changed by this repository setup.

## Local checks

Use Node 20.20.x. Each runnable application has its own lockfile, so install
dependencies in the application directories before running the aggregate
checks:

```bash
npm --prefix apps/gatekeeper ci
npm --prefix apps/telegram-runtime ci
npm test
npm run check:gatekeeper
```

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
