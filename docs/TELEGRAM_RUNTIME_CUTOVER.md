# Telegram runtime cutover and rollback

This runbook controls the standalone AIchatTG Moderator and Assistant bots only.
Gatekeeper remains draft/off: do not register its webhook, start its polling, or
alter its configuration as part of this runbook.

## Preconditions

Do not use these commands without an explicit Product Owner approval and an
exact controller lease naming the candidate SHA, the AIchatTG runtime service,
expiry, rollback point and verification criteria. Confirm the deployed source
matches that exact SHA, the public HTTPS route is healthy, bot tokens/secrets
are private runtime values, and no prior recovery state needs operator review.
No command below is a runtime startup action.

## Prepare (no Telegram request)

From the exact candidate with the private runtime environment available, inspect
the redacted plans. Without `--apply` the CLI does not invoke `fetch` or
Telegram.

```bash
node scripts/aichattg/telegram-ops.mjs --action status --role moderator
node scripts/aichattg/telegram-ops.mjs --action set-webhook --role moderator
node scripts/aichattg/telegram-ops.mjs --action set-webhook --role assistant
node scripts/aichattg/telegram-ops.mjs --action set-commands --role assistant
```

The prepared Moderator endpoint is
`/webhooks/telegram/moderator`; Assistant is
`/webhooks/telegram/assistant`. The set-webhook payload is always role-scoped,
contains the role's secret token, requests `message` and `edited_message`, and
sets `drop_pending_updates=false`. The command menu is Assistant-only and is
exactly `/ask` and `/help`.

## Cutover (external actions; only under the lease)

Run one role at a time and read back the resulting state before proceeding.

```bash
node scripts/aichattg/telegram-ops.mjs --action set-webhook --role moderator --apply
node scripts/aichattg/telegram-ops.mjs --action status --role moderator --apply
node scripts/aichattg/telegram-ops.mjs --action set-webhook --role assistant --apply
node scripts/aichattg/telegram-ops.mjs --action status --role assistant --apply
node scripts/aichattg/telegram-ops.mjs --action set-commands --role assistant --apply
```

Stop on any error or uncertain read-back. Do not retry an ambiguous Telegram
operation blindly, do not enable polling, and do not invoke a provider as a
smoke test. The CLI never registers a webhook automatically at process start.

## Rollback boundary

For a leased rollback, first disable the public runtime route according to the
lease, then delete only the affected owned webhook(s), preserving pending
updates. Read back `getWebhookInfo` for each selected role. Never point either
bot at News, reuse a token between roles, or activate Gatekeeper.

```bash
node scripts/aichattg/telegram-ops.mjs --action delete-webhook --role moderator --apply
node scripts/aichattg/telegram-ops.mjs --action status --role moderator --apply
node scripts/aichattg/telegram-ops.mjs --action delete-webhook --role assistant --apply
node scripts/aichattg/telegram-ops.mjs --action status --role assistant --apply
```

Webhook deletion does not drop pending updates. The Assistant command menu is a
separate persistent Telegram setting; leave it unchanged unless a new
controller-approved operation explicitly covers that API surface.
