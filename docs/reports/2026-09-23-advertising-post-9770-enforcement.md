# Advertising post9770 — deletion and author ban completed

Status: `passed` for the requested one-off production moderation action.
This is not a source deployment. Production source remains
`8a2b27fb215a19d26cf35b6244dcd4151b7cac4d`, Assistant2.4.42/Console3.4.0.

## Exact authority and target

After the identified post and its incomplete removal were reported, the owner
said «ничего не удалено», then explicitly required the complete advertising
protocol: delete the post and ban its author. This superseded the earlier
no-ban restriction. Root did not ask for another URL or confirmation password.

The fresh operation targeted only native message9770 in the reported configured
supergroup and its immutable native author ID. The current judgement head was
revision0, source time14:08:08UTC; the normalized content digest still matched
the exact native-screen/server identification. Private text, author identifiers
and credentials are not committed. A display name or `is_bot` flag was not used
as the identity or permission to ban.

Preflight verified the current exact8a runtime image, healthy/restart0,
configured chat identity, bot delete/restrict permissions and author status.
The author was neither an administrator/creator, self, exempt bot nor a
`sender_chat` synthetic user. Independent static helper review passed.

## Confirmed effects23SeptemberUTC

- `passed`: exactly one `deleteMessage` for9770, acknowledged23:09:43.907.
- `passed`: exactly one `banChatMember` for that native author in the same
  chat, acknowledged23:09:44.123.
- `passed`: read-only `getChatMember` at23:09:44.209 returned the same author
  with status`kicked`, until_date0: indefinite ban.
- `passed`: independent native Telegram screenshot showed the advertising
  bubble absent while the existing parent publication/comment remained visible.
- `passed`: separate operation lease`delete-9770-20260923` closed
 23:09:44.232UTC; SSH master/socket closed23:10:28UTC.
- `passed`: both8a containers remained healthy/restart0, unchanged images.
  Review stayed live; its counters still showed0cases/0capture attempts since
  boot. No history replay was used to synthesize a Review case.

The operation used a fresh15-minute lease, exclusive fsynced local and server
calling fences, bounded calls and no automatic retry. No paid/model call,
runtime database write, redeploy, other chat or other author was targeted.
The earlier9709 deletion was not called again.

Telegram supergroup bans inherently revoke that author's messages, so the
effect cannot honestly be limited to only one message by that author. No manual
history scan or bulk-deletion loop was used, and no count of additional messages
removed by Telegram is claimed. Deletion is irreversible; a future unban would
be a separate permission change and would not restore deleted posts.
[Official Telegram contract](https://core.telegram.org/bots/api#banchatmember).

## Evidence

Ignored local`output/delete-9770-20260923/receipt.json` contains separate delete
and ban acknowledgements plus final author-status readback; SHA256
`c153bb4b7e559e95a78345258e963b4ce393562407b0a77d13734070a44729d8`.
The independently issued local lease SHA256 is
`5b58595be2f4e7b2f12b7106a08c03152c09b50bc0f548f4c59f399057e1bea1`.
Private raw receipts and local transcripts are ignored, never Git artifacts.

## Permanent source correction remains distinct

The owner-required advertising protocol is now explicit in`AGENTS.md`. The
primary classifier already mapped `spam_or_scam` to `ban_purge`; the reported
message instead received a clean semantic verdict. Covert testimonial cues
were specialized in Review, not in the primary semantic policy. A new primary
advertising supplement and regressions have been implemented locally. It only
changes recognition instructions: the model supplies a classification and
validated evidence; deterministic code still owns the full sanction protocol.

An additional local receipt defect was found: a definite skipped ban followed
by successful deletion could be labelled completed. The source candidate now
requires confirmed ban and purge before recording full completion, preserving
uncertain outcomes and no-retry fences. Three regressions failed before that
correction; all eight new enforcement scenarios pass. This did not cause9770's
clean verdict. Full local suite:1512 passed/5 fixture skips/0 failures.

No future-message recognition guarantee or new deployed-policy claim follows
from this successful one-off enforcement. Real-model recognition remains
`not_run` under the current no-paid-test scope.
