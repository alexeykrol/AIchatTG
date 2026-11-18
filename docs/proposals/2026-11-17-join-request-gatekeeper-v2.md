# Join-request gatekeeper — scenario C, contract v2 (addendum)

**Status:** local candidate. Extends and, where stated, overrides
[v1](2026-11-15-join-request-gatekeeper-v1.md). Nothing deployed.
**Requested by:** Product Owner via coordinating session `aichattg-33`,
2026-11-17. Scope and order confirmed by PO there; production actions still
need exact PO approval in this session.

## 0. Product context (new)

The closed paid group is archived; one open group with request-to-join
remains. Paid students (~600 site records) enter by a personal one-time token
without the questionnaire; everyone else goes through the questionnaire.
About 150 requests are pending that the bot never saw (it was not running).

Unacceptable outcomes added to v1 §1:

5. A paid student holding a valid token is made to fill the questionnaire or
   is declined.
6. A token works twice (a leaked link admits a second person silently).
7. A real person who simply missed the bot's 5-minute window is declined or
   left forever in the pending queue.
8. Bulk actions on old requests run without PO approval of the exact lists.

## 1. Access tokens (paid students)

- Token: 32 characters base64url (24 random bytes, `crypto.randomBytes`),
  alphabet `A-Z a-z 0-9 _ -`. Fits the Telegram `start` parameter (≤ 64).
- Bot DB stores **only** `sha256(token)`, `site_record_id`, status
  (`issued` / `used` / `revoked`), the bound `telegram_user_id` and
  timestamps. No e-mails, no names, no plaintext tokens. The CSV handed to the
  site is the only copy of the plaintext.
- `/start <token>` in a private chat:
  - `issued` → token becomes `used`, the Telegram account becomes a
    **verified member** (`site_record_id` kept). Then: approve any pending
    join request of this user in each allowlisted chat (including requests the
    bot never received — `approveChatJoinRequest` takes only chat+user; a
    "no request" error is a normal outcome), lift a probation restriction if
    any (§2), close any open questionnaire as `approved_token`. DM a welcome
    with the group link if configured.
  - `used` by the **same** account → idempotent "you are already verified".
  - `used` by **another** account → journal event `token_reuse`
    (`site_record_id`, both user ids), the person is told the link was
    already used and that the group accepts requests with a short
    questionnaire. Normal flow applies.
  - `revoked` / unknown → journal event (`token_revoked_use` /
    `token_unknown`), same reply as reuse, normal flow.
- A join request from a verified member → approved immediately: no
  questions, no screening except `is_bot`.
- Generation (operator CLI, offline):
  `tokens generate --input ids.csv --output tokens.csv --bot-username <bot>`.
  Input CSV header `site_record_id` (`^[A-Za-z0-9_-]{1,64}$`, unique, and not
  already holding an active token). Output CSV UTF-8, LF, header
  `site_record_id,token,deep_link`, `deep_link = https://t.me/<bot>?start=<token>`,
  file mode 0600. Refuses to overwrite an existing file. Without
  `--bot-username` it refuses (the bot is not chosen yet, JOINGATE-1).
- Reissue (operator CLI): `tokens reissue --site-record-id <id> --output
  <file> --bot-username <bot>` → old token `revoked`, new token issued, one-row
  CSV. A verified member bound by the old token stays verified.
- `tokens status --site-record-id <id>` prints status without the token.
- Token CSV files are secrets: never in git (`*.csv` under the app ignored).

## 2. Probation — "accepted without the right to write"

New application states: `probation` (approved, restricted), `probation_passed`
(restriction lifted), `probation_removed` (removed after failure/expiry).

- **Entry:**
  - new requests where the bot could not open the dialogue (DM failed or
    unknown, missing `user_chat_id`) **and screening is `clean`** → approve +
    `restrictChatMember` (no sending of any kind) → `probation`. This replaces
    v1's `manual_review` for `dm_failed` / `dm_inconclusive` /
    `missing_user_chat_id` when screening is clean. Screening `review` keeps
    `manual_review`; `block` keeps decline.
  - old requests from the PO-approved `accept_restricted` list (§3).
  - If approve succeeds but restrict fails/unknown → state `probation`,
    `telegram_action_state` `failed`/`inconclusive`, logged loudly (the person
    is in the group without restriction — operator must check).
