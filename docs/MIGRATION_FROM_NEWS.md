# Migration from News Digest

## Starting point

The legacy source was `News/news-digest-pipeline`. AIchatTG now owns the
Telegram product, while News is being cleaned back to digest, publishing and
Facebook Page moderation responsibilities.

## Ownership map

| Legacy area | Destination | Migration rule |
|---|---|---|
| `src/services/publishers/telegram.js` | News Digest | Remains: this publishes editorial content to a channel. |
| `src/pro/moderation/**` | `apps/telegram-runtime` and `packages/telegram-core` | Extract moderator and assistant together after dependency seams are mapped. |
| `telegram-gatekeeper/**` | `apps/gatekeeper` | First port; preserve the exact accepted source baseline and its isolated data root. |
| `src/services/llm.js`, model catalogue, config and auth | AIchatTG adapters/core | Recreate minimal Telegram-owned interfaces; do not import News application code. |
| `news-digest.db` moderation records | AIchatTG database | Migrate only through a separately approved, versioned one-way plan. No direct mounting or dual writing. |

## Completed extraction

1. Repository, product boundaries and source provenance are established.
2. Gatekeeper is ported under `apps/gatekeeper` with isolated persistence; its
   onboarding scenario remains draft until Product Owner content is complete.
3. Moderator and Assistant share AIchatTG core contracts and run under
   `apps/telegram-runtime` with separate bot identities.
4. The operator console is served by AIchatTG and no longer depends on News
   routes, cookies or database files.
5. AIchatTG is the production owner of Telegram AI. Removal of the duplicate
   legacy source from the News repositories is a separate coordinated cleanup;
   editorial Telegram publication and URL intake remain in News.

## Remaining independent stages

- Build and accept a new course index/knowledge snapshot; the old News course
  artifact is not reused.
- Import selected historical state only through the normalized one-way importer
  if the Product Owner later needs it.
- Activate Gatekeeper only after its scenario and external integrations pass
  their own release gates.

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
