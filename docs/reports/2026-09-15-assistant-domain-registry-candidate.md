# Assistant domain registry candidate — 2026-09-15

Lifecycle: `prepared`. Not pushed, merged or deployed.

## Identity and ownership

- Base: `909fad69daf2bed720de075ca2f2fecf9f19afed`.
- Branch: `codex/assistant-domain-registry`; worktree:
  `/Users/alexeykrolmini/.codex/worktrees/0f48/AIchatTG`.
- Candidate: the local Git commit containing this report; exact SHA is returned
  in the integrator handoff. No overlay or partial-tree release is proposed.
- Canonical integration owner: task `019fd019-af89-7b50-a16d-8c7928753f24`,
  under its `RESERVATION CONFIRMED: assistant-domain-registry-v1` response.
- Canonical root remained clean at the same base at final verification. The
  historical executor branch was not overwritten.
- Current production was **not read live**. The latest local receipt,
  [runtime 852a8d2](2026-09-15-runtime-852a8d2-deployment.md), records deployed
  source `852a8d282c4d3ace8a303425de308e1d91dc9ff3`, not production-verified.
  That receipt is evidence about its recorded run, not a fresh remote check.

## Delta and provenance

Newly written: catalog loader, generic routing/resolution, six Markdown domain
descriptors, two public evidence files, adapter integration, 38 additional
offline tests and documentation. Existing tests were migrated where the public
contract intentionally changed: generic domain hints, multi-domain dispatch,
known-domain missing evidence versus unknown scope, and knowledge-enabled self
answers through the ordinary model path. Technical admission and quota fences
were retained and extended, not rewritten as successful replies.

Already present at base: course package/retrieval and org/value slices, source
admission, safety-v3, delivery receipts, billing, dialogue and service-command
handling. No course package was rebuilt or recovered into the candidate. Public
identity facts and operations/value constraints were reused from current
AIchatTG source; read-only AGI descriptors supplied design ideas only. No News,
AGI or allcourses code, database, configuration, secrets or index is imported.

Code changes are confined to Assistant-specific runtime/provider/analyzer code,
the optional registry setting and startup wiring. New modules and evidence are
under `apps/telegram-runtime/src/` so the existing image copy includes them.
No core package, Moderator policy, Gatekeeper code, Console code, migrations,
dependency manifest, Docker/CI/deploy configuration or secret file changes.
No file deletions; replaced code paths remain recoverable from the base commit.

See [architecture, extension procedure and bounds](../ASSISTANT_DOMAIN_REGISTRY_V1.md)
and the index at `apps/telegram-runtime/src/domains/INDEX.md`.

## Runtime/configuration and rollback

The default catalog changes Assistant routing when knowledge is enabled. Both
router and analyzer compile the same vocabulary. Self questions use Markdown
knowledge through the normal answer pipeline; this can add model calls and
latency compared with the previous deterministic self bypass. Model names,
output caps, provider retry policy and production paid-call authorization are
unchanged. A deployment must explicitly account for this changed workload.

Optional process variable: `TELEGRAM_RUNTIME_DOMAIN_INDEX_PATH`. No default
environment change is needed; no Compose passthrough/mount was added. Other
source admissions and package identities are unchanged. Three domains per turn,
128 combined entries and existing provider input bounds remain enforced.

No schema/data migration. A future exact-image rollback restores the previous
routing and deterministic self path without converting data, but also restores
the known domain/compound-identity limitations. The actual rollback image and
production source must be refreshed by the integrator before a release lease.
This candidate does not resolve the independent synthetic menu-cleanup incident.

## Verification

All tests use local fake transports; no provider or Telegram network calls.
Node: `/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin/node`.

| Check | Evidence |
|---|---|
| Base `npm test` | `passed`: 618 passed, 0 failed, 4 skipped |
| Candidate `npm test` | `passed`: 656 passed, 0 failed, 4 skipped |
| Runtime tests within candidate | `passed`: 375 passed, 0 failed, 4 skipped |
| `npm run check:gatekeeper` | `passed`: 30 machine messages, 34 human entries |
| `git diff --check` | `passed` |
| Independent resolver/provider review | `passed`: shared-source attribution, missing primary source, malformed snapshot and quota paths |
| Live semantic classification/answer quality | `not_run` |
| Live latency, spending and Telegram acceptance | `not_run` |
| Production mutation | `not_run`; not authorized |

Four existing optional tests skipped: three require
`AICHATTG_KNOWLEDGE_PACKAGE_DIR`; one requires the absent historical value slice
fixture. These are not passes over the deployed package. Dependencies were not
installed or changed: absent ignored Gatekeeper/Console node_modules paths were
linked to the existing canonical local dependency directories.

Final full-suite log (local temporary evidence):
`/tmp/aichattg-domain-tests.acevws/verified.log`.
SHA-256: `21bb67fbb2a82bd933e65f70dbdc1eade1c4c30abc4b2f59dc369fb2c206acd0`.
The available task transcript was archived locally using `scripts/save-dialogs.sh`;
raw transcript and dependency links remain ignored, not candidate artifacts.

## Next safe action

Integrator reviews the exact local commit and decides integration/release order.
Before production approval, use a separately authorized bounded acceptance plan
with held-out wording, compound identity/navigation, public capabilities,
general procedures versus personal account actions, unknown scope, missing
facts and adversarial/critical wording. Offline exact-example labels do not
prove unseen semantic accuracy. No live run, push or deployment is authorized
by this report.
