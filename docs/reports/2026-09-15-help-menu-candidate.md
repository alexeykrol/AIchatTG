# Menu-first Help candidate and frozen routing-test isolation

Candidate lifecycle: `prepared`. This is not a deployment receipt.

## Accepted scope

The Product Owner asked for a literal, menu-first instruction with no implied
steps, and supplied the capabilities wording. Source candidate
`f69cd8493acde2c310d0c5ae5c723fc7d0d1f01d` was based on deployed `5600afd`;
its four-file patch was cherry-picked into canonical local `main` as `74918c6`.
Review corrections are in `ab0352e`; test isolation is in `fb40fce`.

The primary path is menu `/ask` → send the command → reply to the bot's prompt
with a question → send the question, without repeating `/ask`. Text `/ask`
and ordinary @mention remain secondary. The capability bullets are identical
between deterministic Help and the public Markdown knowledge source. There
are no changes to command registration, cleanup state, routing algorithms,
models, provider limits, schema, secrets, webhook or bot permissions.

## Independent review corrections

- The source candidate accidentally removed the public statement that the
  assistant is not Alexey Krol or a human. The existing domain-source contract
  failed (14/15 tests); that statement was restored separately from the owner's
  capability bullets. The index's anti-impersonation policy was never removed;
  this is not evidence of a demonstrated impersonation exploit.
- Help quoted “Задайте вопрос” while the new prompt begins “Теперь напишите
  вопрос”. Both Help sources now use the actual abbreviated prefix.
- Added a shared-text regression for all capability bullets and numbered
  steps, plus an adapter-boundary test for selective `force_reply` to the
  exact menu-command message. The existing runtime test still verifies the
  user's reply without a second `/ask`.

## Why the old tests failed

`routing-only-eval.mjs` protects a historical baseline with exact hashes,
including `assistant-policy.mjs`. The v1 collector/continuation uses that
evaluation plan and its source identity. Changing Help correctly makes the
current-source historical preflight reject `baseline_source_changed`.

Changing the stored hashes, disabling the guard, or hashing archived bytes
while importing current functions would falsely attach old measurements to
new code. None of those approaches was used.

## Isolation contract

- The original three test files are preserved byte-for-byte under
  `apps/telegram-runtime/historical-checks/*.check.mjs` rather than run against
  changing current code. A wrapper in the default suite runs their original
  paths from exact `5600afd98d69da5e98edf3a7e9abacebff7406af` in a private
  temporary detached worktree.
- Historical evaluator/collector/continuation scripts, cases and preserved
  test bytes must match the pinned Git source. Core package resolution uses
  that same worktree, not current dependencies. Missing Git objects fail
  closed; there is no network fetch or dependency installation.
- The historical child has offline network/credential guards and a bounded
  invocation. This is fake-transport verification, never a paid continuation.
- Without original local parent artifacts, six receipt-bound tests remain
  explicit skips. `npm run test:routing-history -- --parent-dir PATH` admits
  only the exact six hash-validated parent files into the temporary copy;
  incomplete or altered artifacts fail instead of becoming skips.
- Current compound-domain and provider-wire parity tests execute current
  compilers, parser, provider adapter and knowledge resolution separately.
  A current-source test also proves v1 preflight still refuses the changed
  baseline before creating output. Cost-summary tests stay in the current suite.

The paid run's gold, captures, manifests, budgets, leases, known missing
response and semantic limitations remain untouched. Historical tests do not
prove the new Help's model-generated wording or Telegram client behavior.

## Verification

All checks used Node 20.20.0. `npm test` used the existing approved local course
package and value slice; no network or provider calls were added.

| Check | Result | Scope |
| --- | --- | --- |
| Final root `npm test` | `passed`: 687/687 top-level tests | Current code, including seven historical-isolation wrapper/guard tests |
| Automatic nested historical lane | `passed`: 23; six explicit artifact-only skips | Exact `5600afd`, no ignored private parent files assumed |
| Explicit original-parent historical lane | `passed`: 29/29, zero skips | Exact six SHA-validated synthetic artifacts, preserved before/after |
| Independent Help/current boundary review | `passed`: 80/80 focused tests, no remaining P1/P2 | Identity, prompt text, force-reply and current routing |
| Independent isolation review | `passed`: 7/7, no remaining P1/P2 | Frozen source/core, guards, counts and cleanup |
| Migration safety tests | `passed`: 9/9 | Offline only; no production migration |
| Gatekeeper scenario and infra isolation | `passed` | 30 machine messages / 34 human entries |
| `git diff --check` | `passed` | Integrated changes |
| New Telegram/client/model/production acceptance | `not_run` | No release or external sends authorized here |

The explicit historical command was verified through the documented root npm
script. Its temporary worktrees were removed; the original artifacts were not
modified. The initial runner filename began with `test-`, which Node's discovery
also executed; it was renamed to `verify-frozen-routing-v1.mjs` and the final
full suite rerun to verify that the wrapper invokes it only once.

Ignored local evidence under `output/help-ux-f69cd84/`:

| File | SHA-256 |
| --- | --- |
| `integrated-tests-final.log` | `31cc335caf64cc771e1f01c0dadf7066ea03c2777dcfe035079344df587c6a01` |
| `historical-final.log` | `1f7d0d371084ea0269105216395edeb3de5889091dfd5c5993b7dcca6b6cd7b7` |
| `migration-tests.log` | `0cd854a1d12debc1506f4fb7a8ad2f49dd2e8358efe66284c390c280fd332d28` |

The test counts are separate scopes, not a new paid benchmark score. The
in-process offline guard is defense in depth for pinned known tests, not an
OS-level sandbox for arbitrary code.

## Production boundary

Last production observation (18:19 UTC) remains image/revision `5600afd`,
healthy/restart 0; no fresh production request was made in this Help task.
The owner independently disabled inline mode in BotFather; root's one read-only
`getMe` check confirmed `supports_inline_queries=false` at 18:47:46.491 UTC.
That setting observation does not prove the composer or answer flow end to end.

This Help candidate is not pushed, PO-approved for release, deployed, or
production-verified. A later exact release needs the candidate SHA, runtime
scope, current production check, rollback and verification under a fresh lease.
Existing menu-cleanup uncertainty and live answer-quality gaps remain open.
