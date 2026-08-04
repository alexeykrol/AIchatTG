# AIchatTG operator console

The operator console is a separate, read-only service for the Moderator,
Assistant, and Gatekeeper bot state. It belongs to AIchatTG and never reads
News Digest routes, cookies, configuration, files, or databases.

## Boundaries

- `GET /health` is side-effect-free and public.
- All console routes require the application-owned Basic user `operator` and
  the runtime-only `AICHATTG_OPERATOR_TOKEN`. With no token the routes return
  `404`; there is no default credential.
- The service opens its two AIchatTG SQLite files with `readonly: true`,
  `fileMustExist: true`, and `query_only`. Missing or incompatible databases
  become an explicit unavailable status. It never creates, migrates, recovers,
  retries, or writes a database.
- API/UI output is aggregate-only. Audit identifiers are one-way redacted;
  raw message text, names, usernames, email, tokens, keys, secrets, URLs,
  headers, payloads and provider responses are intentionally absent.
- There are no mutation, Telegram, provider, model, recovery, enforcement,
  publishing, or settings routes.

## Eventual route

The Compose profile is disabled by default. A separately approved release can
enable the isolated Traefik router for
`https://aikrol.questtales.com/operator/`; it strips `/operator` before the
request reaches this service. Both bot-data mounts stay read-only.
