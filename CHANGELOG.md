# Changelog

All notable changes to AIchatTG are documented here. The project follows
semantic versioning for repository-level architecture releases.

## [0b54148] — 2026-09-15 UTC — Menu-first Help and approved boundary copy

Lifecycle `production-verified`; runtime started 20:16:45 UTC. Only runtime was recreated;
config, schema, routes, knowledge admission and Console remain unchanged.
Rollback `5600afd` is retained. See the
[release receipt](docs/reports/2026-09-15-runtime-0b54148-deployment.md).

- Help spells out the menu/prompt/reply workflow while retaining capabilities,
  identity grounding, text commands and mentions.
- The owner's final three-paragraph out-of-coverage response is preserved
  verbatim. The knowledge-enabled domain boundary now delivers that same text;
  known-domain knowledge gaps remain distinct. No new sanctions or retry rules.
- Frozen routing checks run on their original source; current checks remain
  current. No historical gold, hashes, paid captures or leases were changed.
- Root tests 688/688, historical receipt checks 29/29, migration checks 9/9,
  exact source/copy and repeated production health checks passed. New live
  Telegram/client acceptance was not run.

## [5600afd] — 2026-09-15 UTC — Registered Assistant domain routing

Lifecycle `deployed`; runtime started16:07:36UTC. Only telegram-runtime was
recreated; environment, schema, routes, knowledge admission and Console preserved.
Exact rollback image852a8d2 retained. See the
[release receipt](docs/reports/2026-09-15-runtime-5600afd-deployment.md).

- Markdown registry now supplies router/analyzer vocabulary, source bindings,
  public capabilities and domain policies, including self and abuse domains.
- Compound questions retain multiple domain attributions; existing receipts
  expose bounded raw-versus-final routing diagnostics without schema changes.
- Identity questions with knowledge enabled now use the existing model path,
  not a guaranteed zero-call static bypass. Configured models/caps are unchanged.
- Routing-only measured comparison: router28/28, analyzer26/27; one compound
  miss, two risk-label discrepancies and one uncertain missing result retained.
- Fresh canonical tests698 passed; six local-evidence-only checks separately
  passed in their original worktree. Nine migration safety tests and offline
  in-container compatibility passed. New live answer/menu acceptance not run.

## [852a8d2] — 2026-09-15 UTC — Course profile and linked menu cleanup

Lifecycle `deployed`; runtime started at 06:49:50 UTC. Environment, schema,
routes, knowledge and Console are unchanged. Rollback image `049cc22` retained.

- Restored «ИИ Навигатор» course purpose, capabilities and current invocation
  instructions; internal-detail restrictions no longer replace ordinary
  capability answers. `/ai` retirement is explicit in usage replies.
- Persisted exact command/hint ownership; complete answer delivery triggers
  one-shot cleanup of the proven service pair, with Guard rights checks and
  edit-race fences. Real Q/A and uncertain/legacy targets are retained.
- Added profile/cleanup regressions and wired 17 acceptance-runner safety
  tests into root `npm test`: 622 tests passed with no skips.
- Live acceptance is **not complete**: 6/6 delivered, content 4 passed / 1
  partial / 1 failed; compound identity was refused and CAP-03 omitted the
  expected account-operation boundary. Menu hint deleted, but Guard received
  not-found for the synthetic command; run stopped without retries. Human-menu
  verification and two unexecuted cases remain open. This entry does not claim
  the owner's menu issue is completely resolved.

See the [release receipt](docs/reports/2026-09-15-runtime-852a8d2-deployment.md).

## [049cc22] — 2026-09-15 UTC — Runtime deadlines and assistant fixes

Production-verified at image `049cc22`; runtime started at 00:20:48 UTC.
Previous image `f51753f` is retained for rollback. Runtime environment values,
routes and mounts were preserved; Operator Console was not recreated. See the
[deployment receipt](docs/reports/2026-09-15-runtime-049cc22-deployment.md).

### Fixed

