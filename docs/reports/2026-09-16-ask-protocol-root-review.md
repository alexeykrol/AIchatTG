# Ask protocol — root verification and prepared candidate

Checkpoint: 2026-09-16 05:43:53UTC. Lifecycle: **prepared**.

## Exact state

- Candidate commit: `2c72e01cb28452c640c033c91a2060a8eca57201`.
- Isolated branch: `codex/assistant-reply-moderation`, worktree
  `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`; clean after root commit.
- Assistant metadata: **2.4.39**, planned release date **2026-09-16**.
- Root main has not integrated this source. Candidate is not pushed, approved
  for production or deployed. Shared source reservation is frozen/completed;
  no delegated writer or production lease is active for this candidate.
- Last production verification remains runtimea41518f/Assistant2.4.38 and
  Consolef650fe8/3.2.0. No new SSH/live check was performed in this review.

## Verified local outcome

One durable native-revision judge owner precedes either provider stream;
strict opaque semantic submission and atomic code-derived enforcement prevent
duplicate or stale decisions. New answer generation/first-send fences preserve
one visible sequence. Idle bare-/ask command/hint pairs expire after30seconds;
early/late replies, delayed acknowledgements, restart and concurrent cleanup
retain substantive questions/answers. An invalid judgement gets one neutral
operational fallback, not an unjudged answer or invented abuse sanction.

Root checked the exact36-file worker manifest:
`5e2e2fa12e33659c9d695be590b6a7b12ebf696f6ea1801ca0a271521bbbf887`.
All paths matched the charter and runner addendum. Root then changed only the
public release JSON and the two explicit release-version expectations in
`test/telegram-adapter.test.mjs`. Assertions were not removed or weakened.
The candidate commit contains38 app files and two dated worker documents.
The worker report in that commit is intentionally the pre-bump frozen snapshot,
not a false claim that the worker committed or changed metadata.

## Evidence

- `passed`: root full suite before bump and after the complete metadata/test
  bump: **1146 total,1141passed,0failed,5 unchanged fixture skips**.
- The intermediate metadata-only run failed the old2.4.38 explicit assertion;
  after updating its expected2.4.39 value the whole suite was rerun successfully.
- `passed`: root migration/import9/9, scenario30machine/34human, infrastructure
  isolation, whitespace and clean exact-source guard againsta41518f.
- `passed`: independent repaired pure contract81/81; timer68/68 plus4 extra
  interleavings (subsequently promoted); native answer fencing55/55 plus5 extra
  probes; conservative exact-old forward transition10/10. These are separate
  overlapping review runs, not additive totals for the repository suite.
- `failed`: unrestricted old-a41518f binary downgrade safety. Root reproduced
  the exact-old runtime AND core rejudging a previously accepted new-native
  event. Its expected regression-test success is not rollback success.
- `not_run`: tested production rollback mitigation, live Telegram/Guard or paid
  semantic evaluation, current remote health/source refresh, deployed footer,
  push, production migrations and deployment.

Five fixture skips concern four admitted knowledge/value local-runner cases
and the unavailable external real value slice, unchanged from earlier gates.
No historic routing gold, provider/model tuple, sanction policy, dependencies,
Console, knowledge source or infrastructure configuration was changed.

## Open release decisions

1. Forward transition deliberately quarantines late deliveries **and edits of
   old native messages**. New native messages are unaffected. Existing single
   proven-safe legacy work may finish; conflicting/unknown work is not guessed.
   This does not claim that old edited messages remain actively moderated.
   Accept the limitation explicitly or design/review another transition.
2. A safe tested rollback/stop/drain/quarantine plan is required. The current
   a41518f image cannot be automatically restarted on the new-protocol database.
   No blind DB restore or implicit downtime acceptance is authorized.
3. New fallback copy remains a candidate: «Сейчас не удалось обработать вопрос.
   Попробуйте, пожалуйста, позже.» The30-second hint sentence is an explicit
   PO instruction relayed by the Assistant task, not invented release copy.

The safe default is to retain current production and the clean local candidate.
These stops do not authorize a new deployment, paid test, old-message replay,
provider retry, changed webhook or separate private Review activation.

See [legacy transition proposal](../proposals/2026-09-16-ask-protocol-legacy-transition-v5.md),
[dated reviews](2026-09-16-ask-protocol-interim-review.md) and
[release queue](../RELEASE_QUEUE.md).
