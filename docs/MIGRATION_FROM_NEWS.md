# Migration from News Digest

## Starting point

The legacy source is `News/news-digest-pipeline`. It currently contains both
publishing and Telegram product code. The migration creates a new clean home
for the Telegram product; it does not alter the production News runtime during
the initial phases.

## Ownership map

| Legacy area | Destination | Migration rule |
|---|---|---|
| `src/services/publishers/telegram.js` | News Digest | Remains: this publishes editorial content to a channel. |
| `src/pro/moderation/**` | `apps/telegram-runtime` and `packages/telegram-core` | Extract moderator and assistant together after dependency seams are mapped. |
| `telegram-gatekeeper/**` | `apps/gatekeeper` | First port; preserve the exact accepted source baseline and its isolated data root. |
| `src/services/llm.js`, model catalogue, config and auth | AIchatTG adapters/core | Recreate minimal Telegram-owned interfaces; do not import News application code. |
| `news-digest.db` moderation records | AIchatTG database | Migrate only through a separately approved, versioned one-way plan. No direct mounting or dual writing. |

## Phases

1. **Foundation** — establish this repository, the boundaries, migration
   charter, and source provenance. No production change.
2. **Gatekeeper port** — copy the exact accepted Gatekeeper subtree into
   `apps/gatekeeper`, preserve its standalone tests and data-root isolation,
   then verify it independently.
3. **Telegram core extraction** — map and extract shared contracts required by
   Moderator and Assistant: event claims, identity/access state, policy,
   delivery receipts, LLM adapter, and configuration.
4. **Moderator + Assistant port** — move both adapters to
   `apps/telegram-runtime` against the new core. Do not duplicate their state
   machine in both repositories.
5. **Cutover plan** — separately approve data migration, webhook routes,
   secret injection, Traefik routing, one service deployment, smoke limits and
   rollback. Only after a verified cutover can legacy Telegram AI code be
   retired from News.

Historical state has a candidate-only, state-only importer described in
[Runtime state importer](RUNTIME_STATE_IMPORT.md). It accepts a separately
approved normalized bundle, not a News SQLite file, and deliberately excludes
historical Assistant question/answer content.

## Release rules during migration

- Each source baseline is identified by immutable commit SHA and manifest.
- The two applications have separate database files and configuration roots.
- There is no dual-write period. If temporary read-only import is needed, it
  must be explicitly designed and approved.
- A local port or test result never authorises a production webhook switch.
