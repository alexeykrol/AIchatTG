# Telegram product core

The core now owns transport-free Moderator and Assistant contracts: bot roles,
chat-scoped event identities, durable-claim keys, exact `/ask` and `/help`
recognition, and closed moderation verdict validation. It has no SQLite,
Telegram, News, HTTP or provider dependency.

The runtime owns its own persistence and adapters. Gatekeeper can adopt these
contracts later without direct table access or a shared News dependency.
