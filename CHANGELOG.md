# Changelog

All notable changes to AIchatTG are documented here. The project follows
semantic versioning for repository-level architecture releases.

## [Assistant 2.4.43 / runtime ccea9af] — 2026-09-24 — Advertising protocol

Lifecycle `production-verified`; runtime started05:26:16UTC, source pushed.
[Release receipt](docs/reports/2026-09-24-advertising-2.4.43-deployment.md).

- Recognize unsolicited/covert advertising within the existing primary semantic
  spam classification, without requiring links, prices or bot identity.
- Keep sanctions and exceptions code-owned; reject model-selected actions.
  Preserve legitimate discussion, recommendations, reports and quotations.
- Report full enforcement only after confirmed ban and required deletions;
  preserve terminal uncertainty and prevent automatic retries.
-1512passed/5fixture skips, migration9/9,62running-image hashes, renderedfooter,
  config/schema/health/HTTPS/auth/webhooks and liveReviewIPC passed.
- Runtime-only recreation; Console3.4.0 and Review configuration unchanged.
  Zero rollbacks, paid tests or repeated historical sanctions. Lease/master
  closed. Real model recognition and native alert-delivery E2E remain not_run.

## [Assistant 2.4.42 / Console 3.4.0 / source 8a2b27f] — 2026-09-23 — Private Review

Lifecycle `production-verified`; both services deployed and source pushed.
[Release receipt](docs/reports/2026-09-23-review-8a2b27f-deployment.md).

- Activate the private suspected-promotion Review workflow: bounded live
  capture, Console-owned cases, generic private alerts and manual decisions.
  Preserve the independent primary moderation policy; no new automatic bans.
- Recognize covert book testimonials; exclude qualified negative benefits,
  withdrawn recommendations and explicitly requested recommendations with
  invisible separators. Exact grouping fingerprints stay unchanged.
- Preserve the17September private binding/store and validate actual image
  configuration before recreation; no provisioning, replay or runtime migration.
-1470passed/5explicit skips, migration9/9,58+43running-source hashes, footer,
  health/config/schema/drafts/HTTPS/auth/webhooks passed. One recreation each,
 0rollbacks; lease/master closed. Actual alert-delivery E2E and browser-rendered
  verification remain not_run, as does paid model evaluation.

## [Assistant 2.4.41 / runtime e523485] — 2026-09-19 — Safety contract alignment

Lifecycle `production-verified`; started22:06:09UTC; source integrated/pushed.
[Release receipt](docs/reports/2026-09-19-assistant-2.4.41-deployment.md).

- Request strict safety output schemas and clarify clean target/context rules;
  preserve semantic validation, sanctions, approved copy and no-retry fences.
- Reject incomplete/refused responses explicitly; retain content-free rejection
  diagnostics in the existing terminal judgement column, without schema change.
- Isolated1164passed/5skips, integrated1450passed/5skips, migration9/9,
  64deployed hashes/footer, unchanged config/schema/Console and HTTPS/webhooks
  passed. Exact historical bad field and new real-model acceptance are not proven.
- Runtime-only release; Console3.2.0 unchanged, pending Review excluded.
  One activation,0rollbacks; lease/master closed22:07:05UTC.

## [Assistant 2.4.39 / runtime 2c72e01] — 2026-09-16 — Single-judge ask protocol

Lifecycle `production-verified`; started06:57:40UTC. Source integrated and
pushed. [Release receipt](docs/reports/2026-09-16-assistant-2.4.39-deployment.md).

- Assign one durable native-revision judge: Assistant for addressed questions,
  Moderator for ordinary posts; strict verdict, generation and enforcement fences.
- Fence first/multipart/fallback answer delivery and edited revisions; preserve
  unknown-delivery and provider-usage accounting rather than replaying work.
- Expire idle bare-ask command/hint pairs after30seconds independently of the
  model; handle early/delayed-ACK/late replies and restart without deleting Q/A.
- Deliver one neutral operational fallback for invalid judgement, not an
  unjudged substantive answer; include footer2.4.39/16.09.2026.
- Add10tables/3named indexes; preserve all53old schema objects. Quarantine
  historical native messages including late edits; unknown work is not replayed.
- Root1141passed/5fixture-skips, migration9/9,22helper tests,64deployed-file
  hashes, footer, schema invariants and repeated health/config/HTTPS checks passed.
- One runtime recreation; Console3.2.0 and configuration unchanged. No old-image
  rollback permitted on the new DB; stop/preserve/forward-repair procedure tested.
  Paid/live Telegram acceptance and separate knowledge-quality/private Review
  changes are not included. Lease/master closed06:59:32UTC.

## [Assistant 2.4.38 / runtime a41518f] — 2026-09-16 — Suspected porn-spam policy

Lifecycle `production-verified`; runtime started04:32:23UTC. Console3.2.0
unchanged. [Release receipt](docs/reports/2026-09-16-porn-spam-policy-deployment.md).

