# Assistant domain registry v1

Status update2026-09-15: `deployed` as5600afd. This design document is not the
[deployment receipt](reports/2026-09-15-runtime-5600afd-deployment.md).
Routing-only measurement is recorded separately in the
[result-v2 report](reports/2026-09-15-routing-measurement-result-v2.md);
new live generated-answer quality remains unverified.

## Two independent jobs

The registry answers **which domains can help and which admitted sources they
may use**. A domain's knowledge answers **what is actually known**. Improving a
corpus, splitting lessons, retrieval ranking and source freshness are separate
work from adding or describing domains.

The runtime uses one catalog for router vocabulary, analyzer topic vocabulary,
source selection, answer policies and public capability descriptions:

`question → registered domain(s) → admitted evidence → grounded answer`

The shipped index is
`apps/telegram-runtime/src/domains/INDEX.md`. Small evidence files live beside
it. Existing content, navigation, operations, value, assistant-self and abuse
use the same contract. The architecture is not limited to these six names.
An eight-domain test catalog verifies an unrelated new Markdown domain without
editing runtime code.

## Adding a domain

1. Add a `## unique-domain-id` block to INDEX.md. Its fixed fields are documented
   at the top of that file: description, inclusions/exclusions, positive and
   negative examples, public capability, source binding and answer policy.
2. Bind it to an existing admitted source, or set Source kind to `markdown` and
   Knowledge to a relative `.md` filename in that directory. Add reviewed facts
   to that file, starting with `# Title`. Action defaults to the domain ID;
   action/source pairs must remain unique.
3. Add offline acceptance cases: ordinary and compound questions, near-misses,
   no evidence and malformed configuration. Review classification with held-out
   questions before any production release.
4. Review and release exact Git data through the normal approval gate. Files
   are loaded and validated once at startup, not hot-reloaded from chat input.

Markdown and current snapshot/retrieval adapters are the supported source kinds.
Naming an arbitrary database/package in the index does **not** admit it. New
source backends or package admission mechanisms can need an adapter/integration
change; this candidate does not broaden current package admission. For a small
new subject, adding the descriptor and its reviewed Markdown is sufficient.

The default catalog ships inside `src/`, already included by the runtime image.
`TELEGRAM_RUNTIME_DOMAIN_INDEX_PATH` optionally selects a process-local index;
relative paths resolve against process cwd. No Compose passthrough, production
mount or environment value is changed by this candidate. Default deployment
requires no new variable.

## Recognition and answer behavior

- The model returns zero to three registered domain IDs and independent risk
  flags (`abuse`, `prompt_injection`, `privacy`). Arbitrary action/source claims,
  unknown IDs, duplicates and conflicting route declarations are rejected.
- Full positive examples provide deterministic labels for those exact complete
  questions only. Matching normalizes case, whitespace and trailing punctuation;
  it does not trigger on a keyword inside a larger question. A disagreement is
  recorded as `registry_exact_example` detector debt. Compound examples must be
  labelled in all relevant domains. These tests are not evidence of semantic
  accuracy on unseen questions.
- Analyzer dispatch retains configured diagnostic form rules from
  `analyzer-spec.json` (including existing L3 primary-topic policy), applying
  them only to registered targets. Legacy JSON domain descriptions, router
  hints and source vocabulary are replaced by the catalog in the live adapter;
  standalone legacy compiler/laboratory helpers remain for compatibility.
- A compound question may receive evidence from several domains. Shared-source
  retrieval runs once; deduplicated entries retain every domain attribution.
  Missing portions are explicit and may not be answered from another domain.
- No domain match produces a neutral boundary reply with public capabilities.
  A recognized domain without grounding produces a different missing-knowledge
  reply. An intentionally unconnected source is missing coverage; corrupted or
  missing admitted manifests, malformed snapshots and retrieval failures remain
  technical errors, never claims about the user's topic.
- Known sources retain existing citation, operations and value answer rules.
  Content/navigation allow only their declared `course-knowledge-v2` served
  identity; legacy snapshot fallback is explicit in the index and cannot
  override a failing configured retriever.

## Assistant identity and safety

Public identity, name, scope, invocation and limitations are evidence in
`assistant-self.md`, not a regex-only pre-router answer. The supplied facts
distinguish general course procedures from actions on a personal account.
The reason for retiring `/ai` is not documented; an answer must not invent it.
Current public capabilities are generated from the catalog, not a fixed list
of four subjects.

The abuse domain describes a reply about internal-information boundaries. It
does not grant warning, deletion, banning, account access or any other action.
Existing Moderator decisions remain authoritative before Assistant routing;
curiosity or criticism alone does not become abuse. Retrieved text is evidence,
not permission or executable instructions.

With knowledge enabled, self questions now use the existing router/analyzer
and answer model path. They are no longer guaranteed zero-call deterministic
answers: ordinary mode uses router + answer; dispatch uses analyzer + answer;
observe may additionally run the analyzer. This changes potential per-question
cost and latency, not the configured models, caps or paid-call authorization.
`/help`, bare `/ask`, retired-command handling and knowledge-disabled minimal
fallback remain deterministic. Their legacy static copy is not a live catalog
view; changing that command/help UX is outside this candidate.

## Bounds and evidence

The index is limited to 25,000 characters and each Markdown knowledge file to
16,000. A question selects at most three domains and at most 128 combined
entries; the existing provider input limit still applies. Exceeding bounds is
a visible local error, not silent context truncation. A much larger catalog
may later need hierarchical selection or a different budget; this candidate
does not claim unlimited scale.

Catalog digests cover descriptions and Markdown evidence. Provider, analyzer
and runtime must agree on the digest. Existing SQL journals keep their primary
route/source projection; no migration or new journal schema is introduced.
Full multi-domain coverage and flags reach the answer provider. Offline checks
use real parsing/runtime/SQLite/provider validation with fake transports only.
At initial preparation live classification, factual answer quality, latency
and cost were `not_run`. The later routing-only experiment measured selection
and test token cost; it did not establish generated-answer quality, live
dialogue cost or comprehensive production acceptance.

Design reference: read-only review of descriptor ideas in the local AGI project.
No other project's code, index, database, configuration, secrets or runtime
dependency is imported. Knowledge-package optimization is deliberately deferred.
