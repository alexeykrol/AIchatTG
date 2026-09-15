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

## 2026-09-15 — Release the Russian Console v3 separately from Assistant

**Reported / requested:** after the Assistant footer release the owner asked
«Похоже деплоя новой админки еще не было?» and then explicitly said «Деплой».
The integrator confirmed that the Console was still on `5e67451`; the prior
release affected only Assistant `2.4.37` and must not be presented as a Console
deployment.

**Preparation:** merge the three Console commits ending at `c62701c` onto
current `1bd8bd8`, preserving both feedback histories. Release scope is only
`aichattg-operator-console`, its bundled domain sources and separate versioned
draft directory; runtime DB remains read-only. Existing route/auth and runtime
image `335a35a` remain unchanged. The five added Console env fields expose
domain/draft paths and actual chat/dialogue/synthetic settings without changing
bot configuration. Read-only preflight found no existing-setting drift.

**Release review:** reproduced a v3 Markdown editor race where switching domains
while a read was pending could save the previous text into the newly selected
domain draft. The integrated candidate adds a domain/state fence and nine
regressions for pending/out-of-order reads and in-flight saves. No production
draft or runtime data was affected. Root tests780/780, original historical
receipt checks29/29 and migration safety9/9 passed; Console30/30 is included.

**Release oversight:** the owner's task-specific instruction is that the
requesting Console task controls follow-through and final evidence review,
while the integrator remains the sole technical production writer and lease
owner. The analogous Assistant/Moderator oversight requests do not authorize
their separate menu candidates or change the current Console-only scope.

**Status: deployed.** Lifecycle `production-verified`, exact Console source
`82cb8c6`, started21:23:28UTC. Postverify21:24:28 and21:26:58 passed:
healthy/restart0,29file source match, Russian pages/auth/API/storage verified,
runtime335a35a unchanged. Existing token/routes preserved; new draft root
UID1000:1000/mode0700. Lease/master closed; no draft save or paid/Telegram call.
Menu localization and the separate Moderator command-removal proposal remain
outside this release. [Receipt](reports/2026-09-15-console-v3-deployment.md).

**Independent visual acceptance:** the Console task checked Settings, both
Markdown domains and Analytics in ordinary production Chrome with existing
auth; Russian navigation and draft-only semantics passed. The user then
started using that tab; automation stopped. Other three pages have HTTP/source
checks, not a completed production visual check.

**Cost accounting remains partial:**38/44/75 questions for24h/7d/history were
visible, but none of the75 had complete priced-stage receipts. Sum/average
remain unknown (dashes), never zero. A complete metadata-only stage/token
ledger and bounded aggregation remain proposed; this deployment does not
claim the owner's full spending-analysis request is completed.

## 2026-09-15 — Implement and release the restored version footer

**Requested:** «Исправь, закомить, запуш и задеплой это» after the version/footer
audit below. The integrator announced continuation of the distinct Assistant
component line as `2.4.37`, after historical candidate `2.4.36`; project and npm
scaffold numbers are not reused as public component versions.

**Implementation:** canonical release JSON (`2.4.37`, `2026-09-15`) supplies
«Версия 2.4.37 от 15.09.2026». Every existing Assistant send path supplies the
code-owned footer; Telegram appends it after rendering, once on the final part,
reserving space and preserving emoji, plain fallback, forceReply and delivery
fences. No new replies are added to previously silent exits. Approved body
copy remains unchanged; bounded model memory stays bare while durable answer
receipts and local visible transcripts retain the logical footer.

**Regression prevention:** Codex/Claude instructions and the runbook share the
metadata source and release gate. The static Git checker validates version/date
and rejects Assistant-affecting changes without a higher component version
against production. A missing historical baseline is explicitly bootstrap.
Current dual-dialogue tests now account for their existing whitespace
normalization with multiline replies; raw ledger/receipt checks remain intact.
Historical frozen sources/gold/paid artifacts were not modified.

**Status: deployed.** Lifecycle `production-verified`, exact source `335a35a`.
Runtime started 21:01:48 UTC; verification at 21:02:15 and 21:04:31 UTC passed:
healthy/restart0, 57 source-file matches, four offline footer transport cases,
unchanged env/schema/routes/mounts/Console and retained rollback `0b54148`.
Public health200, unauthenticated webhook401/401. Root tests passed
758/758 (including 61 release-guard checks), explicit historical receipt lane
29/29, migration safety 9/9, scenario/isolation and independent review passed.
Code committed/pushed/deployed; lease and SSH master closed. New paid and
Telegram acceptance are `not_run`. See the
[release receipt](reports/2026-09-15-assistant-2.4.37-deployment.md).

