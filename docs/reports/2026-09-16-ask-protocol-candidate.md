# Ask protocol candidate — frozen local evidence

Verification checkpoint: **2026-09-16 05:39 UTC**. Lifecycle: **prepared**.
This is an uncommitted delegated candidate, not a deployed release.

## Identity and ownership

- Worktree: `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`.
- Branch: `codex/assistant-reply-moderation`.
- Clean base/unchanged HEAD: `b1c19c551bfa2ac76badbe427710b5d9feb47f86`.
- Historical production baseline used for offline transition tests:
  `a41518f4a4fd105cf19e7fc1a64fd35b77233084`; ancestry check passed.
  Current live production was **not_run** by this worker.
- Root task `019fd019-af89-7b50-a16d-8c7928753f24` owns acceptance, commit,
  public version/date bump, push and production. This worker made none of those.
- Parent charter and timing v2, local-runner extension v3, answer-claim v4,
  and root's fail-closed legacy-transition design acceptance govern this diff.
- All 36 modified/new `apps/telegram-runtime/` source, script and test paths
  are frozen. Only this report and the named design document accompany them.
  No domain knowledge, historical gold, release JSON, dependency, infrastructure,
  other bot/project or secret files were changed.

## Outcome and regression matrix

| Scenario | Implemented evidence | Status |
| --- | --- | --- |
| Either webhook order, concurrency, missing stream, duplicate/restart | One native-revision owner/job; raw unstripped safety input | passed |
| Invalid/unknown safety result, including reported question | One fixed operational fallback, footer, no substantive answer, strike or dialogue memory | passed |
| Conflicting source/actor/policy, forged or revoked claim | Strict trace, literal evidence, confidence and opaque generation checks; fail closed | passed |
| JSON key order, repeated callback, private usage fields | Canonical fingerprint; idempotency; bounded metadata-only receipts | passed |
| Edited or ignored newer revision during safety/Guard/send | Head tombstone; exact policy/revision fence after rights and before every part/fallback | passed |
| Bare ask with no question | 30-second idle deadline from confirmed hint ACK; exact service pair only | passed |
| Bound question before deadline; slow model | Durable question_received cancels idle expiry before judging | passed |
| Late question after deletion/uncertain deletion/restart | Still routable; no repeated service deletes; substantive Q/A preserved | passed |
| Delayed hint ACK; question/answer wins before ACK | Durable reply/completion observations reconcile on job creation/recovery | passed |
| Expiry-first and answer-first concurrent cleanup | One persisted claim, exactly two service targets, no Q/A deletion | passed |
| Edited command, edit during rights, missing rights, 47-hour authority, queue volume | Indexed monotonic edit evidence; bounded skip/claim; no unsafe retry | passed |
| Original answer still unsent; newer allowed edit | Replacement generation; only current answer sent; original paid attempt retained | passed |
| Calling/partial/unknown/confirmed native answer; later edit | No second sequence; old completion cannot change newer state; quotas unchanged | passed |
| Legacy accepted/pending/calling/unknown/expired/conflicting jobs | Identifier-only forward quarantine, both recovery orders, indexed admission, real DB reopen | passed |
| Unrelated new native messages after upgrade | Normal strict judgement/answer unaffected | passed |
| Uncontrolled exact-old binary downgrade | Old runtime rejudges accepted native message; counterexample confirmed | failed |

Durable cases live in `ask-cleanup.test.mjs` (45), `ask-store.test.mjs` (19),
`assistant-ask-expiry.test.mjs` (8), `answer-claims.test.mjs` (13),
`single-judge-runtime.test.mjs` (14), the judgement/Guard/Telegram fence tests,
and `judgement-rollback.test.mjs` (8 exact-source transition scenarios).
The four independent timer probes were promoted into permanent tests.

The original missing answer was diagnosed upstream as safety-router rejection
before domain routing, not proof of an assistant-self classification error.
The overbroad generic AI-assistant/internal-detail heuristic was removed from
this candidate; baseline subject-domain behavior and body copy are preserved.

## Final checks

All commands used Node **20.20.0** via
`PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH`.
Final gates completed during 05:37–05:39 UTC, after v4 and forward quarantine.

| Command | Total | Passed | Failed | Skipped | Exit/status |
| --- | ---: | ---: | ---: | ---: | --- |
| `npm run test:runtime` (runtime + core) | 766 | 761 | 0 | 5 | 0 / passed |
| `npm test` (whole repository, includes preceding runtime suites) | 1146 | 1141 | 0 | 5 | 0 / passed |
| `node --test scripts/aichattg/test/verify-migration-bundle.test.mjs scripts/aichattg/test/import-runtime-state.test.mjs` | 9 | 9 | 0 | 0 | 0 / passed |
| `git diff --check` | — | — | — | — | 0 / passed |
| `git merge-base --is-ancestor a41518f4a4fd105cf19e7fc1a64fd35b77233084 HEAD` | — | — | — | — | 0 / passed |

Do not add the two full-suite rows together: they intentionally rerun tests.
Local receipts: `/tmp/aichattg-ask-final-runtime.log`,
`/tmp/aichattg-ask-final-all.log`, `/tmp/aichattg-ask-final-migration.log`.

