# Task Charter: semantic porn-spam policy and synthetic corpus

## Metadata

- Task ID: moderation-porn-spam-policy-v1
- Work kind: implementation
- Status: chartered
- Project root: `/Users/alexeykrolmini/Code/AIchatTG`
- Base ref: `4a6c7feec47e50472cad49fd2e56c4c7b3c8922d`
- Worktree/branch: `/Users/alexeykrolmini/.codex/worktrees/d85f/AIchatTG`,
  `codex/moderation-review-v1-20260915`; existing checkout and dirty Review files
  stay unchanged. Read canonical source; produce only new owned files below.
- Controller: root task `019fd019-af89-7b50-a16d-8c7928753f24`
- Result owner: task «Модератор» `019fd023-a949-7961-87cd-693bcb893e2c`

## Outcome and Acceptance

- Outcome: a bounded semantic-policy supplement and synthetic reference corpus
  for suspected pornographic spam/profile solicitation, not a keyword autoban.
- Acceptance: policy uses existing `spam_or_scam` and valid verbatim evidence;
  one current message can suffice; no identity/repetition/automation proof or
  high-certainty threshold. No action selection by the model. Legitimate
  reporting/quotation/translation and ordinary invitations remain negatives;
  disguising an actual solicitation as a quote is not an automatic exemption.
- Evidence vocabulary: passed / failed / not_run / inconclusive.
- Synthetic fixtures and mocked outputs do not establish model recognition.

## Scope and Exclusions

- In scope: source-only supplement, 24–40 synthetic positives/negatives with
  stable IDs, text, expectedThreat, rationale and category. Cover paraphrases,
  obfuscation, indirect profile/DM diversion, ordinary and educational contexts.
- Excluded: Review/bridge files, literal private specimen/person identifiers,
  executable local matcher, model/schema changes, new data collection,
  production activation, UI/Telegram lookup, paid evaluation, push or commit.

## Sources of Truth

- `/Users/alexeykrolmini/Code/AIchatTG/docs/OWNER_FEEDBACK_LOG.md` — latest PO
  decision supersedes exact-string-only and manual-review assumptions.
- `/Users/alexeykrolmini/Code/AIchatTG/apps/telegram-runtime/src/safety-v3.mjs`
  and `safety-artifacts/threat-library-v1.md` — existing semantic contract.
- `/Users/alexeykrolmini/Code/AIchatTG/packages/telegram-core/src/index.mjs` —
  existing threat to ban_purge policy; at most100 known messages plus current.

## Ownership

- Owned files/contracts: new files only in worker checkout:
  `apps/telegram-runtime/src/safety-artifacts/porn-spam-policy-v1.md` and
  `apps/telegram-runtime/test/fixtures/porn-spam-policy-v1.json`.
- Shared-contract writer: root alone owns safety-v3 wiring, existing artifacts,
  runtime/database/projection, tests, release identity and durable root docs.
- Integration owner/target: root / canonical main.
- Unrelated dirty paths: all existing Review files and docs/proposals preserved.

## Authority and Attention Gates

- Allowed: read canonical local sources; create the two owned files; local
  no-network validation and synthetic reasoning.
- Forbidden: commit/push, remote/UI/Telegram actions, secrets or real data,
  paid model calls, source edits outside the two owned files.
- Production: blocked; no lease or source release is authorized here.
- Spending: blocked; current model/vendor/budget configuration stays unchanged.

## Dependencies

- Inputs: relayed latest PO policy for suspected porn-spam, not all uncertain
  content. Root independently integrates and verifies the wiring and tests.
- Depends on: no bridge policy decision; those remain separate and unanswered.
- Unblocks: root-only source candidate; not production acceptance.

## Checks

```bash
git status --short --branch
git diff --check
node -e 'JSON.parse(require("fs").readFileSync("apps/telegram-runtime/test/fixtures/porn-spam-policy-v1.json", "utf8")); console.log("fixture JSON passed")'
```

## Stop Rules

- Stop for: ownership conflict, existing target file, need to broaden source,
  real user evidence, new paid or external action, unresolved product decision.
- Do not invent live occurrences, verified translations, precision or recall.

## Result Contract

Return the two absolute paths and SHA-256 hashes, concise validation evidence,
risks/coverage limits, and next owner root for integration. Keep all other
worker files frozen. No routine acknowledgement-only turn is required.
