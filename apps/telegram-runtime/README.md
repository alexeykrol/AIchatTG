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

## Moderator recovery

Immediately before a potentially failing semantic judgement, Moderator stores a
private, bounded `moderator-comment-v1` snapshot containing only message text
and the routing/identity signals required to judge that comment. It never stores
the raw webhook JSON, headers or full Telegram update. The recovery states are:

- `safe_retry`: only a `ProviderUnavailableError` or failed read-only membership
  preflight proved that no provider request occurred; the bounded worker may try
  again.
- `calling`: a provider boundary was crossed; after a stale lease this becomes
  `manual_review`, never a retry. Startup immediately treats any persisted
  `calling` record as that manual-review case.
- `decision_ready`: the provider returned and the redacted decision plus fixed
  Guard plan are durable, but no terminal enforcement receipt has been
  recorded yet. Recovery never calls the provider again; it can create an
  initial receipt or resume only a `planned` receipt. A Guard receipt that is
  `calling` or `uncertain` is treated as an ambiguous Telegram boundary and is
  never re-issued.
- `manual_review`: transport/HTTP/malformed-provider outcomes, expired private
  snapshots and any ambiguous external boundary. No automatic provider or
  Telegram request is issued.
- `resolved`: the durable decision has a terminal enforcement outcome (or was
  an exempt pre-provider result). Guard's enforcement receipt remains
  authoritative and uncertain Telegram actions are not replayed.

The startup/timer worker drains `safe_retry` jobs and durable `decision_ready`
plans. Its lease/generation fence makes redelivery, a timer overlap or restart
unable to create two active provider claims; the enforcement receipt is the
separate fence for the first and only Guard action. The runtime's in-process
`moderatorRecoveryStatus()` method is read-only and returns redacted
state/counts without snapshot text. For an operator read-back, use `npm run
status:moderator-recovery`; it opens the local runtime database read-only and
never invokes a provider, Telegram or recovery.

## Explicit webhook operations

Webhook and command management is deliberately outside startup. The CLI prints a
redacted dry-run plan unless `--apply` is supplied; only then does it contact
Telegram using the private runtime environment:

```bash
node scripts/aichattg/telegram-ops.mjs --action status --role moderator
node scripts/aichattg/telegram-ops.mjs --action set-webhook --role assistant --apply
```

It requires an explicit `moderator` or `assistant` role and cannot loop across
roles. `set-webhook` uses that role's token/secret and fixed owned endpoint;
both set/delete webhook requests preserve pending updates. Only Assistant may
set commands, and its menu is exactly `/ask` and `/help`. See
[`docs/TELEGRAM_RUNTIME_CUTOVER.md`](../../docs/TELEGRAM_RUNTIME_CUTOVER.md) for
the approval-gated cutover and rollback boundary.

See [SOURCE_PROVENANCE.md](SOURCE_PROVENANCE.md), [the extraction map](../../docs/MODERATOR_ASSISTANT_EXTRACTION.md), and [the provider/knowledge contract](../../docs/PROVIDER_KNOWLEDGE_PORTABILITY.md).
