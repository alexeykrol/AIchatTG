# Changelog

All notable changes to AIchatTG are documented here. The project follows
semantic versioning for repository-level architecture releases.

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
