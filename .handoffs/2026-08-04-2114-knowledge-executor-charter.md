# Task Charter: Permanent Knowledge Base executor

## Metadata

- Task ID: `aichattg-knowledge-executor-v1`
- Transfer kind: task-charter
- Classification: user-visible-workstream
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `4508e8aeee0dab418a6275e7296cee3dd1e2290b`
- Worktree/branch: isolated Codex worktree from current `main`; record the exact path and branch on acceptance
- Controller: permanent AIchatTG integrator generation 1, task `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: Knowledge Base executor

## Outcome and Acceptance

- Outcome: a durable Product Owner-facing executor owns candidate-side course knowledge review, deterministic snapshot construction and admission evidence without silently enabling runtime knowledge.
- Acceptance: the executor accepts this charter, verifies its isolated worktree and base ancestry, confirms course knowledge remains disabled and unimported, and waits for the Product Owner's first Knowledge Base task.
- Evidence vocabulary: passed / failed / not_run / inconclusive.

## Scope and Exclusions

- In scope: reviewed-export validation, deterministic course-content and course-operations snapshot building, provenance/admission reports, privacy/content filtering, knowledge candidate docs/tests, and proposals for the local admission seam.
- Excluded: scraping or discovering News/course systems; copying old News indexes/databases; Assistant answer behavior; Moderator; Gatekeeper; production mounts/config, secrets, provider calls, runtime enablement, publication and paid calls.
- Only explicitly supplied, human-reviewed source exports and local snapshot roots may become candidate inputs.

## Sources of Truth

- `/Users/alexeykrolmini/Code/AIchatTG/AGENTS.md` — controller, executor, evidence and release rules.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/COURSE_KNOWLEDGE_SNAPSHOT.md` — reviewed input, deterministic build and admission workflow.
- `/Users/alexeykrolmini/Code/AIchatTG/docs/PROVIDER_KNOWLEDGE_PORTABILITY.md` — package identities, runtime admission and disabled-default boundary.

## Ownership

- Owned files/contracts: `scripts/aichattg/build-course-knowledge-snapshot.mjs`, `scripts/aichattg/test/course-knowledge-snapshot.test.mjs`, `docs/COURSE_KNOWLEDGE_SNAPSHOT.md`, Knowledge-specific documentation, and candidate metadata under `data/knowledge/**` only when explicitly admitted for Git review.
- Reserved shared files: `apps/telegram-runtime/src/knowledge-adapter.mjs`, `config.mjs`, `runtime.mjs`, `packages/telegram-core/src/knowledge.mjs`, manifests/locks, Compose/mounts, runtime data, migrations and operator console; request an integrator reservation before editing.
- Shared-contract writer: permanent AIchatTG integrator for runtime admissions, package contracts, configuration, mounts and release state; at most one reserved writer at a time.
- Integration owner/target: permanent AIchatTG integrator, canonical `/Users/alexeykrolmini/Code/AIchatTG` branch `main`.
- Unrelated dirty paths: preserve all paths outside the accepted task; never overwrite an existing reviewed snapshot or store private source content in Git.

## Authority and Attention Gates

- Allowed: repository inspection, local planning, reversible implementation, offline fixture tests, validation of explicitly supplied reviewed inputs, creation of new candidate output directories, commits/pushes on the executor branch, bounded sub-agents, and chartered `service-child` tasks whose results this executor accepts.
- Forbidden: merging to `main`, discovering/importing from News or live course systems, admitting content without provenance/review, overwriting source/snapshot directories, enabling runtime knowledge, using secrets/private user data, and claiming candidate artifacts are deployed.
- Production: blocked until the Product Owner approves the exact content snapshot and code candidate and the integrator issues a one-time lease naming SHA, artifact identities, service, scope, rollback, expiry, verification and stop conditions.
- Spending: blocked until the Product Owner gives an explicit target and cap and the integrator records it; knowledge construction and tests remain local.
- External actions: course-system reads, provider calls, uploads/publication, runtime config/mount changes and migration are blocked without exact approval.

## Dependencies

- Inputs: current `main`, an explicitly supplied reviewed export and snapshot root, Product Owner content/privacy decisions, and any integrator-granted shared-file reservation.
- Depends on: integrator-owned runtime admission contract; Assistant executor consumes only accepted package identities.
- Unblocks: integrator review of a frozen knowledge candidate; runtime admission remains separate.

## Checks

```bash
git status --short --branch && git merge-base --is-ancestor 4508e8aeee0dab418a6275e7296cee3dd1e2290b HEAD
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH node --test scripts/aichattg/test/course-knowledge-snapshot.test.mjs
git diff --check
```

## Stop Rules

- Stop and contact integrator task `019fd019-af89-7b50-a16d-8c7928753f24` before writing any reserved shared file, admitting new content, changing package/schema/privacy contracts, enabling runtime knowledge, or integrating overlapping child work.
- Stop for missing review provenance, private/ambiguous content, an existing output target, unresolved content/privacy/licensing decisions, and any production, external, secret or spending boundary.
- A sub-agent or service child never receives integration or release ownership; this executor reviews its evidence and remains accountable.

## Result Contract

Before submitting a candidate, return to the integrator: current production SHA or `not_run`; base and candidate SHAs; exact input/output identities and provenance; admitted/filtered/blocked counts; deployed, recovered and newly written ledgers; files/additions/deletions; runtime/config/protected-path effects; rollback consequence; focused evidence; risks and scope deviations; lifecycle state; and one next safe action with its owner.

On first turn, reply with `EXECUTOR ACCEPTED: aichattg-knowledge-executor-v1`, the verified branch/worktree/base, ownership summary, gates, current knowledge-disabled state, and `READY FOR PRODUCT OWNER TASK`.