- Telegram API requests now have one finite deadline (15 seconds by default),
  and provider requests have one finite deadline (45 seconds by default).
  Ambiguous timeouts are never retried automatically.
- Compose now passes the rewrite model/reasoning settings and both request
  timeout settings into `telegram-runtime`.
- Removed the hidden three-turn prompt projection cap; the configured
  `TELEGRAM_RUNTIME_ASSISTANT_DIALOGUE_TURN_LIMIT` is the turn-count limit,
  with a 50k dialogue projection and a final 60k limit on the complete
  router/analyzer/answer input, retaining the newest complete Q/A turns.
- Self-description now runs before knowledge retrieval even when knowledge is
  enabled. The bot's temporary empty-`/ask` hint is removed after its reply is
  answered; real prior answers are never cleanup targets (`2c02c56`).
- A Telegram refusal to delete the temporary empty-`/ask` hint is logged as a
  soft cleanup failure and cannot turn an already delivered answer into a
  failed request.
- Assistant profile copy now lists all three invocation paths: reply, `/ask`
  and mention.
- Claude project hooks and finish/repository-mode helpers no longer auto-commit
  at compaction, suppress failed tests or bulk-stage framework state.

### Documentation

- Reconciled README, knowledge enablement, snapshot, backlog and governance
  with the current one-root-integrator model; recorded the verified transition
  from production image `f51753f` to `049cc22`.
- Added a source-backed Product Owner instruction reconciliation report and
  made unresolved, partial, superseded and inconclusive outcomes explicit.

## [0.5.1] — 2026-09-14 — Reply to the assistant's own message now counts as addressing it

Deployed 2026-09-14 21:46 UTC (image `f51753f`, `telegram-runtime` container
recreated). Live bug, caught by the owner in production minutes after 0.5.0
went out: an empty `/ask` got the correct hint, but the very next message —
sent without repeating `/ask` or the bot's @tag — silently vanished. Telegram
never delivers an unaddressed message to a bot's webhook at all (confirmed
empirically: the moderator's webhook received it, the assistant's did not),
and even had it arrived, the code only recognised an explicit `/ask` or
`@mention` as an invocation.

### Fixed

- `detectAssistantQuestion(message, botUsername, botId)`: a Telegram **reply**
  to the assistant's own message is now a full invocation (`reason: 'reply'`),
  the whole message text becomes the question. A reply to a different bot, or
  any reply when `botId` is unknown, still does not count — narrow by design,
  same guards (forwarded messages, literal quotes) apply.
- The empty-`/ask` hint is now sent with `force_reply` (`reply_markup`,
  `selective: true`): Telegram opens the reply compose box for that user
  automatically, so a plain next message becomes a genuine reply without them
  needing to know the swipe-to-reply gesture. Hint copy now names both paths
  ("ответьте на это сообщение или отправьте /ask...") instead of only the
  one-message form.
- Tests: `packages/telegram-core` (+1 case: reply to own/foreign bot, missing
  `botId`, an explicit command inside a reply, a forwarded reply) and
  `apps/telegram-runtime` (empty-`/ask` scenario rewritten to assert
  `forceReply`, new reply-to-bot / reply-to-foreign-bot scenario). Full suite:
  559 tests, 0 failures, 4 skipped (unchanged, missing allcourses paths).

## [0.5.0] — 2026-09-14 — Shared dialogue snapshot across analyzer, router and answer

Deployed 2026-09-14 21:06 UTC (image `6c582ec`, `telegram-runtime` container
recreated; `operator-console` untouched — its code did not change). Rollback:
previous image `5e67451` is still present on the host.

### Added

- **Wave 1 + 2** (`f162456`, merged 2026-09-06): the analyzer, router and
  answer stages now read one shared snapshot of the last three Q/A turns
  instead of each stage re-reading dialogue history independently, so a
  follow-up question ("а на Windows?", "а как это настроить?") is answered as
  a continuation instead of a question with no context. Fixes a tie-break bug
  in turn ordering when two turns share the same second. A working-state
  module (goals/conditions/decisions, one extra guarded model call) ships
  disabled by default and is not wired into the live path.
