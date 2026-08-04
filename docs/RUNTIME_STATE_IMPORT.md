# AIchatTG runtime state importer

This is the only candidate-side route for importing historical Telegram state.
It reads one already-approved normalized JSONL bundle and writes only the
AIchatTG Telegram-runtime SQLite database. It never accepts a News path,
opens a News SQLite file, calls Telegram or a provider, changes a webhook, or
reads environment secrets.

The envelope is admitted first by
[`verify-migration-bundle.mjs`](../scripts/aichattg/verify-migration-bundle.mjs).
The importer then requires all of the following before a target write:

- an explicit `--apply` (the default is a non-writing dry run);
- `--expected-candidate-sha` exactly matching both the bundle authorization and
  the current AIchatTG Git `HEAD`;
- a regular, non-symlink target file under an existing real directory, never a
  path that names a News runtime or `news-digest.db`;
- a fully verified manifest and payload digest/count; and
- records that conform exactly to the state-only allowlist below.

The authorization identifiers are recorded as references; the script cannot
prove an external controller lease or Product Owner approval. A production
import still needs the accepted candidate, an explicit Product Owner approval,
and the controller's one-time lease. This candidate does not authorize one.

## Record allowlist

Every JSONL line is one object with exactly the listed keys. Unknown keys,
empty lines, duplicate record identities, non-finite values, and a record
larger than 64 KiB are rejected without echoing the record.

| `type` | Allowed state | Target tables | Privacy boundary |
| --- | --- | --- | --- |
| `moderation.v1` | Moderator event identity, numeric Telegram IDs, terminal verdict, confidence, reason code, safe action code and timestamp | `runtime_inbound_events`, `runtime_moderation_records`, `runtime_assistant_moderation_dispositions` | No message text, quote, username, name, provider result or action receipt. A `clean` verdict creates only an `allowed` disposition; `suspect`/`ban` create `blocked`. |
| `assistant_question_claim.v1` | Completed `answered` or `skipped` claim and timestamps | `runtime_assistant_question_claims` | No question, answer, dialogue, model identifier, delivery receipt or route. |
| `weak_strike.v1` | Exact numeric counter for a chat/user pair and timestamp | `runtime_moderation_weak_strikes` | No text or profile data. |

The importer intentionally does **not** import `runtime_assistant_dialogues` or
`runtime_assistant_turns`: those require historical question/answer content,
which is outside this state-import approval and would change Assistant context.

`moderation.v1` requires an event ID exactly equal to `moderator:<updateId>`
and a `platformMessageId` equal to either `<chatId>:<messageId>` or the exact
edited revision `<chatId>:edit:<updateId>:<messageId>`. Reason values are
machine-readable codes (`[a-z][a-z0-9_]{0,63}`), not free-form text. Actions
are limited to `none`, `delete_warn_1`, `delete_warn_2`, or `ban_purge` and
must agree with the terminal verdict.

## Candidate procedure

Run these commands only from a clean, accepted AIchatTG Git worktree and only
against the newly leased AIchatTG data root. The example path is illustrative;
do not substitute a News path or a production path outside a lease.

```bash
candidate_sha=$(git rev-parse HEAD)

node scripts/aichattg/import-runtime-state.mjs \
  --manifest /approved-private-directory/bundle-manifest.json \
  --database /approved-aichattg-data/telegram-runtime.db \
  --expected-candidate-sha "$candidate_sha" \
  --dry-run

node scripts/aichattg/import-runtime-state.mjs \
  --manifest /approved-private-directory/bundle-manifest.json \
  --database /approved-aichattg-data/telegram-runtime.db \
  --expected-candidate-sha "$candidate_sha" \
  --apply
```

Dry run never creates a missing SQLite file. On an existing database it checks
the runtime schema and every duplicate before reporting row counts. It prints
only bundle/source/candidate digests, record-type totals, row-change totals and
state; it never prints Telegram IDs or record values.

`--apply` processes all records and writes one `runtime_migration_receipts`
audit row in the same SQLite transaction. The receipt contains only bundle,
source, candidate and approval references, payload SHA-256, count and
per-record-type totals—no personal content or Telegram IDs.

## Duplicate, stop, and rollback policy

- A repeated record identity inside one payload is rejected before the target
  database is opened for writing.
- An existing target row with the exact same allowed state is a no-op. A
  conflicting row stops the entire transaction; no bundle records or receipt
  are committed.
- A committed identical bundle ID is `already_applied`; the same bundle ID
  with different receipt inputs, or an already-receipted payload digest under a
  different ID, is rejected.
- A post-import rollback is **not** automatic. Preserve the new AIchatTG data
  root and audit receipt, stop only a leased AIchatTG ingress/webhook if
  necessary, and ask the controller whether a compensating transaction is
  safe. Do not restore or alter News data.
