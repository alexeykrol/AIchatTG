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
in production), `prepared` (local candidate exists but is not merged/live),
`partial` (only a bounded part is solved), `proposed`
(recommended, not yet built), `superseded` (a later Product Owner decision
replaced it), or `inconclusive` (available evidence cannot prove the outcome).
Newest entries first.

---

## 2026-09-15 — Focus only on understanding and domain selection

**Reported by:** the owner explicitly separated understanding/classifying a
question from answering it using domain knowledge. They asked to focus on the
first problem: index, criteria, patterns, examples and comparison with failures.
Text knowledge is sufficient for now; answer-system optimization is not in scope.

**Candidate:** repaired compound labels and generic dry routing; added bounded
raw-versus-final routing diagnostics and an offline comparison harness with four
regressions plus 24 independently authored held-out cases. Knowledge and answer
policies were frozen. See [evidence and measurement gate](reports/2026-09-15-routing-only-comparison.md).

**Status: prepared.** 682 local tests passed with zero skips. Real model
comparison is `not_run`; test mechanics and exact-example overrides do not
establish improved recognition. No paid call or deployment was performed.

## 2026-09-15 — Domain index instead of a fixed set of course routes

**Reported by:** the owner showed refusals to “На какие вопросы ты отвечаешь?”
and “Кто ты и как тебя зовут?”, and an incomplete answer about the retired
`/ai` command. They asked for an extensible Markdown domain index and separate
knowledge for each domain, with domain architecture and knowledge optimization
treated as independent work. They authorized using useful design ideas from
other projects and preparing the implementation.

**Diagnosis:** the current source couples a fixed course route vocabulary with
special-case identity detection; the compound identity phrasing can miss that
bypass and be treated as outside the course. Public identity/usage facts,
domain recognition and knowledge availability need separate contracts. The
screenshots establish observed failures, not the internal route taken on every
pictured turn. No fresh production trace was requested or collected.

**Candidate:** a validated Markdown registry shared by router, analyzer,
source resolver and answer provider; current domains plus public self and
internal-boundary evidence; multi-domain coverage; exact labelled regression
cases; generic new-domain acceptance tests. No other-project runtime or data
import. See [architecture and limitations](ASSISTANT_DOMAIN_REGISTRY_V1.md).

**Status: prepared.** Local candidate only. Real-model recognition/answer
quality and production behavior remain unverified. Source package optimization
and the separate menu-cleanup incident are not claimed resolved.

## 2026-09-15 — Menu command still remains; recover the requirement history

**Reported by:** owner supplied a screenshot of the bare
`/ask@alexkrol_moderation_bot`: after the answer this service message must also
disappear; only the substantive question and answer should remain. The owner
reiterated that this had been discussed repeatedly.

**Diagnosis:** the original entry below already required both the command and
the hint. Only hint deletion was implemented; “chat hygiene fixed” was too
broad. Text-only matching also lacked durable ownership of the service pair.

**Recommendation / fix:** retain exact command/hint/user/chat association in
the existing completed event receipt. After full answer delivery, delete the
assistant's own hint and use the existing rights-checked Moderator Guard for
the bare command. Preserve Q/A, reject unrelated or edited targets, fence
unknown deletion outcomes. Read-only checks verified existing Moderator
delete rights in all three groups; no new permissions are needed.

**Status:** partial. The linked service-pair implementation was deployed as
`852a8d2` at 2026-09-15 06:49:50 UTC with unchanged rights/configuration.
In the closed synthetic test, hint 525 was deleted but command 524 received
`message to delete not found` from Telegram through Guard. The one-shot
uncertain receipt is fenced; no repeated delete or alternative-token attempt.
No Moderator inbound receipt exists for this synthetic command. Ordinary
human-menu deletion is not yet verified, so the owner's issue remains open.
Evidence: `docs/reports/2026-09-15-runtime-852a8d2-deployment.md`.
History and acceptance contract:
`docs/reports/2026-09-15-assistant-purpose-and-chat-hygiene.md`.

## 2026-09-15 — Capability answer describes infrastructure instead of course help

**Reported by:** owner quoted the live answer “Я — ИИ-ассистент проекта
AIchatTG ... Внутренние инструкции, модели, провайдеры ... не раскрываю” and
said the assistant must primarily help with course navigation. Requested a
search of prior adequate answers and 20–30, at most 50, paid closed-chat tests.

**Diagnosis:** dispatch was fixed, but it selected an extraction-time fallback
rather than the previously accepted «ИИ Навигатор» profile. The offline test
validated a response and invocation instructions, not product usefulness.

**Recommendation / fix:** restore the verified public profile/help from
accepted News source `a729ccd`, retain current invocation rules, and reserve
internal-detail boundaries for corresponding questions. Freeze a source-backed
acceptance bank and inspect actual answers, not merely HTTP/delivery success.

