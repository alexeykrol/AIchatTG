# Additive out-of-coverage wording candidate

Lifecycle: `prepared`. Local integration only; not a deployment receipt.

## Scope and ownership

The original Product Owner request and subsequent correction were independently
re-read in the Assistant task. The owner asked for an addition, not a rewritten
answer. Candidate `60f6b9bf869252703b3a04348b496d1d788f4ac4` changes only the
out-of-coverage text and its adjacent comment; it was cherry-picked onto the
prepared Help candidate as `183d7f9` without importing the rest of that branch.

The exact addition is:

> Возможно, вам стоит сформулировать вопрос иначе: назовите тему, урок или задачу — тогда я смогу попробовать найти ответ.

All original sentences, their order, the referral to a general-purpose chat
or specialist, and the course-support offer remain unchanged. No unverified
claims about automatic abuse classification, moderator escalation or permanent
bans were added. No routing, retry count, moderation policy or provider behavior
is changed. The comment explicitly distinguishes the suggestion from a runtime
retry limit.

## Verification

The integration adds an exact-string regression: removing the one approved
sentence must recover the original answer byte-for-byte. The existing verdict
test now checks the concrete topic/lesson/task suggestion instead of a stale
literal-word exclusion that missed synonymous wording.

`passed`: final root `npm test`, 688/688 top-level tests on Node 20.20.0,
including the new exact-text regression and the current routing/guard checks.
The default nested historical lane separately ran 23 checks with six explicit
missing-parent skips. A fresh explicit run with the original hash-validated
parent artifacts passed all 29 historical checks with zero skips; all parent
files remained unchanged. `git diff --check` passed.

Ignored local evidence under `output/coverage-copy-60f6b9b/`:

- `full-tests.log`, SHA-256
  `e12fa12f1bd5792ab65f5fbbdd608a59f0932710da3370c5d06fb5b91afc311e`.
- `historical-tests.log`, SHA-256
  `f163ed131a843e510fbdc6cb4c8016355d204f65c516c20c463c2096b9347e19`.

The frozen historical evaluator/collector sources, cases, hashes and paid
artifacts are unchanged. Their success never authorizes another live call.
No remote access, Telegram request, provider call, setting change, push or
deployment was performed for this candidate. Production and live client/answer
acceptance were `not_run`; a future release needs a fresh exact approval/lease.
