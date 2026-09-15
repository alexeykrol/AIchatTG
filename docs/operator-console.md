# AIchatTG operator console

The operator console belongs to AIchatTG and never reads News routes, cookies,
configuration, files, or databases. Its seven Russian v3 pages are
`Модерация`, `Ассистент`, `Настройки`, `Базы ответов`, `Аналитика`, `Тесты`,
and `Помощь`. The older pages remain reachable only under `/legacy/`.

## Boundaries

- `GET /health` is side-effect-free and public.
- All console routes require the application-owned Basic user `operator` and
  the runtime-only `AICHATTG_OPERATOR_TOKEN`. With no token the routes return
  `404`; there is no default credential.
- The service opens the AIchatTG Telegram runtime SQLite file with `readonly: true`,
  `fileMustExist: true`, and `query_only`. Missing or incompatible databases
  become an explicit unavailable status. It never creates, migrates, recovers,
  retries, or writes a database.
- The v3 settings and locally bound Markdown editors write validated, versioned
  drafts under the separate Console candidate root. A saved draft does not
  change the running Telegram bot. The four other domain sources cannot be
  edited through the Markdown form.
- Moderation, Assistant, Analytics, and Tests remain read-only projections of
  data that the standalone AIchatTG runtime durably owns. The Help page
  explains the draft and data-coverage boundaries in plain Russian.
- The Console does not send Telegram messages, call paid models, enforce
  moderation decisions, migrate the database, or publish content.

## Release identity

`apps/operator-console/src/console-release.json` owns the public Console
version. `OPERATOR_CONSOLE_RELEASED_AT` supplies the exact UTC activation
timestamp (`YYYY-MM-DDTHH:MM:SSZ`) for the seven-page header; the deployment
owner sets it during the scoped Console activation. The authenticated
`GET /api/operator/release` returns both values for verification. A local
preview without that timestamp shows that the release time is pending. The
production Console refuses to start if this value is absent or invalid.

## Public route

The Console host-only router serves `https://aikrol.questtales.com/` and
redirects the root to `/moderation-v3.html`. The higher-priority exact webhook
routes continue to be owned by the Telegram runtime. Its database mount stays
read-only; the separate draft mount belongs only to the Console.