## 2026-09-15 — Restore the Assistant version number and release footer

**Reported by:** after receiving a Git SHA instead of a version number, the
owner reminded the integrator: «в конце каждого ответа внизу писать № версии
и дату релиза». This is a previously implemented behavior, not a new feature.

**Diagnosis / passed:** historical News source `0a818c5d` contains Assistant
component version `2.4.35` and the code-owned line «Версия 2.4.35 от 01.08.2026»
in `news-digest-pipeline/src/pro/moderation/assistant.js:349`; its
`appendAssistantUsageHint` appends the footer once and reserves Telegram space.
Accepted continuation source `ef1c6ea` has `2.4.36`, timestamp
`02.08.2026 12:46 PDT` and explicit footer regressions. That historical
candidate is not proof of a current or former production deployment.
Archived News task evidence also records a footer discrepancy audit and final
response-path tests. The original direct wording discussion was not located
in the bounded transcript search; the prior implementation is verified in Git.

Current deployed source `0b54148` has no Assistant release metadata or footer:
`sendAssistantTurn` passes `answer.text.trim()` directly to Telegram. The last
numbered project changelog entry is `0.5.1` (2026-09-14); subsequent deployments
were recorded only by SHA. The runtime package still says `0.1.0`, unchanged
since its initial scaffolding, and is not the Assistant's public release number.
The integrator's prior answer incorrectly substituted a Git identity for the
requested version number. A new number must not be invented retroactively.

**Recommendation / status: proposed.** Restore a distinct, canonical Assistant
version/date source and a deterministic bottom-of-answer footer across reply
paths, preserving approved answer bodies, Telegram length limits and clean
dialogue memory. Add release checks for version/date advancement and exact
footer delivery; settle the component numbering continuity explicitly rather
than conflating historical `2.4.x`, project `0.5.x` and npm scaffold versions.
This turn changes only the feedback log and backlog: code/fix/deployment,
remote access and paid/Telegram calls are `not_run`.

## 2026-09-15 — Deploy the owner's exact three-paragraph boundary response

**Reported by:** the owner supplied a replacement «точно, без редакции»
(`01a0a6a8-de9d-72f2-9a00-2bd730adda82`), viewed the final text and explicitly
requested «Отлично. Деплой.» (`01a0a6ab-a9ea-7c90-ac1c-b4f18bc8dedc`).
This supersedes the additive-only wording decision recorded below.

**Implementation:** candidate `541a2de` was integrated as `71c6568`. The exact
three paragraphs, punctuation and «смогу найти ответить» are preserved; text
SHA-256 is `a58d0b6896776c2431875801e68ffd487807528702bf40427322da949bc902ba`.
Pre-release review found that the knowledge-enabled `domain_no_signal` path
still returned its own older catalog text, shadowing the approved constant.
That path now delegates to the same policy reply. The known-domain knowledge
gap remains distinct. Real runtime-port and dialogue-history regressions
verify exact delivery; the copy does not add moderation, escalation, bans,
retry behavior, model calls or quota changes.

**Status: deployed.** Exact root candidate `0b54148` was pushed and deployed
at 20:16:45 UTC under a one-time runtime-only lease; lifecycle
`production-verified`. Checks at 20:17:31 and 20:20:00 UTC both passed:
healthy/restart 0, 55-file source match, exact copy digest through the domain
boundary, unchanged env/schema/routes/Console and retained rollback `5600afd`.
Focused checks passed 72/72; root 688/688, frozen-source receipt checks 29/29,
migration 9/9 and scenario/isolation checks passed. New paid and Telegram
acceptance are `not_run`. See the [receipt](reports/2026-09-15-runtime-0b54148-deployment.md).

## 2026-09-15 — Open the local Console in an existing full Chrome tab

**Reported by:** the owner said «ничего не запущено», rejected the in-app
browser as inconvenient, and requested a full tab in an already open browser.
The supplied screenshot showed `ERR_INVALID_AUTH_CREDENTIALS` at `127.0.0.1`.

**Diagnosis / passed:** the local Console process was listening on
`127.0.0.1:8790` and unauthenticated `/health` returned HTTP 200. The in-app
browser failed at the Basic-auth boundary. A tab created through the Chrome
browser integration also returned `ERR_BLOCKED_BY_CLIENT` for both the Console
and its public `/health` route. This was a browser access failure, not evidence
that the server was stopped.

**Resolution / passed:** in the owner's already open Chrome window, a normal
tab outside the integration-created group opened the same localhost URL. Basic
sign-in completed and Chrome's accessibility state showed the Assistant
settings page, navigation and editable candidate fields. No credential was
saved by the agent; no application code or production system was changed.

