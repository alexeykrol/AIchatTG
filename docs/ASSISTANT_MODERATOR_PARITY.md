# Assistant and Moderator parity candidate

## Provenance

This candidate is based on `AIchatTG@003ba927ce41a1869935d5b6a421af43e075800a`.
Its behavior comes from two immutable, read-only News objects:

| Source layer | Role in this port | Relationship |
|---|---|---|
| `a729ccd` | Deployed Moderator, Assistant command and safety disposition behavior | Production source of truth |
| `ef1c6ea` | Accepted course-operations/help routing behavior | Separate accepted overlay; neither object is an ancestor of the other |

No News file, runtime import, path, database, configuration value or secret is
used by AIchatTG.

## Implemented boundaries

- Moderator receives a closed `clean`, `abuse` or `threat` classification and
  applies the code-owned safety plan. Provider output cannot select a Telegram
  action or Assistant access result.
- The Moderator writes `pending`, then a terminal `allowed`, `blocked` or
  `error` disposition keyed by chat, native message and exact edit revision.
  Assistant waits only for that exact revision and fails closed otherwise.
- Native Assistant-question claims prevent a redelivery or approved edit from
  producing a second answer after a source message was already handled.
- The Assistant role route is closed: content teaching/navigation can use only
  `course-content-v1`; course operations support can use only
  `course-operations-v1`; redirect has no source package.
- Knowledge is a local manifest plus SHA-256-verified snapshot. The repo ships
  no course content and the loader rejects paths outside its explicit root.

## Deliberate gaps

This is not a deployment or full production-equivalence claim. Deferred work
includes the approved-content import, provider-specific prompts/models/pricing,
Telegram admin lookup and exemptions, image handling, rate limits/analytics,
operator UI, migration of historical data and all webhook/token/cutover work.
Those decisions need the permanent integrator and, where relevant, a Product
Owner approval and exact release lease.
