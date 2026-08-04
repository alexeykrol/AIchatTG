# Moderator and Assistant source provenance

Implementation sources are immutable News Git objects inspected with `git
show`, never the dirty News checkout. `a729ccd` is the deployed Moderator and
Assistant behavior source. `ef1c6ea` is an accepted but non-deployed
course-operations/help overlay. They are non-linear Git histories, so the port
records them as separate source layers rather than pretending one contains the
other.

| Legacy behavior source | AIchatTG port | Boundary |
|---|---|---|
| `a729ccd:src/pro/moderation/adapters/telegram.js` | `packages/telegram-core/src/index.mjs`; `apps/telegram-runtime/src/runtime.mjs`, `guard-adapter.mjs`, `database.mjs` | Exact leading `/ask` and `/help` command recognition, forwarded/literal command rejection, chat-scoped identities and role isolation; Moderator-only automatic-channel-pin cleanup through the Guard token with pin-right preflight, native idempotency and manual-pin memory. |
| `a729ccd:src/pro/moderation/service.js`, `db.js`, `safety-router.js`, `safety-policy.js`, `prompts/moderation-tg-v3.md`, `prompts/abuse-classifier-tg-v1.md`, `policies/*-library-v1.md` | `apps/telegram-runtime/src/database.mjs`, `src/runtime.mjs`, `src/provider-adapter.mjs`, `src/safety-v3.mjs`, `src/safety-artifacts/**`; `packages/telegram-core/src/index.mjs` | Durable native question claims, exact-revision Moderator dispositions, two-stage closed semantic safety contract, fail-closed Assistant barrier and deterministic clean/weak-abuse/strong-abuse/threat action planning. A `ban_purge` removes only the triggering plus bounded locally known undeleted messages for that exact chat/user; unknown delivery outcomes stay fenced. |
| `ef1c6ea:src/pro/moderation/topics/registry.js`, `role-action-gate.js` | `packages/telegram-core/src/index.mjs`, `src/knowledge.mjs`; `apps/telegram-runtime/src/knowledge-adapter.mjs` | Disjoint course-content and course-operations source packages; malformed/absent route or knowledge snapshot fails closed. |
| `a729ccd:src/pro/moderation/assistant-responses.js` | `src/provider-adapter.mjs` | Explicit provider-neutral seam only. Runtime-only configuration is disabled by default and makes no provider request. |
| `a729ccd:src/services/notifier.js` | `src/notification-adapter.mjs` | Explicit adapter seam only. Default is a no-op receipt. |

Deliberately deferred: News model catalog/pricing, actual course-index content,
rate/daily limits and analytics, dashboard/operator pages, image download/Sharp
pipeline, Telegram admin lookup, legacy poller, and all News database tables.
The safe follow-up is a separately approved content import into the versioned
AIchatTG snapshot format; no direct source path or `news-digest.db` mount is
permitted.

## Moderator safety-v3 artifact receipt

The following four files were copied byte-for-byte from
`a729ccd:news-digest-pipeline/src/pro/moderation/` into
`apps/telegram-runtime/src/safety-artifacts/`. Their SHA-256 values are both
source and target identities; they are not runtime configuration.

| Legacy source | SHA-256 |
|---|---|
| `prompts/moderation-tg-v3.md` | `c7c0b1eb76d5c665f4f36d2ad15d15332fefcc0f4358ac51178a66f8b0a76123` |
| `prompts/abuse-classifier-tg-v1.md` | `e869e38a1a5aa6f7bd887f15e74c75c46a59b852a8d4efc5d4f1473d32b744a7` |
| `policies/threat-library-v1.md` | `31903ca34cac0cfccbe310599c8617ae06af9dd76195c5dc5170d0917451db7a` |
| `policies/abuse-library-v1.md` | `24f16fc846f13c45fee97d69d092e5f71cce2517b00c9c86d7d50199a3285389` |

The model route is code-owned: OpenAI `gpt-5.6-terra`, `medium` reasoning,
1024 router output tokens, and 768 abuse-classifier output tokens. It remains
disabled until a separate provider configuration and production cutover lease.
