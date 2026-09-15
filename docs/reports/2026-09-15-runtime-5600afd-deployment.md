# Domain routing deployment — 2026-09-15 UTC

Lifecycle: **deployed**. Exact-source infrastructure and offline in-container
compatibility checks passed. New live Telegram answer-quality acceptance was
not run; this is not a claim of complete production functional acceptance.

## Approval, scope and rollback

- Product Owner requested «деплой» after the measured candidate report in
  task019fd023-a940-7cf2-864a-75b20fd842ef. Root integrator independently re-read
  the user message01a0a5cb-26ef-7661-8b28-399d50177e20 and retained sole release
  and remote ownership.
- Exact candidate: `5600afd98d69da5e98edf3a7e9abacebff7406af`, fast-forwarded
  into canonical main and pushed before creating the Git archive.
- One-time root lease: `output/domain-release-lease-5600afd.json`, registered
  alias `news-vps`, issued16:04:25UTC, expires17:00UTC or when this run closes.
  Only `aichattg-telegram-runtime` may be built/recreated. Auth or transport
  failure is terminal, no retry/fallback. No other remote writer was delegated.
- Previous image/source: `852a8d282c4d3ace8a303425de308e1d91dc9ff3`, image ID
  `sha256:0c9d3c6c38f9d77415d54ba5a0eae34c1841c899606391062b00fe4d9ab6cc39`.
  Exact rollback image, source and mode0600 environment remain on the host.
  Startup/health or preservation failure permits reverting only the runtime
  image; never restore/delete the live database. Rollback was not needed.
- No migration, environment/secret change, webhook registration, permission
  change, knowledge import, Console/Gatekeeper recreation, News operation,
  paid test, external Telegram message or logging-driver change.

The candidate replaces the fixed route vocabulary with the bundled six-domain
Markdown registry, multi-domain source attribution and raw-versus-final routing
diagnostics. Knowledge-enabled identity/internal-boundary questions now use
router/analyzer plus answer instead of the earlier deterministic bypass. This
can increase cost/latency for those questions; it was disclosed before rollout.
Existing configured model tuples, token caps, daily limits and cooldown remain
unchanged. The consumed routing-experiment leases were not reused.

## Exact production evidence

- Runtime started **2026-09-15T16:07:36.31181337Z**.
- Image: `aichattg/telegram-runtime:5600afd98d69da5e98edf3a7e9abacebff7406af`.
- Image ID: `sha256:21fed69a7866178f491763e15833f305aa5f3ae657c6ff476350c9cf12e872a1`.
- Container: `b4b6d67c19595840ab0758c800608d2e3644299f05f1dd4929e78a9eca2926cb`.
- Archive SHA256: `cc9b3c39545121c6829ebfffefa4f773be71582284092e6ac4a9c6123fc90027`.
- `passed`: OCI revision equals the exact candidate; all55 runtime/core files
  in the running image match the archived source.
- `passed`: six default domains loaded; registry digest
  `72a76d18359a0ae24804c82c867c1d7b92cadaaaa6bdf448546e8dc896ecd265`.
  Analyzer vocabulary contains those six domains plus out_of_corpus. The
  startup analyzer log still prints the base specification digest; registry
  digest plus exact source establishes the composed specification identity.
- `passed`: checks at16:08:06UTC and16:10:06UTC both healthy/restart0,
  internal healthHTTP200, ingress enabled, SQLite quick_check `ok`.
- `passed`: all64 rendered Compose environment parameters match predecessor;
  complete environment, schema, mounts and Traefik-route digests preserved.
  runtime.env byte hash and mode0600 preserved. Compose uses explicit candidate
  AICHATTG_SOURCE_SHA, not the historical SHA retained inside runtime.env.
- `passed`: json-file rotation remains max-size10m/max-file3. No Docker log
  reader was used or left running.
- `passed`: Console container remains
  `fe42d729f5fffa1147e0b30ae47199155df58655ef5720b9e13f146462a0a82b`,
  image5e67451, healthy/restart0. Public Console healthHTTP200 and both
  unauthenticated runtime webhook probesHTTP401.

Receipts: `/home/agent/aichattg/releases/5600afd98d69da5e98edf3a7e9abacebff7406af/evidence/`.
Local content-free copy: `output/domain-release-5600afd/evidence/` (Git-ignored).
Receipt file SHA256:

```text
preflight.json    009a99574e574eb98e619015829e7af58f1f2e61ffaab28a3515976b0d2bb974
config-check.json b91933c4d43829c73408dff491a71a634252dac8ef5ddb507f6949a721a2626e
postverify.json   89eb1a78f214fe86dabd5b7e12d867cc736938b75ec3df68b60ce876ac696b6e
finalverify.json  37b9e6a57302b157a215a91924a3eb7a45924d40f1afe088d614b49591cbdbed
```

Only exact source artifacts, bounded build output and content-free receipts
were retained; no raw production message or credential was printed.

## Tests and limits of acceptance

- `passed`: independent compatibility review found no new P1/P2 release
  blockers, no migration/dependency/Compose/Moderator/Guard-policy delta.
- `passed`: fresh canonical root suite698 tests; six artifact-bound experiment
  admission tests explicitly skipped because ignored parent receipts are absent
  in canonical checkout. Those exact six were separately rerun successfully
  in the original evidence worktree. No failed tests. The earlier candidate
  full run was704 passed/zero skips.
- Canonical full-test log SHA256:
  `ee906de6a6bad5876828b8b3caea53aaccb6e27763be2534294091a9a9a7b0b4`.
- `passed`: nine offline migration-admission/import safety tests, source
  isolation, diff-check, Gatekeeper scenario30 machine/34 human entries.
- A final combined supplemental rerun confirmed15/15 (the six artifact checks
  plus nine migration checks), zero skips. Local log in the ignored evidence
  folder: `supplemental-local-tests.log`, SHA256
  `e1b400910c40ee57729a53f41eff6cc98d1daa6c856dd6d4b2b9be4d5042f7ef`.
  Canonical full-test log is also retained there as `canonical-local-tests.log`.
- `passed`: offline in-container router→source resolver→answer adapter checks
  for self, abuse and compound self+abuse, six fake requests; unknown domain
  rejected. No network, paid call, Telegram action or real provider config read.
- Harness correction: the first optional smoke used an invalid fake Moderator
  tuple and was rejected before transport. The harness was corrected to the
  existing approved tuple, passed locally, then passed in-container. No runtime
  source or production setting was changed in response.

The prior paid routing comparison measured104 attempts/103 responses: new
router28/28 and analyzer26/27 on received cases, versus14/28 and13/27 paired
baseline results. This is **routing-only**, not generated answer quality.
The compound content/value miss, two proposed risk-label discrepancies and one
uncertain transport result are preserved in the
[versioned measurement report](2026-09-15-routing-measurement-result-v2.md).

`not_run`: fresh live Telegram/paid answer acceptance, ordinary human-menu
cleanup, remediation of those semantic residuals, full-course source quality
and production dollar-invoice reconciliation. Existing QUALITY-2 and HYGIENE-1
remain open. Do not repeat uncertain synthetic deletion524 or any consumed
experiment request. PROFILE-2's old regex-only recommendation is superseded by
registry routing; live identity/account-boundary answer acceptance remains open.

This release's later docs-only receipt commit is not a new runtime image.
After final receipt collection the root SSH master is closed; the lease is
consumed and further production operations require a fresh exact gate.
