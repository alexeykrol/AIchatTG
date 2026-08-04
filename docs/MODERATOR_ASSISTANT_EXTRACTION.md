# Moderator and Assistant extraction map

## Provenance

The first inventory uses the immutable News source
`21c0b14d027fb52e65a3cf54d40de62012370297`, not the dirty legacy checkout.
That source shows that `src/pro/index.js` mixes the Telegram runtime with digest
and publishing startup, so it is an invalid extraction unit.

## First independent runtime seam

| Concern | Legacy source | AIchatTG destination | Rule |
|---|---|---|---|
| Telegram Moderator/Assistant logic | `src/pro/moderation/**` | `apps/telegram-runtime` | Port against narrow adapters, not the legacy bootstrap. |
| Bot-specific durable state | `src/pro/moderation/db.js`, dialogue stores | AIchatTG database module | Separate database file; no direct mount or dual-write to `news-digest.db`. |
| LLM/model transport | `src/services/llm.js`, endpoint/catalog support | AIchatTG provider adapter | Explicit keys/model settings only; do not inherit Digest configuration. |
| Operator API/auth | `src/middleware/auth.js`, moderation routes | AIchatTG operator adapter | Port only after removing Digest navigation and settings links. |
| Webhook registration/polling | `src/routes/telegram.js`, webhook registry | AIchatTG ingress adapter | Disabled by default; any token/webhook cutover is a separate production decision. |
| Course knowledge | settings-adjacent knowledge and course index files | AIchatTG versioned knowledge snapshot | Transfer by approved snapshot and checksum, never by guesswork. |
| Telegram editorial publisher | `src/services/publishers/telegram.js` and autoposter | News Digest | Not part of AIchatTG. |

## Required port order

1. Define AIchatTG config, database and outbound adapter interfaces.
2. Extract the shared contracts into `packages/telegram-core`.
3. Port Moderator and Assistant adapters into `apps/telegram-runtime` with
   local tests that use no real bot token or model key.
4. Review a separate one-way database migration and webhook cutover plan.

## Cutover constraints

- Assistant and guard tokens, secrets, webhook endpoints and durable inbox rows
  are distinct. Two pollers or webhooks for one token may race.
- Default startup must not call `setMyCommands`, `setWebhook`, `deleteWebhook`,
  or begin polling.
- The course index URL-corroboration contract remains code-owned and outside
  the model prompt.
- Any data migration, DNS/Traefik change, secret injection or live Telegram
  check remains a separate exact release decision.
