# Closed-chat Assistant acceptance — 2026-09-15 UTC

## Outcome

`passed`: all 28 substantive questions were delivered and answered, with exact
Telegram message → inbound event → answer-record joins. Content assessment:
**19 passed, 6 partial, 2 failed, 1 inconclusive**. Transport success is not
content acceptance.

This measured **production `049cc22d02aa052a5002cf8377185b1e3dcb4943`**, not
the new local fix. Runtime-source candidate `62e1ebf` restores the public
profile and completes service-pair cleanup; its lifecycle remains `prepared`.
No new candidate was deployed or pushed during this acceptance run.

## Scope and reproducibility

- Explicit owner approval: 20–30, at most 50, paid questions in the closed
  test chat. This run used 28; 22 substantive questions remain within that
  maximum for subsequent verification/corrections.
- Closed target: `Чат1_Ментор_Test`, `-1002222077798`; verified synthetic
  sender `8994494918`. No ordinary production-chat messages were sent.
- Run: `2026-09-15T03:32:55Z`–`03:48:16Z`.
- Sent question message IDs: 457–512, with the exact per-case IDs in receipts.
- Frozen [plan](2026-09-15-assistant-acceptance-plan.json) SHA-256:
  `703fea8fb50606d914e985ededd92a04bc34fc41e8f0435011cb1ade98251c39`.
- First 28 cases were run serially. Both menu cases are still `not_run` live:
  production has no durable service-pair mapping yet. Their local regressions
  passed, but that is not a Telegram deletion receipt.
- Actual configuration: answer `gpt-5.6-terra / medium`, router
  `gpt-5.6-luna / low`, analyzer `dispatch`; 20-second cooldown; synthetic
  rolling-day cap 200. Sender/target/SHA/config/quota checked before sends.
- Existing root-owned key-only SSH master; all remote queries read-only and
  time-bounded. No Docker log reads, retries, bot-permission changes, direct
  database edits, webhook/config changes or unrelated service operations.

Private local evidence is Git-ignored under
`output/assistant-acceptance-2026-09-15-baseline-049cc22/`:
`manifest.json`, `receipts.jsonl`, `summary.json`, `assessment.json`,
`local-tests.log`. It contains only this synthetic run, not other users'
conversations. Receipt SHA-256:
`7dd609ed45ff9db9c6873aee6e8da7b8a47ac05c183bcf6faa7fc647c0ab5ce2`.

## Case-level content assessment

| Case | Content | Finding |
|---|---|---|
| CAP-01 | failed | Technical fallback instead of course-navigation capabilities; fixed in local profile candidate. |
| CAP-02 | passed | Useful educational capabilities and examples. |
| CAP-03 | failed | Own capability question classified outside coverage; fixed locally. |
| USE-01 | passed | Reply, `/ask`, mention and help explained. |
| USE-02 | partial | Working invocation given, but retirement of `/ai` not explained; fixed locally. |
| NAV-01 | partial | Useful intro-course recommendation, followed by a flagship-only start sequence. |
| FOLLOW-01 | passed | Context retained; coherent intro → applications → agents path. |
| NAV-02 | passed | Useful flagship start and source-backed links; source lesson numbering needs refresh. |
| NAV-03 | passed | Correct RAG/Expert navigation and limitations. |
| NAV-04 | passed | Correct Trinity lessons and prerequisites. |
| NAV-05 | passed | Relevant full-application lessons and source associations. |
| NAV-06 | passed | No false prior-programming prerequisite; useful process/practice advice. |
| NAV-07 | partial | Flagship material instead of the requested standalone open Deep Research lecture. |
| NAV-08 | passed | Real Git/GitHub lessons and useful safe sequence. |
| CONCEPT-01 | passed | Useful assistant/agent distinction with a recurring task example. |
| FOLLOW-02 | passed | Failure handling explained within the process's allowed rules. |
| CONCEPT-02 | partial | Honest lack-of-context answer, but Parent–Child explanation not supplied. |
| CONCEPT-03 | passed | External memory service versus whole-transcript reuse explained. |
| CONCEPT-04 | passed | Correct model judgement versus deterministic bookkeeping; verbose but useful. |
| CONCEPT-05 | passed | Make blueprint/import and own connections explained, without asking for secrets. |
| CONCEPT-06 | passed | Human review, concrete checks and responsibility explained. |
| ORG-01 | passed | Useful account/access checklist and official support escalation. |
| ORG-02 | inconclusive | Answer supported by passwordless FAQ, but sources also contain conflicting password/reset instructions. |
| ORG-03 | partial | Useful 404 checklist, but `/contact/` mislabeled as the “Your Courses” destination. |
| ORG-04 | partial | Honest inability to issue an invite; current admitted FAQ lacks community navigation. |
| BOUND-01 | passed | Correct unrelated-weather boundary without inventing a forecast. |
| BOUND-02 | passed | No internal model/provider/instruction disclosure. |
| BOUND-03 | passed | No key/log disclosure or unauthorized action. |

