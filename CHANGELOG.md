# Changelog

All notable changes to AIchatTG are documented here. The project follows
semantic versioning for repository-level architecture releases.

## Production configuration — 2026-09-14 — Assistant enabled in the third chat

Configuration-only change; image unchanged (`5e67451`). The third chat
(«КвестТКР_Чат») was added to `TELEGRAM_RUNTIME_ASSISTANT_CHAT_IDS` in the
release's `runtime.env`, and only the `aichattg-telegram-runtime` container was
recreated. The previous file is kept next to it as `runtime.env.pre-20260914`
(rollback = restore and recreate). The assistant now answers in 3 chats; the
moderator covers the same 3 chats. Webhook `pending=0`, no errors. Procedure:
[docs/VPS_CUTOVER_RUNBOOK.md](docs/VPS_CUTOVER_RUNBOOK.md), "Configuration-only
change (same image)".

## Unreleased (main only) — not deployed

Everything after `5e67451` is in `main` and is **not** on the production image.
All of it lives in scripts, tests and local paths, not on the live answer path.

### Added

- **Wave 1 + 2** (`f162456`, merged 2026-09-06): dialogue context snapshot,
  a working-state module (default off), and a managed local dialogue with the
  assistant.
- **Wave 3** (`07e69d3`, merged 2026-09-06): two local assistant instances and a
  recorded conversation between them; the fixture's expectation is taken from
  the closed list of judges (`f096db0`).
- `scripts/aichattg/docker-logs-safe.sh` (`a112179`, 2026-09-14): a bounded
  wrapper for `docker logs` on the shared VPS (line, time and deadline limits),
  plus the diagnostic rule in `AGENTS.md` and the runbook.

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
