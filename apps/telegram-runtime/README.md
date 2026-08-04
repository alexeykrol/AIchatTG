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
key; it is intentionally a separate budget/release decision. Course retrieval,
legacy News dashboard routes and any versioned knowledge snapshot are not
implicitly ported: supply a reviewed AIchatTG knowledge adapter in a later
charter.

See [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md) and [the extraction map](../../docs/MODERATOR_ASSISTANT_EXTRACTION.md).
