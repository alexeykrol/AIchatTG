# Two current porn-profile advertisements — targeted removal

Outcome: **passed — both messages deleted and both native authors permanently
banned in the affected chat**, with API acknowledgements and separate readback.
This is an owner-authorized historical action, not a source-policy deployment.

## Authority and exact scope

At approximately 11:05 UTC the owner reported a recurrence in «Модератор», then
instructed: «уже дае рекламы порно - пусть модератор удалит немедленно.»
The integrator independently read that direct message in task
`019fd023-a949-7961-87cd-693bcb893e2c`, turn
`01a0d316-e5ee-78b2-b45f-9b00cfe313df`, message
`01a0d317-c63c-7222-ada2-65f00b1098d2`. The existing owner-approved advertising
protocol requires deletion plus author ban. No paid test or new deployment
approval was inferred from this separate removal instruction.

Fresh read-only snapshots resolved exactly two current original revisions in
the configured main chat: the previously reported message **9780** and a newer
message **9799**. Both reached the model and received `clean` (0.93 and 0.84),
then `none`. Their author IDs were different. Both remained ordinary members,
not protected/exempt authors; the bot had delete and restrict permissions.
Immutable IDs, raw text and exact chat binding remain in ignored private
evidence, not in Git. No display name was used as an action target.

The root recorded the ten-minute one-shot lease
`delete-porn-9780-9799-20260924` locally and in the current release's private
server evidence directory before mutations. Limits: two deletes, two bans,
exact native authors/chat only, no retries, no model calls, source changes or
application database writes. Telegram supergroup bans revoke that author's
messages; no other author was targeted. Deletion is irreversible and no
restoration was promised.

## Results — 11:09 UTC

| Native message | Delete acknowledgement | Ban acknowledgement | Separate author readback |
| --- | --- | --- | --- |
| 9780 | 11:09:24.420, true | 11:09:24.637, true | kicked, until_date0 |
| 9799 | 11:09:25.061, true | 11:09:25.398, true | kicked, until_date0 |

The initial helper's final strict readback check for the second author did not
pass. Its original receipt remains `uncertain`; it was **not overwritten** and
no delete or ban was retried. An additional read-only getChatMember check at
11:09:58.639 verified both exact authors as `kicked / until_date0`. This
reconciles the external outcome without claiming the first helper completed
cleanly or inventing why its final check failed.

Independent native Telegram screenshots corroborated the newest solicitation
before removal and its absence afterwards; surrounding ordinary comments and
the parent post remained visible. The earlier message was outside that
viewport, so independent visual absence for 9780 is `not_run`, not inferred.

## Preservation and closure

- `passed`: exactly two delete ACKs, two ban ACKs and both permanent-ban readbacks.
- `passed`: fresh source-preserving runtime/Console checks, healthy/restarts0;
  runtime remains 2.4.43 / `ccea9af5652250c159169c986f7e531ee1ac1522`,
  Console remains3.4.0 / `8a2b27fb215a19d26cf35b6244dcd4151b7cac4d`.
  Image IDs and start times unchanged. Runtime healthHTTP200.
- `passed`: exact operation lease closed11:09:25.625891UTC; SSH master closed
  afterwards and local socket absence independently checked.
- `not_run`: paid evaluation, new release, historical replay, native visual
  absence for9780. No previous9770/9709 action was repeated.

Private artifacts are under ignored `output/delete-porn-20260924/`:

- receipt.json SHA256 `02f763994b6572410a07f23acf3011840d1466e599438ae88f12958c741050fc`
- readback.json SHA256 `fab95e3d41f2a4efcffdbe5a0c5fe3c100d970431400bc8462be3c5a8c1e266b`
- lease.json SHA256 `31720a24db48cd690b7ae1e6ef515c6cfaf6e46faf3a2fdc76a4335443bbdbd0`

The automatic-recognition repair remains candidate2.4.44/exactd8e5583,
lifecycle `prepared`. It has not been deployed and real-model acceptance
remains gated. [Separate candidate](2026-09-24-porn-profile-recurrence.md).
