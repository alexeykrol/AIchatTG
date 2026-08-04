# Telegram runtime

This is the independently runnable local Moderator and Assistant runtime. It
owns an AIchatTG SQLite database, HTTP ingress, Telegram transport boundary,
LLM boundary, notification boundary and durable event claims. It imports only
`@aichattg/telegram-core`; it never imports the News application or reads its
database.

```bash
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm install
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm test
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm start
```

Default startup listens locally and creates only the configured local SQLite
file. It does **not** poll, call Telegram, set commands, register/delete a
webhook, invoke an LLM, or send a notification. The two webhook routes are
disabled unless `TELEGRAM_RUNTIME_INGRESS_ENABLED=true`, and then require
separate Moderator and Assistant webhook secrets.

`TELEGRAM_RUNTIME_LLM_ENABLED=true` requires an explicit adapter endpoint and
key; it is intentionally a separate budget/release decision. An Assistant
question is never sent to that adapter until the Moderator has written an
`allowed` disposition for the exact source-message revision. `blocked`,
`pending`, missing and error dispositions fail closed before the Assistant
claim, model or delivery boundary.

Source-grounded routes are also disabled until an AIchatTG-owned, checked
knowledge snapshot is supplied. The checked-in
[`data/knowledge/manifest.json`](../../data/knowledge/manifest.json) contains
no course material; it documents the one-way import contract. It cannot read a
News path or database.

See [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md) and [the extraction map](../../docs/MODERATOR_ASSISTANT_EXTRACTION.md).
