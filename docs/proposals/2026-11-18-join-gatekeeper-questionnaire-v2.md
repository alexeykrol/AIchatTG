# Join-request gatekeeper — questionnaire v2 (A0-bis)

**Status:** local candidate, nothing deployed. Texts and rules approved by the
Product Owner via coordinator `aichattg-33` on 2026-11-18 (A0-bis), except the
two agent-written strings listed in §7. Overrides
[v1](2026-11-15-join-request-gatekeeper-v1.md) §4–§6 and the screening parts of
[v2](2026-11-17-join-request-gatekeeper-v2.md) §2–§3. Tokens, probation
mechanics, triage execute, rights and modes are unchanged.

## 1. What changed

| Area | Before (v1/v2) | Now (A0-bis) |
|---|---|---|
| Screening | verdict `block` / `review` / `clean`; `review` → `manual_review` after answers | pre-checks decline at once with one reason code; no `review` outcome |
| Soft signals (emoji/invisible chars, mixed script, empty name, no photo) | `review` | informational only (`screening_reasons`), never decline |
| Profile channel | not checked | `getChat(user_id)` → `personal_chat` present → `R_PROFILE_AD` (best effort; failure = unknown) |
| Questions | purpose (choice) + free text + rules | participate (choice) + rules (choice) + topics (multi-select) |
| Decline texts | one generic text | one text per reason code (`reasons` map) |
| Pre-check DM | none (silent decline) | reason DM via `user_chat_id` **before** `declineChatJoinRequest` (incl. `R_RATE`, `R_SCAM`) |
| Retry on free text | one retry | no free text questions; an unmatched typed answer just re-shows the question |
| `decision_reason` | `screening_block`, `answers_failed`, `timeout`, … | the reason code (`R_*`) on every decline / would-decline |
| Scenario file | `schemaVersion` 1 | `schemaVersion` 2 (`reasons`, per-option `reject`, `multi_choice`) |

## 2. Reason codes

| Code | When | Stage | DM key |
|---|---|---|---|
| `R_RATE` | > `maxApplicationsPerUserPerDay` (3) requests in 24 h | pre-check 1 | `reject_rate` |
| `R_SCAM` | `from.is_bot`; in triage also `is_scam` / `is_fake` | pre-check 2 | `reject_scam` |
| `R_PROFILE_AD` | see §4 | pre-check 3 | `reject_profile_ad` |
| `R_STOPWORD` | spam keyword (word-start match) in first/last name, username, bio | pre-check 4 | `reject_stopword` |
| `R_READER` | Q1 «Нет, только читать» | answer | `reject_reader` |
| `R_RULES` | Q2 «Нет» | answer | `reject_rules` |
| `R_TOPIC_AD` | own topic contains a link (scenario `linkPatterns`), an @mention or a spam keyword | answer | `reject_topic_ad` |
| `R_TIMEOUT` | questions not finished within `answerTimeoutSeconds` (30 min) | sweep | `reject_timeout` |
| `R_DELETED` | triage only: export `is_deleted: true`; precedes `R_SCAM` | triage | — (no DM in triage) |

A rejecting answer declines immediately (later questions are not asked).
In probation the same answers remove the member with the existing probation
text; the code is stored as `decision_reason`.

## 3. Decision rule (code, deterministic)

Approve only if all hold: no bot/scam/fake flag; no profile advertising; no
spam keyword in name/username/bio; within the daily request limit; all
questions answered within the timeout; Q1 = participate; Q2 = agree; ≥ 1 topic
selected or a clean own topic added. Otherwise decline with exactly one code.
Pre-check precedence: `R_RATE` → `R_SCAM` → `R_PROFILE_AD` → `R_STOPWORD`.
Verified members (token) are approved without questions, as before. Pre-checks
passed but the DM cannot be delivered → probation (v2 §2), as before.

## 4. Profile-advertising rule

`R_PROFILE_AD` if any of: bio contains a link (scenario `linkPatterns`, incl.
`t.me/`) or an @mention; first/last name contains a link or an @mention;
username contains a link; `getChat(user_id)` returns `personal_chat`. If the
join request has no `bio`, the `bio` from `getChat` is used. `getChat` failure
or absence is unknown, never a signal. `getChat` is a read call and runs in
shadow mode (like `getUserProfilePhotos`). Triage: optional export field
`has_personal_chat` (`true` → signal; `false`/`null`/missing → none).

## 5. Topics question (multi-select)

Five topic buttons, «Добавить свою тему», «Готово». A topic press toggles it:
the bot edits the keyboard of the same message (`editMessageReplyMarkup`,
selected topics marked «✅ ») and answers the callback. «Добавить свою тему» →
prompt; any free text sent while on this question is an own topic. Clean →
counted, the topics prompt and keyboard are re-sent so «Готово» is at hand;
dirty → `R_TOPIC_AD`; text without letters/digits is ignored (not counted,
keyboard re-sent). «Готово» with nothing selected and no own topic → a callback
notice, no decision. Callback data `jg:<question>:<option>` stays ≤ 64 bytes
(validated at load).

## 6. Data saved

Into the existing `join_answers` table (purged by the existing retention,
30 days): `option:<id>` per choice answer; one row per topic toggle (`reason`
`toggle`, text = topic id); each own topic (`custom_topic`, text truncated to
1000 chars; a rejected one is stored with `pass = 0`, reason `R_TOPIC_AD`); and
a summary row on «Готово» (`done`, text `selected:<ids>;custom:<n>`). A restarted
questionnaire writes a `questionnaire_start` marker so earlier toggles do not
carry over. Logs carry decisions, reason codes and signal codes only — never
names, bio, answers or topic text.

## 7. Agent-written strings (need owner approval)

- `topic_custom_prompt`: «Напишите свою тему одним сообщением.»
- `topics_empty` (callback notice): «Отметьте хотя бы одну тему.»

The selection mark «✅ » on topic buttons is also agent-chosen UI.

## 8. Schema statement

**No database schema change.** The DB stays at schema version 2; no migration,
no new table or column. New `decision_reason` values are free text in an
existing column. The only format version bump is the scenario file
(`JOIN_SCENARIO.json` `schemaVersion` 1 → 2), validated at load; a v1 scenario
file is refused.
