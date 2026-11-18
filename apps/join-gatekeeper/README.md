# Join-request gatekeeper (scenario C)

**Status: local candidate. Nothing is deployed, no webhook is registered, no
Telegram group setting is changed, no token has been issued, no triage list has
been executed.** Activation and every production action are owner-gated (see
the contracts).

Contracts:
[v1](../../docs/proposals/2026-11-15-join-request-gatekeeper-v1.md) (base) and
[v2](../../docs/proposals/2026-11-17-join-request-gatekeeper-v2.md) (tokens,
probation, batch triage, rights — overrides v1 where stated).

## What it does

For a group with "approve new members" enabled, the bot receives
`chat_join_request`, screens the account with deterministic Telegram-only
signals, writes to the applicant privately via `user_chat_id`, asks 2–3
questions from `JOIN_SCENARIO.json`, and then approves, declines, or leaves the
request pending for an admin. It never writes to the group. No paid model
calls.

### Access tokens (paid students, v2 §1)

- A token is 32 base64url characters (24 random bytes). The database stores
  only `sha256(token)`, the `site_record_id`, the status
  (`issued` / `used` / `revoked`), the bound Telegram user id and timestamps.
  The generated CSV is the only copy of the plaintext.
- `/start <token>` in a private chat: an issued token becomes `used`, the
  account becomes a verified member, pending join requests of this user are
  approved in every allowlisted chat ("no request" is a normal outcome),
  probation is lifted, open questionnaires are closed as `approved_token`, and
  a welcome DM is sent (with `JOIN_GATEKEEPER_GROUP_LINK` if set).
  Same account again → "already verified". Another account, revoked or unknown
  token → journal event (`token_reuse` / `token_revoked_use` / `token_unknown`)
  and a neutral reply; the normal flow applies.
- A join request from a verified member is approved at once (only `is_bot` is
  checked).

```bash
npm run tokens -- generate --input ids.csv --output tokens.csv --bot-username <bot>
npm run tokens -- reissue --site-record-id <id> --output token.csv --bot-username <bot>
npm run tokens -- status --site-record-id <id>      # never prints a token
```

Input CSV header: exactly `site_record_id` (ids `^[A-Za-z0-9_-]{1,64}$`,
unique, none already holding an active token). Output CSV: UTF-8, LF, header
`site_record_id,token,deep_link`, mode 0600; an existing file is never
overwritten. Token CSV files are secrets: `*.csv` is git-ignored in this app.
The token CLI needs only `JOIN_GATEKEEPER_DATA_ROOT` (and optional
`JOIN_GATEKEEPER_DATABASE_PATH`), not the bot token or webhook secret.

### Probation — "accepted without the right to write" (v2 §2)

- A new request where the bot could not open the dialogue (DM failed or
  unknown, missing `user_chat_id`) **and** screening is `clean` → approve +
  `restrictChatMember` (no sending) → `probation` with a deadline of
  `limits.probationDays` (default 7). Screening `review` keeps `manual_review`;
  `block` keeps decline. If approve fails, the request stays with an admin. If
  restrict fails or is unknown, the state is still `probation` and the failure
  is logged as an error: the person is in the group without restriction.
- An admin pins a message with `https://t.me/<bot>?start=gate` in the group
  (the bot never posts there). `/start gate` or bare `/start` from a user in
  probation → intro + the same questions (no 5-minute limit). `/start` from a
  user whose request is in `manual_review` after a DM failure → that
  questionnaire. Otherwise → a short info text.
- Pass → restriction lifted (all permissions true), `probation_passed`, DM.
  Fail → `banChatMember` + `unbanChatMember(only_if_banned)` so the person can
  request again, `probation_removed`, polite DM. Not passed by the deadline →
  removed by the sweep (`probation_expired`), DM only if the conversation is
  open.

### Batch triage of old requests (v2 §3)

```bash
npm run triage -- classify --input export.json --out-dir triage-out
npm run triage -- execute --list triage-out/accept_restricted.json \
  --action accept_restricted --expect-sha256 <sha256 of the list file>   # dry run
npm run triage -- execute ... --confirm --receipt-dir receipts            # PRODUCTION ACTION
```

