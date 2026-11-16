# Join-request gatekeeper — scenario C, contract v1

**Status:** local candidate (draft). Nothing is deployed, no webhook is set, no
Telegram group setting is changed. Production activation requires a separate
Product Owner approval and release lease (INV-003).
**Requested by:** Product Owner, chat, 2026-11-15.
**Code:** `apps/join-gatekeeper/` (new, isolated application).

## 1. Product goal

The owner is merging two groups into one **open, visible** group where joining
requires a request ("approve new members" / request-to-join). Until now anyone
holding the invite link joined instantly; periodically bots got in and posted
ads, porn and junk that the Moderator did not catch.

Goal: **people who want to talk get in; spam accounts do not.** Raise the cost
of entry with a short dialogue and an account check, so the Moderator has less
to clean up.

Unacceptable outcomes (product-primacy rule, derived from the goal):

1. A real, motivated person is declined silently, with no explanation and no
   way to try again.
2. An obvious spam account is approved.
3. The bot sends anything into the group itself (the group is a showcase).
4. One flow affects another: scenarios A (Tribute → Telegram) and B (site →
   email) and the Moderator/Assistant runtime must not change behaviour.

## 2. Scenarios A and B are paused

Scenarios A and B in `apps/gatekeeper/` stay in the repository as they are
(code and tests untouched), are **not** deployed and are not part of the next
activation. Scenario C does not import, configure or call anything from
`apps/gatekeeper/`. Reasons:

- `apps/gatekeeper` config *requires* Tribute keys, link signing secret and
  scenario A texts; embedding C there would make C depend on A's config.
- Telegram allows one webhook per bot token. A and B are not deployed, so C can
  own the webhook of whichever bot is chosen for it (section 9).

## 3. The classic pattern and how Telegram supports it

Verified against the Bot API page (core.telegram.org/bots/api, read 2026-11-15):

- A group (or an invite link with `creates_join_request=true`) can require
  admin approval. The user presses the native "Request to join" button.
- The bot receives an `Update.chat_join_request` (`ChatJoinRequest`: `chat`,
  `from`, `user_chat_id`, `date`, optional `bio`, optional `invite_link`,
  optional `query_id`). The bot needs the `can_invite_users` admin right to
  receive these updates.
- `user_chat_id`: "The bot can use this identifier for 5 minutes to send
  messages until the join request is processed". This is what makes the
  dialogue possible **without the user pressing Start**: the bot writes first.
  Once the user replies, the private chat exists and the bot can keep writing.
- `approveChatJoinRequest` / `declineChatJoinRequest(chat_id, user_id)` —
  require admin + `can_invite_users`.
- Pending requests are visible to group admins natively in Telegram — that is
  the manual-review queue; the bot simply leaves a request pending.
- `setWebhook.allowed_updates`: an explicit list must contain
  `chat_join_request` (the existing gatekeeper registers
  `['message','chat_member','callback_query']`, which would drop it).
- Newer alternative, not used in v1: `query_id` + `sendChatJoinRequestWebApp` /
  `answerChatJoinRequestQuery` — the request is answered through a Mini App
  within 10 seconds. Needs a hosted HTTPS Mini App; parked in backlog as
  JOINGATE-5.

So the classic flow is exactly what the owner described: the person presses
the standard button, the bot starts a private conversation, asks questions,
checks the account, then approves, declines, or leaves the request for an
admin.

## 4. Flow

```
chat_join_request (allowlisted chat only)
  │
  ├─ dedupe (update_id, and one active application per chat+user)
  ├─ account screening  ──► block  → decline, no DM            (state declined_screening)
  │                          review → continue, flag for admin
  │                          clean  → continue
  ├─ DM via user_chat_id: greeting + question 1                 (state asking)
  │     user replies in private chat → evaluate answer → next question
  │     (one question per message; buttons allowed for choice questions)
  ├─ all answers evaluated
  │     any answer fails            → decline + polite DM       (declined_answers)
  │     passes, screening review    → leave pending + DM "admin will look" (manual_review)
  │     passes, screening clean     → approve + welcome DM      (approved)
  └─ timeout sweep
        no reply / unfinished by deadline → decline (+ DM only if the
        conversation is open or still inside the 5-minute window)  (timed_out)
```

- **Never writes to the group.** All bot messages go to the applicant's
  private chat.
- A declined person may request again (Telegram allows a new request); the new
  request starts a fresh application. Repeated requests are rate-limited
  (`max applications per user per day`, default 3); over the limit → decline
  without DM.
- If the DM cannot be delivered (user blocked bots / privacy), the request is
  left pending for an admin (`manual_review`, reason `dm_failed`) — never
  silently declined (unacceptable outcome 1).