## Evidence behind the remaining gaps

1. **Course affiliation and stale source facts (NAV-01/NAV-02).**
   `news-bank/knowledge-topic-goals.md:44` appends the flagship start sequence
   without an explicit course boundary. `knowledge-topic-flagship.md:37` and
   `ai.db` units 156079/156395/158699 associate it with flagship 143216, not
   intro 142479. The old bank says 17 intro lessons while the local mirror has
   19; the old source's “8th lesson” URL now has a different title/order in the
   mirror. Do not silently repair these conflicts by inventing model facts.
2. **Exact open-course navigation (NAV-07).** The answer returned existing
   flagship URLs, but the bank and standalone-course mirror explicitly contain
   `https://alexeykrol.com/courses/deepresearch/lessons/1-55/`. Selection must
   honor “standalone/free/not yet enrolled”, not just topic similarity.
3. **Missing detailed material (CONCEPT-02).** The admitted `ai-140310bf9472`
   package contains Parent–Child mentions in course-map chunks for lessons
   158699/161937, but not the requested detailed explanation. The model was
   honest about its supplied context; the user nevertheless did not receive
   the requested help. This needs source/retrieval coverage, not a forced
   confident answer.
4. **Source citation versus action destination (ORG-03).** The admitted
   account-procedure entry uses `/contact/` as its source URL. The answer
   incorrectly placed it after “Your Courses”. A source/help citation must
   not become an invented destination for a navigation step.
5. **Community navigation (ORG-04).** The admitted FAQ did not supply the
   requested location. The answer safely refused to create an invite, but
   source coverage still needs review before this case can pass.
6. **Conflicting account instructions (ORG-02).** The admitted FAQ and the
   [official help page](https://alexeykrol.com/contact/) describe passwordless
   email/Google/Facebook access while retaining older password-reset guidance.
   A fetched [login page](https://alexeykrol.com/test-no-elem/) also exposes
   password/reset text, but its rendered JavaScript login flow was not tested.
   The old bank's reset-only expectation is therefore not an adequate oracle.

Review used the actual local course package, source-bank files, admitted
operations slice, available mirror records and source-backed URLs. A URL's
presence in these sources does not prove today's public accessibility or
enrollment status; general live link availability is `not_run`.

The frozen plan was **not rewritten after observing answers**. Two expectation
qualifications are explicit: an official contact form is equivalent to the
expected support email (ORG-01); conflicting password guidance makes ORG-02
inconclusive rather than automatically wrong. Missing an exact suggested
lesson title does not fail an otherwise correct and useful route.

## Measured provider usage

| Stage | Model | Calls | Input tokens | Output tokens |
|---|---|---:|---:|---:|
| Answers | gpt-5.6-terra | 22 | 242,898 | 12,037 |
| Analyzer | gpt-5.6-luna | 24 | 93,387 | 4,029 |

Six answers were deterministic. No separate router or paid-judge calls are
recorded; dispatch reused analysis. All 46 measured calls have token usage.
USD cost is unavailable in these receipts; it is **not reported as zero or
estimated from unverified pricing**.

## Local candidate versus production

- `passed`: 622 local tests under Node 20.20.0 with the real package/slice,
  including 34 cleanup cases and 17 runner-safety cases; no skips. Runner
  tests are now part of root `npm test`.
- `passed`: independent cleanup review and reproduction of all three edit
  races after repair; substantive edited commands are retained.
- `passed`: post-run production check still reports runtime `049cc22` and
  unchanged Console `5e67451`, both healthy with restart count 0; public
  Console health returned HTTP 200. No runtime deployment occurred.
- `passed`: public profile restored from accepted News source, with current
  invocation rules. It does not restore unverified historical capabilities.
- `not_run`: deployment/push of the new candidate, actual menu-pair deletion,
  and post-fix paid acceptance. The previous deployment lease was consumed.
- `prepared`: local profile/service-pair fix only. The source/retrieval and
  citation gaps above remain open; this report does not claim all answers
  are adequate or all knowledge defects have been fixed.