- `classify` is offline: strict `joingate-pending-export-v1` input,
  `is_bot` / `is_scam` / `is_fake` true or screening `block` → `reject.json`,
  everything else → `accept_restricted.json`, plus `summary.json` (counts,
  reasons, and the sha256 of each list). Output files are 0600, never
  overwritten. `null` means unknown, never false.
- `execute` is a dry run unless `--confirm` is given; it refuses unless the
  list file hash equals `--expect-sha256`. A confirmed run needs
  `JOIN_GATEKEEPER_BOT_TOKEN`, `JOIN_GATEKEEPER_TARGET_CHAT_IDS` (the list chat
  must be allowlisted) and the data root; it paces calls (≥ 1 s), stops at the
  first auth/rate/transport/ambiguous error, skips users already processed for
  the same list, approves verified members without restriction, and writes a
  0600 receipt JSON. Exit code 3 = stopped early.

## Required bot rights (v2 §4)

Admin of the group with `can_invite_users` **and** `can_restrict_members`
(restrict, ban/unban for removal). No pin, delete or post rights.

## Isolation

Own app, own `package.json`, own SQLite file (`join_*` tables, schema version
2), own routes (`GET /health`, `POST /webhooks/telegram`, also under
`/join-gatekeeper/...`), own env prefix `JOIN_GATEKEEPER_*`. No imports from
`apps/gatekeeper` or `apps/telegram-runtime`. Only dependency:
`better-sqlite3` 11.10.0 (exact). Retention purges answers and name snapshots
of decided applications; tokens, verified members and the journal are kept.

## Modes

- `shadow` (default): screen and log the would-be decision. No Telegram writes
  (no DM, approve, decline, restrict, ban). Token binding is still recorded
  locally. The only Telegram call is the read-only `getUserProfilePhotos`.
- `enforce`: full flow. Refuses to start while the scenario `status` is `draft`.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `JOIN_GATEKEEPER_BOT_TOKEN` | yes (server, triage `--confirm`) | `^\d+:[A-Za-z0-9_-]+$` |
| `JOIN_GATEKEEPER_TARGET_CHAT_IDS` | yes (server, triage `--confirm`) | comma list of negative chat ids (allowlist) |
| `JOIN_GATEKEEPER_WEBHOOK_SECRET` | yes (server) | 16–256 chars `[A-Za-z0-9_-]` |
| `JOIN_GATEKEEPER_MODE` | no | `shadow` (default) or `enforce` |
| `JOIN_GATEKEEPER_PORT` | no | default `8788` |
| `JOIN_GATEKEEPER_CONTAINER_BIND` | no | `true` → bind `0.0.0.0`, else `127.0.0.1` |
| `JOIN_GATEKEEPER_DATA_ROOT` | yes | private data directory |
| `JOIN_GATEKEEPER_DATABASE_PATH` | no | default `join-gatekeeper.sqlite`, must stay inside the data root |
| `JOIN_GATEKEEPER_PUBLIC_BASE_URL` | for webhook registration | https only |
| `JOIN_GATEKEEPER_SCENARIO_PATH` | no | default: bundled `JOIN_SCENARIO.json` |
| `JOIN_GATEKEEPER_GROUP_LINK` | no | `https://t.me/...`, appended to the token welcome DM |

## Commands

```bash
npm ci
npm test                  # unit tests, fake Telegram transport, no network
npm run scenario:check    # validate JOIN_SCENARIO.json and print a summary
npm start                 # HTTP server + 30 s timeout/probation/retention sweep
npm run webhook:register  # PRODUCTION ACTION: owner approval + release lease only
npm run tokens -- ...     # offline token CLI (see above)
npm run triage -- ...     # triage CLI; execute --confirm is a PRODUCTION ACTION
```

The texts in `JOIN_SCENARIO.json` (including the v2 token and probation texts)
are agent drafts pending owner approval (JOINGATE-2).