**Status:** partial. Restored profile is deployed in `852a8d2`; actual
CAP-01/USE-01/USE-02 replies passed content review. CAP-03 is partial because
it omits the expected general-rules/account-operation distinction. The extra compound
question “Кто ты и как тебя зовут?” still falls through the narrow profile
matcher and is refused; tracked as PROFILE-2. Post-fix run delivered 6/6,
content 4 passed / 1 partial / 1 failed, then stopped on MENU-01 cleanup. Cumulative
question count: 34/50; no blind send/deletion retries. Release receipt:
`docs/reports/2026-09-15-runtime-852a8d2-deployment.md`.
Baseline completed against `049cc22`: 28/28 answers delivered, 19 content
passes, 6 partial, 2 failed, 1 inconclusive. The profile failures and `/ai`
explanation were repaired in `62e1ebf`, included in deployed `852a8d2`; remaining source and
navigation findings are preserved in
`docs/reports/2026-09-15-assistant-live-baseline.md`.

## 2026-09-14 — Reconcile every instruction and fix every actionable error

**Reported by:** owner: "приведем доки в соответствие"; "найди историю всех
исправлений и моих указаний и сравни с тем, что сделано"; "Исправь все
ошибки".

**Diagnosis:** current docs mixed three different moments (`5e67451`,
`6c582ec`, `f51753f`), described historical executor sessions as live, claimed
Gatekeeper was in production, left three locally fixable runtime risks marked
open, and documented unsafe Claude framework automation as normal behavior.
The owner log itself omitted the August session/News handoff history and the
Docker-log prevention directive.

**Recommendation / fix:** recover source instructions from available Codex and
Claude transcripts, handoffs and Git history; classify every item without
converting historical evidence into production evidence; repair runtime,
Compose, tests, framework rules and current-state docs. Full matrix:
`docs/reports/2026-09-14-owner-instruction-reconciliation.md`.

**Status:** deployed for the bounded runtime fixes in `049cc22` at
2026-09-15 00:20:48 UTC; local framework/docs fixes committed and pushed.
Product/architecture proposals remain open in the reconciliation matrix.
Evidence: `docs/reports/2026-09-15-runtime-049cc22-deployment.md`.

## 2026-09-14 — Dialogs must not expire

**Reported by:** owner: project conversations must not have a deletion term.

**Diagnosis:** Claude's configured cleanup period was long but finite, the
project archive directory contained no JSONL, and the preservation script only
handled Claude Code. A service retention setting is not a durable project
archive.

**Recommendation / fix:** keep raw transcripts local and Git-ignored; archive
all available Claude project sessions plus the current Codex thread with
hashes. The script has no deletion path or retention period. Already deleted
source sessions cannot be recovered, and local disk backup remains separate.

**Status:** partial (local no-expiry archive fixed; backup and prior gaps remain).

## 2026-09-14 — Docker log diagnostics must be safe for every project and agent

**Reported by:** owner, after the hoster's incident analysis: the prevention
must be global for every project deployed to a server and apply to Codex and
Claude Code.

**Diagnosis:** several stalled `docker logs --tail` clients drove `dockerd` to
87–93% CPU on the one-vCPU VPS. Existing log rotation was already bounded, so
the confirmed operational cause was the unbounded lifetime of diagnostic
readers, not application load or health checks.

**Recommendation / fix:** every finite log read uses a hard timeout plus
bounded `--tail` and `--since`; every `--follow` has a finite lifetime and is
never detached; exit 124 stops the diagnostic without looped retry; kill the
stale client before considering container/daemon restart. Repository wrapper:
`scripts/aichattg/docker-logs-safe.sh`; global and project agent rules carry
the same boundary.

**Status:** fixed.

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

**Status:** partial; hint cleanup deployed in `049cc22` on 2026-09-15 UTC.
User-command cleanup still awaits verified bot permissions and implementation.

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

**Status:** deployed in `049cc22` on 2026-09-15 UTC; deterministic
self-description also passed an offline check inside the deployed container.

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

## 2026-09-14 — Three architectural risks (two fixed, one partially open)

**Reported by:** owner, as part of the same risk list above. These three are
recorded here because a recommendation exists but nothing has shipped yet —
losing that would silently turn "open and tracked" into "forgotten."

1. **No timeouts on Telegram/model calls; a webhook is handled synchronously
   end-to-end.** Moderation alone can take up to ~30s inside one Telegram
   webhook request; Telegram may retry the same update while the rest of the
   queue waits behind it. **Recommendation:** acknowledge the webhook
   immediately (200 first) and process the update from an internal per-chat
   queue, so one slow request can't block the others. The current candidate
   adds finite 15 s Telegram and 45 s provider deadlines without automatic
   retry. Immediate ACK remains proposed until a durable inbox/worker contract
   can survive a crash after HTTP 200. **Status: partial.**
2. **Rewrite (query reformulation) is wired in code but its container won't
   start if enabled** — `infra/aichattg/docker-compose.yml` passes
   `TELEGRAM_RUNTIME_REWRITE_ENABLED` but not
   `TELEGRAM_RUNTIME_REWRITE_MODEL` / `..._REASONING_EFFORT`, so turning the
   flag on in production would crash the container at boot. **Recommendation:**
   add the two missing variables to the compose passthrough. Never exercised
   in production (rewrite has stayed off), so no live incident — a
   configuration trap found by reading the code, not by an outage. Current
   candidate passes both values through Compose and tests the contract.
   **Status: fixed.**
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
   never up. Current candidate removes the inner cap and tests a wider retained
   window. **Status: fixed.**
