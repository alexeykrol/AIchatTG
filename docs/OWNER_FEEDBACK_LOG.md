# Owner Feedback Log

This is not `CHANGELOG.md`. The changelog is written for a future reader of
the *software* — what shipped, in which release. This log is written for a
future reader of the *owner* — what the Product Owner personally observed or
flagged (a live bug, a stale doc, a missing behaviour), what the diagnosis
was, what was recommended, and what actually happened to it. A changelog
entry can summarize the fix; only this log keeps the report that triggered
it, in the owner's own words, and keeps entries that never became code at
all (`status: proposed`) instead of dropping them because nothing shipped.

Format per entry: what the owner saw → diagnosis → recommendation/fix →
status. `status` is one of `fixed` (code merged), `deployed` (fixed and live
in production), or `proposed` (recommended, not yet built — an open item,
not a resolved one). Newest entries first.

---

## 2026-09-14 — Chat hygiene: service messages should self-delete

**Reported by:** owner, in chat, after seeing the empty-`/ask` exchange stay
visible in the group alongside the real Q&A: "первоначальное сообщение бота
и его упоминания ... нужно удалять, потому что они засоряют."

**Diagnosis:** once a real answer has been delivered, the messages that only
existed to get there — the bot's own hint text, and the bare `/ask@bot`
command that triggered it — are pure clutter in the group.

**Recommendation / fix:** delete the bot's own hint message
(`ASSISTANT_EMPTY_ASK_TEXT`) once the reply it invited has been answered,
matched by the replied-to message's exact text so a reply to a *real* past
answer can never be deleted by mistake. Implemented, commit `2c02c56`.
Deleting the user's own triggering command message is a second, separate
half: it requires the assistant bot to hold delete-message admin rights in
the group, which was not verified as of this entry. **Open question for the
owner:** does the assistant bot have admin/delete rights in the covered
groups?

**Status:** fixed (hint half only) · not yet deployed.

## 2026-09-14 — "Что ты можешь?" answered with the wrong boundary text

**Reported by:** owner, screenshot of a live exchange: replied to the
empty-`/ask` hint with "Что ты можешь?" and got "Хороший вопрос, но эта тема
за пределами курса, и отвечать на неё я не уполномочен..." — a refusal
clearly wrong for a question about the assistant itself.

**Diagnosis:** the self-description detector (presence pings, "кто ты",
"что ты можешь") was only ever invoked when `assistantKnowledgeEnabled !==
true`. Production has knowledge enabled, so the detector was dead code: every
self-referential question fell through to course-material retrieval, found
no matching domain, and abstained with course-boundary text meant for actual
course questions.

**Recommendation / fix:** run the self-description check unconditionally,
before the knowledge-enabled branch, so it answers regardless of the flag.
Implemented with a regression test asserting the model is never called for
this class of question. Commit `2c02c56`.

**Status:** fixed · not yet deployed.

## 2026-09-14 — No answer to a follow-up message after an empty `/ask`

**Reported by:** owner, screenshot: sent an empty `/ask`, got the hint, sent
a plain follow-up message — no answer at all. "ответа нет - проверь, в чем
проблема."

**Diagnosis:** two compounding causes. Telegram's Privacy Mode never
delivers an unaddressed plain message to a bot's webhook at all (confirmed
empirically by comparing the moderator's and assistant's webhook receipts
for the same message). Separately, even if it had arrived, the code only
recognised an explicit `/ask` or `@mention` as an invocation — a reply to
the bot's own message was not one.

**Recommendation / fix:** two-part fix within Telegram's Privacy Mode
constraints (a reply to a bot *is* delivered even under Privacy Mode): (1)
`detectAssistantQuestion` now treats a Telegram reply to the assistant's own
message as a full invocation; (2) the empty-`/ask` hint is now sent with
`force_reply`, so Telegram opens the reply compose box automatically and a
plain next message becomes a genuine reply. Commit `f51753f`.

**Status:** fixed · deployed 2026-09-14 21:46 UTC, image `f51753f`
(`0.5.1` in `CHANGELOG.md`).

## 2026-09-14 — Docs had drifted from production

**Reported by:** owner: "Документы разошлись с продом. CHANGELOG и README
застряли на 16.08. В примере конфигурации для выбора маршрута указана не та
модель ... Режим с анализатором там тоже не описан."

**Diagnosis:** `CHANGELOG.md` and `README.md` had not been updated since the
0.4.0 release; `infra/aichattg/runtime.env.example` named a different router
model than the one actually configured in production; the analyzer/dispatch
mode shipped in 0.4.0 was undocumented.

**Recommendation / fix:** align `CHANGELOG.md`, `README.md`,
`infra/aichattg/runtime.env.example`, `docs/ASSISTANT_KNOWLEDGE_ENABLEMENT.md`
and `docs/MIGRATION_FROM_NEWS.md` with the production state. Commit
`6c582ec`.

**Status:** fixed.

## 2026-09-14 — Governance doc named the wrong integrator

**Reported by:** owner: "Архитектура управления поменялась. Сейчас все
делаешь ты ... В AGENTS.md им назван Codex, а срок, до которого координатором
был Claude, истёк 12.09."

**Diagnosis:** `AGENTS.md` still described Codex as the integrator/executor
and referenced an expired Claude coordination window, no longer matching how
the project is actually run (a single Claude Code session as permanent
integrator and executor).

**Recommendation / fix:** rewrote the "Integrator and executor protocol"
section of `AGENTS.md` to state the current governance plainly. Commit
`6c582ec`.

**Status:** fixed.

## 2026-09-14 — Three unactioned architectural risks (proposed, not built)

**Reported by:** owner, as part of the same risk list above. These three are
recorded here because a recommendation exists but nothing has shipped yet —
losing that would silently turn "open and tracked" into "forgotten."

1. **No timeouts on Telegram/model calls; a webhook is handled synchronously
   end-to-end.** Moderation alone can take up to ~30s inside one Telegram
   webhook request; Telegram may retry the same update while the rest of the
   queue waits behind it. **Recommendation:** acknowledge the webhook
   immediately (200 first) and process the update from an internal per-chat
   queue, so one slow request can't block the others. **Status: proposed.**
2. **Rewrite (query reformulation) is wired in code but its container won't
   start if enabled** — `infra/aichattg/docker-compose.yml` passes
   `TELEGRAM_RUNTIME_REWRITE_ENABLED` but not
   `TELEGRAM_RUNTIME_REWRITE_MODEL` / `..._REASONING_EFFORT`, so turning the
   flag on in production would crash the container at boot. **Recommendation:**
   add the two missing variables to the compose passthrough. Never exercised
   in production (rewrite has stayed off), so no live incident — a
   configuration trap found by reading the code, not by an outage.
   **Status: proposed.**
3. **Dialogue memory depth has two layers, and only the outer one is
   configurable.** `store.recentDialogue()` is fetched with
   `config.assistantDialogueTurnLimit`
   (`TELEGRAM_RUNTIME_ASSISTANT_DIALOGUE_TURN_LIMIT`, already an env var,
   default 3) — but `assistantDialogue()` in `assistant-dialogue.mjs`, the
   function that turns that fetch into the snapshot analyzer/router/answer
   actually read, re-caps it with a hardcoded `.slice(-3)`. Raising the env
   var past 3 currently does nothing: the inner cap silently overrides it.
   **Recommendation:** either read the same config value inside
   `assistantDialogue()` instead of the literal `3`, or document plainly
   that 3 is the real ceiling and the outer config only trims further down,
   never up. **Status: proposed.**