- Add a versioned semantic supplement: suspected pornographic spam/profile
  solicitation maps to the existing immediate ban/cleanup route without
  requiring identical text, repetition, proof of automation or high confidence.
- Preserve legitimate reporting/education distinctions and all existing
  provider-error, Guard, action and idempotency fences. No new provider stage.
- Record the policy artifact hash; advance the shared Assistant footer to
  `Версия 2.4.38 от 16.09.2026`, leaving its answer-body behavior unchanged.
- Root946passed/5explicit fixture skips, migration9/9,58deployed-file match,
  repeated health/source/config/Console checks and HTTPS/auth passed.
  Real-model recognition and live sanctions were not tested by this release.
- One runtime recreation,0rollback; same config/schema/chats/mounts/routes.
  `/ask` repair, cross-role judging and private Review are not included.

## [Console 3.2.0] — 2026-09-15 — Last-five question costs

Lifecycle `production-verified`; exact image `f650fe8`, release23:12:03UTC.
Assistant2.4.37/runtime335a35a unchanged. See the
[release receipt](docs/reports/2026-09-15-console-v32-deployment.md).

- Show the five newest saved questions, bounded excerpts, UTC times, evidenced
  answer/analyzer/router estimates and a priced-only average with its denominator.
- Recognize event-matched completed analyzer-dispatch receipts as router no-call
  proof. Missing or conflicting evidence stays unknown, never a fabricated zero.
- Keep known-stage subtotals distinct from full estimates and unavailable totals.
- Include the 3.1.1 Russian-label fixes, tiny-positive-price formatting
  and Help explaining incomplete costs and the difference from provider invoices.
- Only Console release-time metadata changed; no runtime, pricing catalog,
  schema, other configuration, routes or data change.
- Root787passed/5explicit skips;31deployed-file hashes,7headers/API/HTTPS,
  real cost completeness/arithmetic and independent desktop Chrome passed.

## [Console 3.1.0] — 2026-09-15 — Release header and Russian Help

Lifecycle `production-verified`; image `eb0f7fe`, release22:04:32UTC.
Assistant remains2.4.37 on335a35a. See the
[release receipt](docs/reports/2026-09-15-console-v31-deployment.md).

- All seven primary tabs show the same server-rendered version/date/time;
  the timestamp is verified against actual container start, not browser time.
- Added detailed Russian Help; removed redundant introductory and routine
  banners while retaining errors, stale-draft warnings and save confirmation.
- Console-only `OPERATOR_CONSOLE_RELEASED_AT` is required in production.
  Existing auth/config/routes/mounts/drafts and runtime remain unchanged.
- Root777passed/5explicit fixture skips/0failed; Console31/31, Compose3/3,
  migration9/9,31deployed-file hashes,7page/API/HTTPS checks passed.

## [Console v3 / 82cb8c6] — 2026-09-15 — Russian operator panel

Lifecycle `production-verified`; Console-only release started21:23:28UTC;
Assistant remains2.4.37 on335a35a.
Existing auth/routes preserved, separate Console-owned draft storage added.
See the [release receipt](docs/reports/2026-09-15-console-v3-deployment.md).

- Unified six Russian pages and retained legacy variants/redirects.
- Added validated, versioned Settings and Markdown drafts with no runtime
  apply endpoint, plus recorded-question analytics with honest unknown costs.
- Fixed a pre-release async domain-selection race that could pair old text
  with a newly selected domain; added nine actual-script regressions.
- Root780/780, historical29/29, migration9/9; deployed29-file source match,
  health/auth/settings/domain/analytics checks passed. No production draft,
  Telegram message, paid call or database mutation was used for acceptance.

## [Assistant 2.4.37] — 2026-09-15 — Restored reply version footer

Lifecycle `production-verified`; runtime image `335a35a` started 21:01:48 UTC.
The public Assistant component
continues its historical `2.4.x` line, distinct from repository versions and
npm scaffold metadata. Rollback `0b54148` is retained. See the
[release receipt](docs/reports/2026-09-15-assistant-2.4.37-deployment.md).

- Restored the code-owned `Версия 2.4.37 от 15.09.2026` footer on every existing
  Assistant reply path. Multipart answers show it once, at the bottom of the
  final part, including markup fallback and emoji-heavy messages.
- Approved body text, forceReply, one-shot delivery fences and body-only model
  memory remain unchanged. Durable answer receipts and local visible dialog
  transcripts include the logical delivered footer. No new replies on silent exits.
- Added canonical component metadata and a static committed-source release
  gate: Assistant-affecting releases must increase the version versus production.
  Codex, Claude Code and deployment instructions use the same contract.
- Tests: 758/758 root, 29/29 original historical receipts, 9/9 migration safety.
  Four offline transport cases passed inside the deployed image; all 57 source
  files matched. No new paid or real Telegram acceptance was run.

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
