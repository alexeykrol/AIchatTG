# Join-request gatekeeper (scenario C)

**Status: local candidate. Nothing is deployed, no webhook is registered, no
Telegram group setting is changed, no token has been issued, no triage list has
been executed.** Activation and every production action are owner-gated (see
the contracts).

Contracts:
[v1](../../docs/proposals/2026-11-15-join-request-gatekeeper-v1.md) (base) and
[v2](../../docs/proposals/2026-11-17-join-request-gatekeeper-v2.md) (tokens,
probation, batch triage, rights — overrides v1 where stated) and
[questionnaire v2 / A0-bis](../../docs/proposals/2026-11-18-join-gatekeeper-questionnaire-v2.md)
(pre-checks, reason codes, multi-select topics — overrides v1 §5–§6).

## What it does

For a group with "approve new members" enabled, the bot receives
`chat_join_request`, runs deterministic pre-checks (rate limit, bot/scam,
profile advertising incl. a channel attached to the profile via `getChat`,
spam keywords), writes to the applicant privately via `user_chat_id`, asks
three questions from `JOIN_SCENARIO.json` (participate? rules? topics —
multi-select), and then approves or declines with exactly one reason code
(`R_*`, each with its own DM). It never writes to the group. No paid model
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
  unknown, missing `user_chat_id`) **and** the pre-checks passed → approve +
  `restrictChatMember` (no sending) → `probation` with a deadline of
  `limits.probationDays` (default 7). If approve fails, the request stays with
  an admin. If
  restrict fails or is unknown, the application is **not** `probation`: it
  becomes `manual_review` with `decision_reason = restrict_unconfirmed`, a
  `restrict_unconfirmed` journal entry and an error log, and appears in the
  discrepancy queue (`store.listRestrictionDiscrepancies()`, which also lists
  older `probation` rows with an unconfirmed restriction). The person may be in
  the group without restriction; an operator reconciles. A verified token lifts
  it like probation. `store.admissionMetrics()` counts `approved`,
  `restriction_confirmed` and `can_ask_first_question` separately.
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
  the live pre-check rules, preceded by the triage-only `is_deleted: true` →
  `R_DELETED`: `is_bot` / `is_scam` / `is_fake` → `R_SCAM`,
  profile advertising (incl. optional `has_personal_chat: true`) →
  `R_PROFILE_AD`, spam keyword → `R_STOPWORD` → `reject.json`; everything else
  → `accept_restricted.json`, plus `summary.json` (counts per list and per
  reason code, and the sha256 of each list). Items carry `reasons` (the code)
  and `signals`. Output files are 0600, never overwritten. `null` means
  unknown, never false.
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
  locally. The only Telegram calls are the read-only `getChat` and
  `getUserProfilePhotos`. Logs carry decisions and reason codes only — never
  names, bio, answers or topic text.
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
