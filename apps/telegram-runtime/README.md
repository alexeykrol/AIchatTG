# Telegram runtime

This is the independently runnable local Moderator and Assistant runtime. It
owns an AIchatTG SQLite database, HTTP ingress, Telegram transport boundary,
provider boundary, notification boundary and durable event claims. It imports only
`@aichattg/telegram-core`; it never imports the News application or reads its
database.

```bash
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm install
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm test
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm start
```

Default startup listens locally and creates only the configured local SQLite
file. It does **not** poll, call Telegram, set commands, register/delete a
webhook, invoke a provider, or send a notification. The two webhook routes are
disabled unless `TELEGRAM_RUNTIME_INGRESS_ENABLED=true`, and then require
separate Moderator and Assistant webhook secrets.

The Moderator also preserves the deployed channel-pin housekeeping contract.
`TELEGRAM_RUNTIME_MODERATION_ANTICHANNELPIN` defaults to `true`: only an
automatic pin on an auto-forwarded channel post is removed, through the
Moderator token after an explicit `can_pin_messages` rights check. Manual and
anonymous-admin pins are never removed and their native message identity is
remembered locally. These service events never reach a provider or Assistant.

For a code-owned `ban_purge` safety decision, the Moderator deletes the
triggering message plus at most 100 earlier, locally observed, still-undeleted
messages by that exact user in that exact chat. It never discovers chat history
through Telegram, crosses chat/user boundaries, or retries an ambiguous delete;
the local action ledger fences that native target for operator review.

`TELEGRAM_RUNTIME_PROVIDER_ENABLED=true` requires an explicit HTTPS endpoint,
key and model; it is intentionally a separate budget/release decision. An Assistant
question is never sent to that adapter until the Moderator has written an
`allowed` disposition for the exact source-message revision. `blocked`,
`pending`, missing and error dispositions fail closed before the Assistant
claim, model or delivery boundary.

Source-grounded routes are also disabled until each source package has an
AIchatTG-owned, checked knowledge admission. The checked-in
[`data/knowledge/manifest.json`](../../data/knowledge/manifest.json) contains
no course material; it documents the one-way import contract. It cannot read a
News path or database. `TELEGRAM_RUNTIME_ASSISTANT_KNOWLEDGE_ENABLED` defaults
to `false`: until a separately reviewed source snapshot is admitted, `/ask`
uses only code-owned help, public self-profile and safe boundary replies and
does not call the Assistant provider or read knowledge.

Assistant dialogue is scoped to one chat and Telegram user. Successful final
delivery is the only point at which a turn enters the local SQLite dialogue;
the configurable TTL and turn cap trim it deterministically. A failed or
ambiguous Telegram delivery is fenced in the inbound receipt and is never
auto-replayed.

See [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md), [the extraction map](../../docs/MODERATOR_ASSISTANT_EXTRACTION.md), and [the provider/knowledge contract](../../docs/PROVIDER_KNOWLEDGE_PORTABILITY.md).
