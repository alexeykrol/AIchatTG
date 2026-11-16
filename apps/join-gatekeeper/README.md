# Join-request gatekeeper (scenario C)

**Status: local candidate. Nothing is deployed, no webhook is registered, no
Telegram group setting is changed.** Activation is owner-gated (see the
contract, section 12).

Contract: [`docs/proposals/2026-11-15-join-request-gatekeeper-v1.md`](../../docs/proposals/2026-11-15-join-request-gatekeeper-v1.md).

## What it does

For a group with "approve new members" enabled, the bot receives
`chat_join_request`, screens the account with deterministic Telegram-only
signals, writes to the applicant privately via `user_chat_id`, asks 2–3
questions from `JOIN_SCENARIO.json`, and then approves, declines, or leaves the
request pending for an admin. It never writes to the group. No paid model
calls.

## Isolation

Own app, own `package.json`, own SQLite file (`join_*` tables), own routes
(`GET /health`, `POST /webhooks/telegram`, also under `/join-gatekeeper/...`),
own env prefix `JOIN_GATEKEEPER_*`. No imports from `apps/gatekeeper` or
`apps/telegram-runtime`. Only dependency: `better-sqlite3` 11.10.0 (exact).

## Modes

- `shadow` (default): screen and log the would-be decision. No Telegram writes
  (no DM, approve, decline). The only Telegram call is the read-only
  `getUserProfilePhotos` used as a screening signal.
- `enforce`: full flow. Refuses to start while the scenario `status` is `draft`.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `JOIN_GATEKEEPER_BOT_TOKEN` | yes | `^\d+:[A-Za-z0-9_-]+$` |
| `JOIN_GATEKEEPER_TARGET_CHAT_IDS` | yes | comma list of negative chat ids (allowlist) |
| `JOIN_GATEKEEPER_WEBHOOK_SECRET` | yes | 16–256 chars `[A-Za-z0-9_-]` |
| `JOIN_GATEKEEPER_MODE` | no | `shadow` (default) or `enforce` |
| `JOIN_GATEKEEPER_PORT` | no | default `8788` |
| `JOIN_GATEKEEPER_CONTAINER_BIND` | no | `true` → bind `0.0.0.0`, else `127.0.0.1` |
| `JOIN_GATEKEEPER_DATA_ROOT` | yes | private data directory |
| `JOIN_GATEKEEPER_DATABASE_PATH` | no | default `join-gatekeeper.sqlite`, must stay inside the data root |
| `JOIN_GATEKEEPER_PUBLIC_BASE_URL` | for webhook registration | https only |
| `JOIN_GATEKEEPER_SCENARIO_PATH` | no | default: bundled `JOIN_SCENARIO.json` |

## Commands

```bash
npm ci
npm test                  # unit tests, fake Telegram transport, no network
npm run scenario:check    # validate JOIN_SCENARIO.json and print a summary
npm start                 # HTTP server + 30 s timeout/retention sweep
npm run webhook:register  # PRODUCTION ACTION: owner approval + release lease only
```

The texts in `JOIN_SCENARIO.json` are agent drafts pending owner approval
(JOINGATE-2).
