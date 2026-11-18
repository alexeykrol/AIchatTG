# Join-gatekeeper (scenario C) — activation package

**Status:** draft package for PO approval via the coordinator (aichattg-33).
Each numbered item is approved separately by its ID; an approval of one item
does not extend to another (production-safety.md).
**Candidate:** branch `claude/join-request-gatekeeper-20261115` (final SHA is
fixed in the lease after item A1 is merged).
**Current production:** Moderator + Assistant on news-vps; Gatekeeper never
activated; scenario C absent. Production image SHA for this package: `not_run`
(checked at lease time).

## A. Prerequisites (local, need PO decision only)

- **A0 — texts.** Approve or edit the bot texts and rules
  (`apps/join-gatekeeper/JOIN_SCENARIO.json`, listed in section D). After
  approval the scenario becomes `ready` (required by enforce mode).
- **A1 — merge.** Merge the branch into `main` and push `main`.
- **A2 — bot username.** Exact @username of the Gatekeeper bot (needed for
  deep links and the pinned link). Verified by `getMe` in B1.

## B. Production steps (each needs approval)

| ID | Action | Effect | Rollback |
|---|---|---|---|
| B1 | Read-only on server: `getMe`, `getChat @aialexekrol` with the Gatekeeper bot token | yields bot username check + numeric `chat_id` | none needed |
| B2 | Production env: add `JOIN_GATEKEEPER_TARGET_CHAT_IDS=<B1 id>`, new random `JOIN_GATEKEEPER_WEBHOOK_SECRET`, `JOIN_GATEKEEPER_MODE=shadow`, `JOIN_GATEKEEPER_GROUP_LINK=https://t.me/aialexekrol`, `AICHATTG_JOIN_GATEKEEPER_ROUTING_ENABLED=true`; confirm `GATEKEEPER_BOT_TOKEN` is present (if not — PO provides it) | config only | restore previous env file |
| B3 | Create data dir `<AICHATTG_DATA_ROOT>/join-gatekeeper` (0700) and copy the initial DB with token hashes (generated locally, section C) | prod data write | stop service, move file aside |
| B4 | Build image for the exact SHA, start Compose profile `join-gatekeeper`; check `/health` and route | new container, other services untouched | `docker compose --profile join-gatekeeper stop` |
| B5 | Telegram, done by a **human admin** in the app: make the bot admin of @aialexekrol with only `can_invite_users` + `can_restrict_members`; turn on "approve new members" | group setting | remove rights / turn approval off |
| B6 | `setWebhook` for the Gatekeeper bot → `https://<FQDN>/join-gatekeeper/webhooks/telegram`, `allowed_updates: [chat_join_request, message, callback_query]` | bot starts receiving requests (shadow: logs only) | `deleteWebhook` |
| B7 | Switch to `enforce` (env + restart) after shadow review | bot DMs, approves, declines, restricts | back to `shadow` |
| B8 | Verification on one real pending request the bot never received: one `approveChatJoinRequest` (v2 §5); one token `/start` with a test token | proves the two inconclusive items | — |
| B9 | Old requests: run `triage classify` on the coordinator's export, send both lists + hashes; executing each list is a separate approval with its `--expect-sha256` | approve+restrict / decline ~150 requests | per-user receipt; restrictions can be lifted |
| B10 | Human admin posts and pins a message with `https://t.me/<bot>?start=gate` | probation users can start the questionnaire | unpin |

Recommended order: A0–A2 → B1 → B2–B4 → B5 → B6 (shadow, ~1 day) → B7 →
B8 → B9 → B10. The site must not send token links before B7 (in shadow the
token is recorded but nobody is approved).

Stop conditions for every step: any auth/transport failure, unexpected
container state, or a result differing from the stated effect — stop and
report, no retries.

## C. Tokens

Generated locally from the coordinator's file (946 WP user ids), output CSV
next to the input outside git (0600). The initial DB holds only
`sha256(token)` + site id. Deep links need A2.

## D. Texts and rules for A0 (current drafts)

Limits: answer timeout 30 min; DM window 5 min; max 3 requests per user per
day; retention 30 days; probation 7 days.

Questions:
1. "Что вас привело в группу?" — buttons: «Хочу обсуждать ИИ и делиться
   опытом», «Учусь на курсе», «Просто посмотреть» (accepted);
   «Реклама/предложение услуг» (fails).
2. "Расскажите в 1–2 предложениях, чем занимаетесь и о чём хотели бы
   поговорить в группе." — ≥ 5 words, ≥ 25 characters, no links.
3. "В группе нельзя размещать рекламу, продавать услуги и рассылать спам.
   Согласны соблюдать эти правила?" — only «Согласен(на)» passes.

Spam keywords (name/username/bio): crypto, крипт, заработ, earn, casino,
казино, ставк, bet, 18+, интим, escort, xxx, porn, порн, onlyfans, инвест,
invest, сигнал, forex, форекс, раскрут, продвижен, подписчик.

Messages: greeting, retry, approved, declined, manual review, timeout, token
welcome / already verified / invalid, probation intro / passed / removed,
start info — full texts in `JOIN_SCENARIO.json`.
