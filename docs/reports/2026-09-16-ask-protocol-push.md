# Ask protocol — pushed source, deployment attention gate

Date: 2026-09-16 UTC. Current candidate lifecycle: **pushed**.

The Product Owner requested «Ну так задеплой и запуш» after the root status
report. Root completed the independently authorized Git publication. The
request does not resolve the already documented legacy-moderation limitation
or turn a failed downgrade test into a verified rollback plan.

## Git evidence

`passed`: clean candidate source guard rerun againsta41518f; Assistant2.4.39,
planned date2026-09-16. No candidate source changes since the1141pass/5skip gate.

`passed`: after fetching current GitHub state, one non-force atomic push sent:

- `refs/heads/codex/assistant-reply-moderation`:
  `2c72e01cb28452c640c033c91a2060a8eca57201`.
- `refs/heads/main`: `07455fd16d6d7da63a0b325a47faeb4b38ec1e3d`, containing
  all eight previously unpushed documentation commits.

Direct `git ls-remote` returned both exact refs. This receipt and current-state
documentation are a subsequent docs-only main checkpoint, not a runtime merge.
The candidate remains isolated from main's runtime source.

## Deployment state and exact decision

`not_run`: SSH, production mutation, fresh remote baseline, deployment and
new paid/Telegram tests. No release lease was issued. Last verified production
remains runtimea41518f/Assistant2.4.38 and Consolef650fe8/3.2.0.

Deploying this candidate would add protocol tables and intentionally ignore
late deliveries **and edits of pre-upgrade native messages**; ordinary new
messages are unaffected. That is a security/behavior limitation requiring an
explicit decision, not an implementation detail silently accepted by a generic
deploy request. An unrestricted a41518f rollback on the new database is proven
unsafe; its tested replacement is still not_run.

The proposed decision is whether the owner accepts that legacy limitation and
an emergency stop of Assistant/Moderator until repair instead of an old-binary
rollback. The stop/transition procedure must still be designed and tested
before any production activation. Without acceptance or a reviewed alternative,
keep the current live version unchanged. New fallback copy also remains part
of the exact release scope, not an independently approved publication.

The separate Console3.3.0 private Review remains pushed/not deployed; no live
collection, erasure-policy selection or primary-Guard dependency was activated.
Its existing Product Owner decisions remain separate.

See [verified candidate and open gates](2026-09-16-ask-protocol-root-review.md)
and [release queue](../RELEASE_QUEUE.md).