- **Questionnaire start:** a message pinned in the group **by an admin**
  (the bot still never writes into the group) contains the link
  `https://t.me/<bot>?start=gate`. The user starts the bot themself, so the
  5-minute limit does not apply. `/start gate` (or bare `/start`) from a user in
  `probation` → greeting + questions, same rules as v1 §6.
  `/start` from a user with an undecided `manual_review` application whose
  reason is a DM failure → run the questionnaire for that application.
  Otherwise → short info text.
- **Pass** → restriction lifted (`restrictChatMember` with all permissions
  true), state `probation_passed`, welcome DM.
- **Fail** → removed (`banChatMember` then `unbanChatMember` with
  `only_if_banned`, so the person can request again), state
  `probation_removed`, polite DM.
- **Expiry:** not passed within `probationDays` (scenario limit, default 7) →
  removed as above, `probation_removed` reason `probation_expired`; DM only if
  the conversation is open.
- A verified member (token) in probation → restriction lifted, state
  `probation_passed` reason `token`.

## 3. Batch triage of old requests (offline)

- Input: `joingate-pending-export-v1` JSON produced by the coordinating
  session (read-only, owner account):
  `{schema, chat_id, generated_at, requests:[{user_id, first_name, last_name,
  username, bio, requested_at, is_bot, is_scam, is_fake, is_premium,
  has_photo, lang_code}]}`. `user_id` and `requested_at` required; others may
  be `null` (null = unknown, never treated as false).
- `triage classify --input export.json --out-dir <dir>`: pure, offline,
  no Telegram. Uses the same `screenApplicant` rules (`has_photo` → photo
  count 1/0/null) plus: `is_bot`, `is_scam`, `is_fake` true → reject.
  `block` → `reject.json`; `review` and `clean` → `accept_restricted.json`
  (the questionnaire decides later). Output schema
  `joingate-triage-v1`: `{schema, chat_id, generated_at, source_sha256,
  items:[{user_id, requested_at, reasons:[...]}]}` + `summary.json`
  (counts per list and per reason). Files 0600.
- `triage execute --list <file> --action reject|accept_restricted
  --expect-sha256 <sha>`: production action, code only in this candidate.
  Default dry run (prints the plan, no calls); real run only with `--confirm`
  and a matching list hash. Paced (≥ 1 s between users), stops at the first
  auth/transport/ambiguous error, idempotent (skips users already processed),
  writes a receipt JSON. `accept_restricted` → approve + restrict + probation
  record with deadline; `reject` → decline. Verified members are approved
  without restriction instead.

## 4. Bot rights (overrides v1 §9 and JOINGATE-3)

Admin of the merged group with `can_invite_users` **and**
`can_restrict_members` (restrict, ban/unban for removal). No pin, delete or
post rights — the pinned message is posted by a human admin.

## 5. Verification item (from PO, point 8)

After activation, on one real pending request that the bot never received:
call approve once and record the result. Expected to work (the method takes
only chat+user) — `inconclusive` until observed. If it fails, the
coordinating session's export script approves those requests.

## 6. Product decisions (PO via coordinator, 2026-11-17)

1. `probationDays` = 7.
2. Failing the probation questionnaire → immediate removal; a new request is
   allowed.
3. A new applicant who receives the DM but stays silent 30 minutes → decline
   (v1 timeout). Probation only when the bot itself could not write.
4. Token welcome link: `JOIN_GATEKEEPER_GROUP_LINK=https://t.me/aialexekrol`.
   A public group with "approve new members" shows "Request to join" on its
   public link; no separate `creates_join_request` invite link is needed.

## 7. Bot and group (PO via coordinator, 2026-11-17; resolves JOINGATE-1)

- **One bot, several scenarios:** the existing Gatekeeper bot; scenario C is
  its new scenario. The bot token is configuration
  (`JOIN_GATEKEEPER_BOT_TOKEN` = the existing Gatekeeper token at activation);
  the code stays a separate module with its own DB so it cannot affect A/B.
- One webhook per token: while A/B are paused, the bot's webhook belongs to
  scenario C. Resuming A/B requires a thin dispatcher in front of both
  (JOINGATE-7).
- Group: `@aialexekrol`. Its numeric `chat_id` is resolved read-only via
  `getChat` as the first step of the activation package (production token
  lives only on the server) and written into
  `JOIN_GATEKEEPER_TARGET_CHAT_IDS` by the same step.
