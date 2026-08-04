# Moderator and Assistant source provenance

Implementation source: immutable News Git object
`21c0b14d027fb52e65a3cf54d40de62012370297`, inspected with `git show` rather
than the dirty News checkout.

| Legacy behavior source | AIchatTG port | Boundary |
|---|---|---|
| `src/pro/moderation/adapters/telegram.js` | `packages/telegram-core/src/index.mjs` | Exact leading `/ask` and `/help` command recognition, forwarded/literal command rejection, chat-scoped identities and role isolation. |
| `src/pro/moderation/service.js` | `apps/telegram-runtime/src/database.mjs`, `src/runtime.mjs` | Durable per-role update claim before processing, then record a closed moderation decision or assistant turn. |
| `src/pro/moderation/assistant-responses.js` | `src/llm-adapter.mjs` | Explicit adapter seam only. Default is disabled and makes no provider request. |
| `src/services/notifier.js` | `src/notification-adapter.mjs` | Explicit adapter seam only. Default is a no-op receipt. |

Deliberately deferred: News model catalog/pricing, course-index files, Digest
configuration, dashboard/operator pages, image download/Sharp pipeline, legacy
poller, and all News database tables. The safe follow-up is a reviewed,
versioned AIchatTG knowledge snapshot adapter; no direct source path or
`news-digest.db` mount is permitted.
