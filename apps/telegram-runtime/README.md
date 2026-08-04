# Telegram runtime — extraction seam

This app will host the Moderator and Assistant adapters. It is deliberately
empty until the minimal AIchatTG configuration, database, webhook and LLM
adapters are implemented.

It must not import `News/news-digest-pipeline/src/pro/index.js`: that bootstrap
also starts digest, publishing, Facebook and other legacy responsibilities.
The first standalone bootstrap will initialize only AIchatTG-owned SQLite state,
Telegram Moderator/Assistant adapters, operator APIs and their dedicated
webhook routes. Registration and polling must be disabled by default.

See [the extraction map](../../docs/MODERATOR_ASSISTANT_EXTRACTION.md).
