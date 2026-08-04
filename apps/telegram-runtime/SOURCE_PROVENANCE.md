# Moderator and Assistant source provenance

Implementation sources are immutable News Git objects inspected with `git
show`, never the dirty News checkout. `a729ccd` is the deployed Moderator and
Assistant behavior source. `ef1c6ea` is an accepted but non-deployed
course-operations/help overlay. They are non-linear Git histories, so the port
records them as separate source layers rather than pretending one contains the
other.

| Legacy behavior source | AIchatTG port | Boundary |
|---|---|---|
| `a729ccd:src/pro/moderation/adapters/telegram.js` | `packages/telegram-core/src/index.mjs` | Exact leading `/ask` and `/help` command recognition, forwarded/literal command rejection, chat-scoped identities and role isolation. |
| `a729ccd:src/pro/moderation/service.js`, `db.js`, `safety-policy.js` | `apps/telegram-runtime/src/database.mjs`, `src/runtime.mjs`; `packages/telegram-core/src/index.mjs` | Durable native question claims, exact-revision Moderator dispositions, fail-closed Assistant barrier and deterministic clean/weak-abuse/strong-abuse/threat action planning. |
| `ef1c6ea:src/pro/moderation/topics/registry.js`, `role-action-gate.js` | `packages/telegram-core/src/index.mjs`, `src/knowledge.mjs`; `apps/telegram-runtime/src/knowledge-adapter.mjs` | Disjoint course-content and course-operations source packages; malformed/absent route or knowledge snapshot fails closed. |
| `a729ccd:src/pro/moderation/assistant-responses.js` | `src/provider-adapter.mjs` | Explicit provider-neutral seam only. Runtime-only configuration is disabled by default and makes no provider request. |
| `a729ccd:src/services/notifier.js` | `src/notification-adapter.mjs` | Explicit adapter seam only. Default is a no-op receipt. |

Deliberately deferred: News model catalog/pricing, actual course-index content,
rate/daily limits and analytics, dashboard/operator pages, image download/Sharp
pipeline, Telegram admin lookup, legacy poller, and all News database tables.
The safe follow-up is a separately approved content import into the versioned
AIchatTG snapshot format; no direct source path or `news-digest.db` mount is
permitted.
