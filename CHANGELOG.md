# Changelog

All notable changes to AIchatTG are documented here. The project follows
semantic versioning for repository-level architecture releases.

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

### Known

- Telegram markup is not rendered: the runtime sends no `parse_mode`, so
  `**bold**` and `###` reach readers literally. Fix pending an owner decision.

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
