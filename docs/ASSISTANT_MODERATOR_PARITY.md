# Assistant and Moderator parity candidate

## Provenance

The current AIchatTG main line descends from the original extraction candidate.
Its imported behavior is grounded in two immutable, read-only News objects:

| Source layer | Role in this port | Relationship |
|---|---|---|
| `a729ccd` | Deployed Moderator, Assistant command and safety disposition behavior | Production source of truth |
| `ef1c6ea` | Accepted course-operations/help routing behavior | Ported policy/route layer; course content remains disabled until a new snapshot is admitted |

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
- A fenced inbound-delivery receipt names the exact role/update/revision and
  prevents auto-replay after an ambiguous Telegram delivery.
- Assistant rate reservations are chat/user scoped. Cooldown and daily caps are
  checked before any optional provider or Telegram delivery. Deterministic local
  route/knowledge rejections release their reservation; provider transport and
  Telegram delivery uncertainty are retained rather than blindly retried.
- Dialogue turns are scoped to chat/user, bounded by a configurable TTL and
  turn cap, and are persisted only after a successful final Telegram receipt.
- `/ask` and `/help` retain their leading-command contract. Public identity and
  usage questions use a code-owned profile; internal implementation details are
  not disclosed and do not call a provider.
- Course routes remain disabled by default. Knowledge is a local manifest plus
  SHA-256-verified snapshot, but no course content or index is in this repo and
  no News path can be read.

## Deliberate gaps

This is not a full historical-state or course-content equivalence claim.
Deferred work includes the new approved-content snapshot, image handling and
optional historical-state migration.
The read-only operator console is separate from this runtime and does not
receive message or dialogue text. Those decisions need the permanent integrator
and, where relevant, a Product Owner approval and exact release lease.
