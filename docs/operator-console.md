# AIchatTG operator console

The operator console is the faithful AIchatTG port of the three Telegram-bot
operator pages that previously lived inside News: `Модерация`, `Ассистент`,
and `Тесты`. It belongs to AIchatTG and never reads News routes, cookies,
configuration, files, or databases.

## Boundaries

- `GET /health` is side-effect-free and public.
- All console routes require the application-owned Basic user `operator` and
  the runtime-only `AICHATTG_OPERATOR_TOKEN`. With no token the routes return
  `404`; there is no default credential.
- The service opens the AIchatTG Telegram runtime SQLite file with `readonly: true`,
  `fileMustExist: true`, and `query_only`. Missing or incompatible databases
  become an explicit unavailable status. It never creates, migrates, recovers,
  retries, or writes a database.
- The legacy layout is preserved, but its data projection is limited to fields
  the standalone AIchatTG runtime durably owns. Moderation source text and old
  owner-feedback history are not reconstructed from News.
- There are no mutation, Telegram, provider, model, recovery, enforcement,
  publishing, or settings routes.

## Public route

The Compose profile is disabled by default. When explicitly enabled, its
host-only router serves `https://aikrol.questtales.com/` and redirects the root
to `/moderation.html`. The higher-priority exact webhook routes continue to be
owned by the Telegram runtime. The runtime data mount stays read-only.