- **Wave 3** (`07e69d3`, merged 2026-09-06): two local assistant instances
  that can hold a recorded conversation with each other — a lab tool for
  testing dialogue depth and memory without live users, not on the live path.
- `scripts/aichattg/docker-logs-safe.sh` (`a112179`, 2026-09-14): a bounded
  wrapper for `docker logs` on the shared VPS (line, time and deadline limits),
  plus the diagnostic rule in `AGENTS.md` and the runbook.

### Production configuration — 2026-09-14 21:06 UTC

Assistant enabled in the third chat («КвестТКР_Чат», config-only, same image
`5e67451`, applied 20:21 UTC then carried into this build unchanged) alongside
the code deploy above. `TELEGRAM_RUNTIME_ASSISTANT_CHAT_IDS` now lists all 3
chats the moderator covers. Previous `runtime.env` for `5e67451` is kept as
`runtime.env.pre-20260914` (rollback = restore and recreate). Webhook
`pending=0`, no startup errors, knowledge slices admitted (org 36, value 17),
analyzer `mode=dispatch` in the test chat. Procedure:
[docs/VPS_CUTOVER_RUNBOOK.md](docs/VPS_CUTOVER_RUNBOOK.md), "Configuration-only
change (same image)".

## [0.4.0] — 2026-08-16 — Analyzer, synthetic testing and honest usage accounting

Deployed 2026-08-17 (image `5e67451`, containers started 04:28 UTC). Covers
`0e12a87..5e67451`.

### Added

- **Request analyzer in observation mode behind a flag** (`eee1dd2`):
  `TELEGRAM_RUNTIME_ANALYZER_MODE=observe` computes a diagnosis and writes it to
  the observation journal without changing what the assistant sends. A
  read-only journal reader (`c01974c`, window-bounded and printing the turn id
  in `4da2d82`, symmetric hint/model comparison in `4bef789`).
- **Dispatch mode behind a per-chat gate** (`67e0632`): in the listed chats the
  analyzer verdict chooses the route and the router model is not called. The
  router is built from its spec and layer arbitration is configuration, not
  branching (`d2f51c0`). In production: dispatch in the test chat only.
- **Synthetic senders** (`f5ec2ed`): named bot ids in
  `TELEGRAM_RUNTIME_ASSISTANT_SYNTHETIC_BOT_IDS` pass the bot barrier and are
  answered without a moderation verdict that cannot exist for them; they have a
  separate daily cap (`7d6a1ce`), and the variables reach the container
  (`3104a9a`). In production: enabled with one synthetic bot.
- **Durable question → answer records in analyzer chats** (`3786bcc`).
- **Token usage recorded on every paid call** (`87bc8e8`), including
  moderation, which was previously free in the reports (`5e67451`); the
  console no longer prints an invented zero (`24205e6`).

### Changed

- The main topic is chosen by a rule over the data, not by the order the model
  returned (`921abc8`).
- The answer prompt names the permitted formatting forms (`b6816bc`).

### Fixed

- The value detector catches four phrasings found by the laboratory gold set
  (`46a1ddf`) and three more found in the production journal (`30b805a`).

## [0.3.1] — 2026-08-16 — The answer is delivered as it was written

### Fixed

- **Markup reached the reader raw.** The model answers in Markdown by default,
  the delivery adapter sent the text with no `parse_mode`, and every live
  reader since the roll-out saw `**жирный**` and `###` literally. Answers are now rendered to Telegram HTML
  (`packages/telegram-core/src/markup.mjs`) at the single call site where the
  text was written by the model; deterministic and service replies stay
  code-owned plain text.
- **A long answer was not truncated — it was never delivered.** Telegram rejects
  an over-limit message whole, and the 2048-token answer ceiling exceeds that
  limit in Russian. Answers are now split before sending, on paragraph → line →
  word boundaries; only the first part replies to the question, and its id is
  the receipt.