**Status: partial.** Local browser access is verified for this running process.
Automatic restart after a reboot and production data access are `not_run`.

## 2026-09-15 — Edit domain Markdown and show Assistant question costs

**Reported by:** the owner agreed with editable Assistant parameters and added:
«у нас для нескольких доменов - база для ответа в MD файле - проверь и эти
файлы тоже надо сделать редактируемыми. Для них отдельную вкладку. Плюс
отдельная вкладка по аналитике, включая затраты на вопросы - средние, за
день, за неделю и т.п.»

**Diagnosis:** the current domain catalog binds two answer sources to local
Markdown (`assistant-self.md`, `assistant-abuse.md`); the other four use signed
lesson retrieval or snapshots. Existing durable Assistant answer receipts
in normal runtime cover analyzer-enabled chats, so all-chat cost and invoice
totals cannot be inferred from the available data. The old Console has no
candidate editor or separate cost page.

**Recommendation / implementation:** a local v2 candidate adds Settings,
Domain knowledge and Analytics tabs. Markdown and setting saves create
versioned, validated candidates without changing the Telegram runtime.
Analytics reports known estimated spend and average only for fully priced
recorded questions, separately exposing unknown cost and current coverage.
See [candidate report](candidates/2026-09-15-operator-console-v2.md).

**Status: partial.** The local Console candidate is `prepared`; it is not
merged or live. All-chat usage, failed paid attempts and cached-token invoice
cost remain `proposed` pending a metadata-only usage ledger. Production,
Telegram messages and paid calls were `not_run`.

## 2026-09-15 — Add a clarification suggestion without rewriting the boundary reply

**Reported by:** the owner asked to add a rephrasing suggestion, then explicitly
corrected the broader rewrite: «Твоя задача была добавить, а не жестко
редактировать». Source messages `01a0a6a2-6a0e-7ad1-9c5d-60b7da5b128d` and
`01a0a6a4-69dc-7d42-a250-b9f8b7728f8a` in the Assistant task.

**Implementation:** source candidate `60f6b9b` was independently reviewed and
cherry-picked as `183d7f9`. Every original sentence in the out-of-coverage
response is preserved; only this sentence is inserted after the opening:
«Возможно, вам стоит сформулировать вопрос иначе: назовите тему, урок или
задачу — тогда я смогу попробовать найти ответ.» No insulting copy or
unsupported claim about automatic moderator escalation or a permanent ban was
added. The adjacent comment makes clear this is a wording change, not a retry
limit or moderation rule.

**Status: fixed.** Local integration only; candidate lifecycle `prepared`.
An exact-text regression checks the single insertion and unchanged original
wording; root tests passed 688/688, frozen-source receipt checks 29/29.
Production, paid calls, Telegram settings/messages, push and deployment
remain `not_run`. See [verification](reports/2026-09-15-coverage-copy-candidate.md).

## 2026-09-15 — Make Help explicit and menu-first

**Reported by:** the owner asked to spell out every step for an inattentive,
hurried reader, with the menu as the primary path. They also supplied the
«Что я могу» capabilities text and asked to update its usage instructions.
Source messages: `01a0a689-3fd8-7102-adca-78d15b40c4f6` and
`01a0a68b-c95c-7f92-ada9-a12b5513c723` in the Assistant task.

**Implementation:** menu `/ask` → send command → reply to the bot's prompt →
send the question; no repeated `/ask`. Text `/ask` and @mention remain secondary.
Capabilities wording is preserved in both static Help and public Markdown.
Independent integration review restored the accidentally removed public
identity grounding and matched the quoted prompt prefix to the actual prompt.
This is not a change to the existing cleanup or admission behavior.

**Test isolation:** the candidate exposed historical routing-v1 checks coupled
to old source hashes; their guard was correct, but running them against moving
runtime sources was not a maintainable default suite. They now run automatically
on exact `5600afd` source, while current routing/provider checks stay current.
No historical hashes, gold, paid captures, budgets or leases are rewritten.

**Status: fixed.** Merged in local `main`; candidate lifecycle `prepared`, not
pushed or deployed. Final root tests 687/687; explicit frozen-source tests with
original receipts 29/29; migration checks 9/9. Live Telegram/client/answer
acceptance and paid calls remain `not_run`.
See [integration evidence](reports/2026-09-15-help-menu-candidate.md).

## 2026-09-15 — Owner disabled inline mode; verify the change

**Reported by:** owner wrote «я выключил — проверь» after changing BotFather.

