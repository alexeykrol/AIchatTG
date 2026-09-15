# Assistant purpose and menu-message hygiene — 2026-09-15 UTC

Lifecycle: `prepared`. Production baseline: runtime `049cc22`.

This is a follow-up to the [instruction reconciliation](2026-09-14-owner-instruction-reconciliation.md),
not a replacement for its historical checkpoint. The Product Owner supplied
two new live counterexamples after that deployment. They invalidate broad
claims that the profile and chat hygiene were already complete.

## Recovered requirement and implementation history

| Requirement | Historical source | What actually shipped | Correction |
|---|---|---|---|
| Describe a course navigator, not internal infrastructure restrictions | News `89c0c032e2481e1c0deb4d3a363f902a04a5572b` introduced the public profile; `dc117b02735432a8c951ba9989e472b4c8923879` introduced v2 and «ИИ Навигатор». Accepted source `a729ccd5138288b7c921e0a677b5b9e9281e7399`, `news-digest-pipeline/src/pro/moderation/prompts/assistant-profile-v2.md:5–17` and `assistant.js:423–429`. | AIchatTG `bd25cc63e69b07613aeb589dc89005145b44009b` added a technical fallback while knowledge was disabled. `2c02c5602455d72820e999f4b88b0089b728efdc` moved that fallback before retrieval; it did not restore the navigator purpose. `049cc22` deployed it. | Restore course purpose, lesson/link navigation, sequence, explanation and course-related AI/automation help. Keep specific internal-detail boundaries separate from ordinary capability questions. |
| Delete both the bare menu command and its temporary hint after the substantive answer | Owner Feedback Log, 2026-09-14 “Chat hygiene”; the new screenshot shows `/ask@alexkrol_moderation_bot` still visible. | `2c02c56` and `049cc22` deleted only the hint, using its text as the match. User-command cleanup was explicitly `partial`, but later summaries overgeneralized “chat hygiene”. | Persist exact same-chat/same-user command and hint IDs, then delete only that proven pair after complete answer delivery. Preserve actual questions and answers. |
| Evaluate whether answers are useful, not merely whether a reply arrived | Product Owner explicitly requested 20–30, at most 50, paid questions in the closed test chat. | Previous deterministic smoke accepted the technical profile; transport success did not assess course relevance. | Freeze questions and source-backed expectations before the live run; retain exact message/event receipts, actual answers and provider token usage. Review content separately from delivery. |

The historical profile defines a navigator for «Создание ИИ Агентов».
Its useful public capability list is restored, but obsolete invocation rules
and unverified image-understanding claims are not copied forward. Current
invocation is reply, `/ask`, or mention. Exact prior live wording for the
question «Что ты можешь?» was not recovered; the checked-in profile/help is
the verified source, not a reconstructed conversation.

## Cleanup contract

1. A literal empty `/ask` or `/ask@this_bot` creates a forced-reply hint.
   Its completed inbound receipt records command ID, hint ID, chat and user;
   no new schema or message-text storage is introduced.
2. A substantive reply to that exact hint from the same user is answered.
3. Only a completely delivered answer may trigger cleanup. The assistant
   deletes its own hint; the existing Moderator Guard checks its configured
   chat and live delete rights before deleting the bare user command.
4. The cleanup claim is persisted before either deletion. Unknown outcomes
   are fenced, not retried. Failure to clean up never cancels the answer.
5. Real questions, previous answers, other users/chats, observed edits of the
   command and legacy/unmapped hints are not cleanup targets. Lookup is
   bounded to the latest 2,048 inbound events/receipts and 47 hours. An edit
   receipt is retained even when the edited text no longer invokes the bot.
   The final synchronous no-edit check runs after Guard's live-rights lookup,
   immediately before deletion. Missing or aged-out provenance fails closed.

This is forward-only service-message cleanup, not a bulk deletion of existing
chat history. Missing rights or a crash can leave service clutter; the safe
outcome is to retain it and record the reason, never guess what to delete.

Read-only rights checks on 2026-09-15 found the Assistant able to delete in
the closed test chat but not in the other two configured groups. The Moderator
already has delete rights in all three. The candidate uses that existing Guard
authority; no permissions, bot tokens or webhook settings are changed.

## Acceptance and evidence

- `passed`: exact Git-source recovery and comparison with `049cc22`.
- `passed`: read-only identity, closed-chat and existing bot-rights checks.
- `passed`: independent review caught three edit/delivery races; each now has
  a regression test. Cleanup suite covers 34 cases, including edits during
  hint delivery, hint deletion and Guard's rights lookup.
- `passed`: independent re-review reproduced all three races after repair;
  edited substantive messages survive. Full project suite: 605/605 under
  Node 20.20.0 with the real local course package/value slice supplied (no
  skips); closed-chat runner safety suite: 17/17. Scenario check: 30 machine
  messages and 34 human entries. These tests make no paid calls.
- `not_run`: new candidate deployment and post-deployment cleanup proof.
- Local regression and live-answer results are recorded separately; no local
  pass is deployment evidence and no delivered answer is automatically a
  content-quality pass.

The live plan is [30 predeclared cases](2026-09-15-assistant-acceptance-plan.json).
Only the closed chat `Чат1_Ментор_Test` is in scope. Synthetic traffic does
not prove ordinary-human ingress or moderation behavior. One synthetic sender
shares one dialogue; any follow-up is judged in its actual sequence.

## Why the issue recurred

The first fix repaired dispatch but retained the wrong public text. The second
requirement was divided into hint cleanup and command cleanup, then summarized
as if both were finished. Tests asserted the old implementation's behavior,
not the complete user-visible outcome. The regression contract now checks the
content of capability answers and the exact surviving/deleted message set.

The available history was recovered from Git, prior reports, accepted News
source and local transcripts. Already missing transcripts cannot be restored;
this report does not claim that every historical conversation was found.