### Added

- A single plain-text resend on a markup parse refusal, and only on that
  refusal: at a 400 the message is provably undelivered, so the resend cannot
  duplicate an answer. Every other failure stays non-retryable.
- A journal line for every degraded delivery (`markup_stripped`, `partial`), so
  a stripped or truncated answer can no longer look flawless in the record.
- HTML escaping ahead of any tag we emit, `https`-only anchors, and a
  private-use sentinel for extracted code blocks that the answer text cannot
  forge — the "a stray character killed the message" class is unreachable
  rather than unlikely.
- 21 tests covering the renderer and the delivery adapter (repository total
  428: 424 passing, 4 skipped).

## [0.3.0] — 2026-08-15 — Assistant course knowledge live

### Added

- Admitted the laboratory-built course knowledge package (`ai-140310bf9472`,
  content-addressed, verified file-by-file against its signed manifest) and wired
  the deterministic retriever into the assistant answer path.
- Added the code-owned domain veto in front of retrieval: the model proposes a
  domain, measured evidence from the question sustains or refuses it, and a
  refusal costs no paid call.
- Added the `org` and `value` knowledge slices to the **production** path
  (`b255894`). They previously existed only in the laboratory bench, so both
  domains were invisible in production. A configured-but-refused slice now stops
  start-up instead of serving a silently empty domain.
- Added the positive `out_of_coverage` verdict with a warm code-owned reply and a
  coverage-deficit journal (`e52a494`), plus a value detector for the
  "magic pill" question family (`9dcf3fb`).
- Added question rewriting before retrieval as an explicit one-shot second pass
  (`a68ff6f`, measured +0.046 R@5) — implemented and shipped, disabled in
  production by configuration.
- Added an `error_text` column to inbound receipts so a silently failing event
  leaves evidence (`a4b0549`).

### Changed

- **New invocation contract** (`a2af55d`): the assistant is addressed like a chat
  participant. `/ask` is recognised anywhere in a message, an `@mention` of the
  bot is an equally valid call, `/ai` is retired with a one-line deterministic
  notice, a bare `/ask` returns a ready-to-use template, and a message that does
  not address the bot stays unanswered on purpose.
- Service replies (help, retired command, empty `/ask`) are delivered but no
  longer persisted into dialogue history.
- A detector-proven domain hint now forces the route over any conflicting model
  verdict, including `redirect` (`9814881`), and a `redirect` verdict is served by
  abstention instead of a paid call without knowledge (`0167e86`).
- The answer prompt for the value domain must not open by refuting a claim the
  user never made (`8579023`).

### Fixed

- Compose did not pass the knowledge package and slice variables into the
  container, so an otherwise correct deployment reached the runtime without
  knowledge (`0c17dc9`).
- A service reply stored with an empty question poisoned dialogue history, made
  every later answer fail with `provider_request_invalid`, and left the event
  stuck in `processing` with empty logs (`a4b0549`).

### Known at the time of this release

- Telegram markup was not rendered: the runtime sent no `parse_mode`, so
  `**bold**` and `###` reached readers literally. Closed the next day in 0.3.1.

## [0.2.0] — 2026-08-04

### Changed

- Finalized AIchatTG ownership of Telegram Moderator, Assistant, Gatekeeper and
  the operator console after extraction from News.
- Passed documented moderation recovery, assistant rate-limit and knowledge
  admission configuration into the standalone Telegram runtime.
- Added a separate read-only knowledge mount and an infrastructure contract
  test; course knowledge remains disabled until a new snapshot is accepted.
- Removed stale Facebook/News ownership copy from the AIchatTG operator UI and
  reconciled source-provenance and cutover documentation.

### Removed

- Removed the runnable historical Tribute capture service. Its immutable Git
  history remains the evidence; it is not an active AIchatTG runtime.

## [0.1.0] — 2026-08-03

### Added

- Initial standalone repository, Telegram core, Moderator/Assistant runtime,
  Gatekeeper, isolated infrastructure contracts and operator console.