## 5. Account screening (deterministic, Telegram-only signals)

Only what Telegram gives a bot: `from` (`is_bot`, `first_name`, `last_name`,
`username`, `language_code`, `is_premium`), `ChatJoinRequest.bio`, and best
effort `getUserProfilePhotos` (count only; failure = unknown, not a signal).
No external lookups, no paid model calls (paid-policy change needs PO
approval; a semantic judge is backlog JOINGATE-4).

| Signal | Effect |
|---|---|
| `from.is_bot = true` | block |
| name/username/bio contains a URL, `t.me/`, `@`-mention of another account, or invite link | review (block if together with a spam keyword) |
| spam keyword list (crypto/earnings/adult/casino/betting/"заработок", "18+", "интим", etc.) in name/username/bio | review; two or more distinct hits → block |
| name made mostly of emoji / invisible or zero-width characters / mixed-script look-alikes | review |
| empty display name after normalisation | review |
| no profile photo (count = 0) | weak signal: review only together with another signal |

Verdict = `block` / `review` / `clean`, with a list of reasons kept in the
store for the admin. The keyword and pattern lists live in the scenario file
(section 7), not in code, so the owner can edit them.

## 6. Questions and acceptance

- Questions come from the scenario catalog, 2–3 questions, one per message.
- Each question has a deterministic rule:
  - `free_text`: minimum length / minimum words, must not contain links,
    must not be a copy of the question, optional `any_of` keywords;
  - `choice`: inline buttons; the accepted options are listed; a typed answer
    matching an option label also counts.
- Nonsense guard: answers that are only emoji, only punctuation, or repeated
  characters fail.
- One retry per question: a failing free-text answer gets one "please answer a
  bit more fully" prompt before counting as failed.
- The decision is code, not judgement: all questions passed → approve (or
  manual review if screening said review).

## 7. Texts and rules — scenario file

`apps/join-gatekeeper/JOIN_SCENARIO.json`: all user-facing texts, the
question catalog, keyword/pattern lists and timeouts.

- `status: "draft" | "ready"`. Enforce mode refuses to start on a draft
  scenario. The texts shipped now are **draft placeholders written by the
  agent**; the owner must approve or replace them (JOINGATE-2) before
  activation.
- The scenario is validated at load (all referenced messages exist, question
  ids unique, rules well-formed); invalid → the service does not start.

## 8. Modes

`JOIN_GATEKEEPER_MODE`:

- `shadow` (default): receive requests, screen, log the would-be decision.
  **No Telegram writes** — no DM, no approve, no decline. Admins keep handling
  requests manually. Used to measure screening on real traffic first.
- `enforce`: the full flow. Requires a `ready` scenario.

## 9. Isolation and deployment shape

- Own app `apps/join-gatekeeper/`, own `package.json`, own tests, own SQLite
  file (`join-gatekeeper.sqlite` under its own data root), own HTTP routes
  (`/health`, `POST /webhooks/telegram`), own env prefix `JOIN_GATEKEEPER_*`.
- No imports from `apps/gatekeeper` or `apps/telegram-runtime`.
- Bot: either the existing Gatekeeper bot (A/B paused, so C may own its
  webhook) or a new bot — **owner decision at activation** (JOINGATE-1). The
  bot must be an admin of the merged group with `can_invite_users` only.
- Compose service, Traefik route, webhook registration and the group's
  "approve new members" switch are production actions — not done in this
  candidate.

## 10. Data and privacy

Stored per application: chat id, user id, username/name snapshot, screening
verdict + reasons, answers (needed for admin review), state, timestamps.
Answers and name snapshots are purged after `retentionDays` (default 30) by
the sweep (`DELETE ... WHERE`, INV-001 respected). Raw updates are not stored;
only `update_id` for dedupe. The DB file is private (0600) and never in git
(INV-004).

## 11. Evidence for this candidate

Local only: unit tests with a fake Telegram transport and injected clock
(screening, answer rules, full dialogue, timeout, dedupe, shadow mode, DM
failure, rate limit, webhook secret). Production behaviour: `not_run`.
Open technical question to confirm on staging: that after the user's first
reply the bot can keep writing past the 5-minute window (expected by Telegram
private-chat rules; status `inconclusive` until observed).

## 12. Activation checklist (all owner-gated)

1. JOINGATE-1: choose the bot (existing Gatekeeper bot or new).
2. JOINGATE-2: owner approves question texts, acceptance rules, keyword lists;
   scenario → `ready`.
3. Release lease: Compose service + route + env, webhook registration with
   `allowed_updates: ['chat_join_request','message','callback_query']`.
4. Group settings: bot admin with `can_invite_users`; "approve new members" on.
5. Run in `shadow` for a few days, review screening logs, then `enforce`.