**Verification / passed:** exactly one read-only `getMe` response at
18:47:46.491 UTC confirmed `alexkrol_moderation_bot` has
`supports_inline_queries=false`. This supersedes the enabled-setting snapshot
and pending-disable recommendation below; the owner made the setting change.
The integrator did not send messages, read logs, change the webhook/config,
deploy, or call a model. The single key-only SSH master was closed.

**Status: partial.** The setting correction is verified. A fresh client-side
composer/ordinary-mention/answer check remains `not_run`; no claim of end-to-end
acceptance is made from `getMe` alone.

## 2026-09-15 — Telegram waits while composing an @bot question

**Reported by:** the owner said Telegram appears to hang when entering
`@alexkrol_moderation_bot что ты можешь?`; the screenshot shows the question
still in the composer with a loading indicator. Source: Assistant task,
owner message `01a0a646-defa-7892-92f3-37985b19d987`.

**Diagnosis / passed:** read-only `getMe` at 18:19:42 UTC confirmed the expected
bot has `supports_inline_queries=true` and `supports_guest_queries=false`.
`getWebhookInfo` confirmed the expected Assistant URL, but its actual
`allowed_updates` is only `message, edited_message`; pending count was zero
and no last-error fields were present. The runtime has no `inline_query` or
`answerInlineQuery` handler. This is a confirmed bot-setting/runtime mismatch:
[Telegram inline mode](https://core.telegram.org/bots/inline) requests results
from the composer before a chat message is sent. The currently selected update
types exclude those requests. Exact runtime image/revision remains `5600afd`,
healthy with zero restarts and unchanged 16:07:36 UTC start. All 23 core contract
tests passed locally, including ordinary sent mentions and replies.

**Limits / inconclusive:** no correlation ID or client trace identifies the
pictured request, so its exact delivery and the client-side duration are not
proven. Docker logs were not read: the HTTP layer does not log each unsupported
update, and absence of such lines would not prove no arrival. Live reproduction,
Telegram sends, provider calls and configuration changes were `not_run`.

**Recommendation / status: proposed.** Obtain a separate exact approval to
disable inline mode for this bot in BotFather, then verify `getMe` and the
composer behavior; ordinary sent mentions, `/ask` and replies stay supported.
This needs no application deployment or webhook-filter change. Capture the
existing inline settings before any change for rollback. Implementing a real
inline adapter instead is a separate product/privacy/quota decision, not an
automatic webhook expansion. No production settings, code or data were changed
by this diagnosis; its single key-only SSH master was closed.

## 2026-09-15 — Deploy the measured domain-routing candidate

**Reported by:** after the comparison report, the owner wrote «деплой».
The root integrator independently re-read the original user message and
accepted the exact5600afd candidate for a one-time runtime-only release.

**Action / evidence:** fast-forward integration and push; exact Git archive;
runtime started16:07:36UTC, healthy/restart0. All55 source files matched,
environment/schema/routes/Console preserved, rollback852a8d2 retained. Fresh
tests and offline in-container compatibility passed. Self questions now use
the model path included in the candidate; existing quotas/tuples unchanged.

**Status: deployed.** This supersedes the prepared state of the two entries
below, not their historical evidence. Routing-only paid comparison was104
attempts/103 results (new router28/28, analyzer26/27). Compound-domain loss,
two risk-label discrepancies and one uncertain result remain explicit.
New live answer/menu acceptance not_run; no new paid test or Telegram send.
See [release receipt](reports/2026-09-15-runtime-5600afd-deployment.md).

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

## 2026-09-15 — Смешаны старое и новое меню панели

**Сообщил владелец:** при переключении вкладок «Модерация», «Ассистент» и
«Тесты» открывалась старая русская панель с тремя пунктами, а «Настройки»,
«Базы ответов» и «Аналитика» показывали новый англоязычный интерфейс с шестью
пунктами. Владелец попросил единый вариант полностью на русском, включая меню
и подписи; приложил снимки всех состояний.

**Диагноз:** сервер отдавал три старые страницы и три новые напрямую. У новых
страниц была собственная навигация, а старые страницы сохраняли прежнюю,
поэтому разные вкладки фактически переключали версии интерфейса.

**Рекомендация / исправление:** подготовить единую русскую версию v3 всех шести
вкладок с одинаковым меню и оформлением; обычные старые адреса направлять на
соответствующую страницу v3. Оригиналы v1/v2 оставить по отдельным адресам
для сравнения и проверки истории. Проверить все вкладки в обычной вкладке
внешнего браузера.

**Статус:** подготовлен локальный кандидат; выпуск в production не выполнялся.