Five unchanged fixture-dependent skips:

1. Dry fallback retrieves admitted course evidence — knowledge package unset.
2. Value question routes to admitted value slice — knowledge package unset.
3. Supplied admitted value fixture via generic dry hints — fixture paths unset.
4. Dialogue memory inside admitted local session — knowledge package unset.
5. Real value slice/course links — external value slice unavailable.

No tests were skipped to hide a protocol failure. Synthetic strict fixtures
replace old trace-free mocks; historical policy/gold assertions were not relaxed.
The local lab helper invokes only the strict parser in memory, identifies itself
as `lab`, reports zero real model calls, and invents no paid token usage.

## Visible copy provenance

The hint now reads:

> ✍️ Теперь напишите вопрос в ответ на это сообщение и отправьте его. У вас 30 секунд, чтобы послать вопрос. /ask повторно писать не нужно.

The owner explicitly asked in this task, with screenshot `f4eb6554-10f6-4ada-bfe6-867177298918`,
to add: «у вас 30 секунд, чтобы послать вопрос», and in the same message required
that a question received after 30 seconds still be answered. Only sentence case
and final punctuation were supplied. This is the idle cleanup rule, not a denial
of late questions. Help and domain copy were not changed.

New neutral operational-failure copy is a **candidate for root/PO review**:

> Сейчас не удалось обработать вопрос. Попробуйте, пожалуйста, позже.

It does not claim the user was abusive or the knowledge base unavailable.

## Schema, transition limits and remaining gates

Changes are additive tables/indexes only; no source-body copying into new
receipt/quarantine/answer-attempt tables. Native legacy identifiers are seeded
transactionally at startup; historical jobs are read in keyset batches of at
most 500. Runtime lookups use native indexes; ambiguous legacy peers use LIMIT 2.

Forward quarantine deliberately refuses late deliveries **and edits of old
native messages** instead of guessing their owner, source revision or allow.
It preserves old accepted/error decisions; original safe retries/plans retain
baseline recovery fences, and multiple legacy jobs cannot be silently resolved.
This conservative restriction is a release limitation needing root/PO acceptance.

The exact-old downgrade counterexample is an expected passing regression test
of an unsafe transition: old a415 runtime/core open the additive DB and issue a
second semantic judgement when the late other-role webhook arrives. Therefore
automatic binary rollback is **not safe**. A root-owned controlled transition/
rollback plan and its approval remain outstanding; mitigation is **not_run**.
No blind database restore is authorized or proposed.

Live Telegram/Guard behavior, paid-model semantic acceptance, SSH, migrations on
production, release-source footer verification inside a deployed image, commit,
push and deploy are **not_run**. This report is not their approval or evidence.
Answer-attempt usage receipts preserve superseded call metadata; no Console
accounting/UI change is claimed.

## Frozen source identity

Manifest digest for all 36 changed/new app paths:
`5e2e2fa12e33659c9d695be590b6a7b12ebf696f6ea1801ca0a271521bbbf887`.
Algorithm: sorted unique app paths from `git diff --name-only` and
`git ls-files --others --exclude-standard`; SHA256 each file; SHA256 the UTF-8
concatenation of `path + NUL + file_sha256`, joined by LF without final LF.
Docs and ignored transcript archives are excluded from this code/test manifest.

| Runtime file | SHA256 |
| --- | --- |
| judgement-envelope.mjs | 8a30d9fc15ea282c1c4b73d83a49afbd1e096e89ad8dac0e5e84fe759a50ccd7 |
| judgement-store.mjs | 45dc816fac185ef38ce14f67c02adaba2fa5f190a503ab5931f0bb6e783a0ea9 |
| judgement-answer-claims.mjs | 2f3e5b3a367d0507b8e7602e19ba996d976a4bcdc623b55e0a7c7be580a2d9ff |
| runtime.mjs | a5beb7d548a7052f777aa54f142291498abc695471791588eeba8b5030bc0e3a |
| database.mjs | 66fa9b210b3f7c2fb084acd96e74244c3a560b6ced3b43582ab035dcde5e4fce |
| safety-v3.mjs | 10990981efe1d72882fa9ee0c82915d223061b50a04a2853cab9591860b23f5b |
| assistant-ask-expiry.mjs | d1a7277fd8de4bb601e3311fb88c8497f3b41ccd7a54490104de4d8575dda16c |
| telegram-adapter.mjs | ccb28cdd6d493cd4852831f7da119ae9c175a3a3ed14dc61e05275a4eabfc547 |
| guard-adapter.mjs | 0188d9d55b1f6a6e1b6bd2754418935700ea3cc4274fd163ae656d41d362579a |
| assistant-policy.mjs | 34a123eb2f19fd09acb1db24b734d2d50083ff07e554f7a4ed05eb31a17b7298 |
| server.mjs | 384f726a83ad3b6e2d28558ef0152b56f7375dc49e9f27a4e27c24fcb7b59768 |

Available task transcript archived locally with `scripts/save-dialogs.sh`;
archive remains ignored and is not part of the candidate. Next owner: root for
independent acceptance and the exact release/transition decisions above.
