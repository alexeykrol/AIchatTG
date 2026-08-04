# Telegram product core

The core now owns transport-free Moderator and Assistant contracts: bot roles,
chat-scoped event identities, durable-claim keys, exact `/ask` and `/help`
recognition, closed safety action planning, exact-revision Assistant
dispositions, course-content versus course-operations routing, and a
SHA-256-verified local knowledge-manifest contract. It has no SQLite, Telegram,
News, HTTP or provider dependency.

The runtime owns its own persistence and adapters. Gatekeeper can adopt these
contracts later without direct table access or a shared News dependency.
