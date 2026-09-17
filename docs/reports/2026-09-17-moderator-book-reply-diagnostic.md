# Moderator book-reply incident — read-only diagnosis

Date:2026-09-17. Scope: diagnose only; no implementation or release.

## Confirmed incident path

PO reported a previously discussed advertising pattern in a reply and supplied
[message9709](https://t.me/aialexekrol/9709). The Moderator task's public-page
check established a book-recommendation reply, parent9690, timestamp09:20:25UTC.
This is not the separate porn-spam case. Root's one read-only Telegram
`getChat` resolved the public username to the configured supergroup; no
channel-post/discussion-message identity was guessed.

| Stage | Exact message result |
| --- | --- |
| Received | Moderator receipt09:20:25UTC, completed09:20:28UTC |
| Routed | Active native-revision envelope; ownerModerator; accepted |
| Legacy fence | Not quarantined |
| Judged | Provider returned; job resolved; no error code |
| Verdict | `clean`, model confidence0.99 |
| Guard/action | Policy`none`; enforcement skipped with code`clean` |

The runtime did not lose or skip this reply. It completed a clean judgement,
so the code intentionally did not ban/delete it. Confidence0.99 is the model's
reported confidence, not independent proof that the content was benign.
The operational failure alleged by the owner is a semantic nonmatch relative
to the expected anti-advertising policy, not a bot outage or missing rights.

## Owner correction: prior assignment, not a new enhancement

After diagnosis the owner said «мы обсуждали такие кейсы». The Moderator task
confirmed that the original assignment explicitly covered covert book
promotion/guerrilla marketing, pattern accumulation and notification for the
owner's decision, followed by an instruction to implement what was discussed.
Those recognition/collection/notification requirements were not delivered to
production. They are an existing delivery gap, not a new feature request.

The clean/none operational trace remains valid, but does not excuse or close
that product gap. For book-promotion suspicions the intended scenario was
review/notification, not automatic ban/delete. The later immediate-sanction
instruction was specific to pornographic spam and must not be broadened here.
This addendum records the correction only; no implementation or production
authority is inferred from it, and no fix is claimed.

## Current runtime evidence

`passed`, live09:27:16–18UTC:

- Exact source `2c72e01cb28452c640c033c91a2060a8eca57201`.
- Image `sha256:7fc9a7e61fde4efeca2bc5c3f28a91b6078cb6aadaad0ce1f09a4f505ab36748`.
- Same container25f5cc362f08760b944aecc1c0b2f95e0de1f8ec9d77d10559572f2ad77144af,
  StartedAt2026-09-16T06:57:40.921400883Z, healthy/restart0, localhealth200.
- Moderator mode live, ingress/provider enabled; target group in configured
  scope. Runtime environment digest unchanged from2.4.39 deployment.
- Seven deployed critical runtime/core/policy file hashes match exact Git2c72e01.
- Before/after container, source, config and health snapshots unchanged.

The bounded09:10–09:27 observation window in this group also contained two
OTHER jobs with `provider_safety_router_invalid` and manual-review/unknown
state. They must not be substituted for the clean/resolved job of9709.
No other message bodies or author profiles were inspected/exported.

## Explanation and limits

`passed`, source inspection:

- `runtime.mjs` sends the current comment text plus warning/strike context to
  the semantic judge; not the replied-to post or cross-author campaign history.
- Ordinary replies do not inherit the parent's auto-forward exemption or its
  legacy quarantine. This message's persisted path confirms ordinary judging.
- The shipped threat library has generic unsolicited-promotion/bait rules,
  but also exempts recommendations without identified promotional, deceptive,
  mass-posting or traffic-diversion intent. No explicit book-testimonial
  supplement exists in the shipped safety artifacts.
- The porn-spam supplement is a separate policy; the private Review detector
  and library have never been activated in production.
- The durable judgement deliberately retains route/confidence/model/usage but
  omits the model's rationale and quote. Missing `verdict` or `safetyTrace`
  fields in the diagnostic's reduced decision projection are not a malformed
  production decision: durable code uses `safetyRoute`, and the definitive
  moderation/enforcement records establish `clean`/`none`.

`inconclusive`: the model's exact rationale and whether this author was part of
a coordinated promotion campaign. Lack of parent/campaign context and the
recommendation exception are plausible contributors, not a recovered model
explanation. Do not replace this with a claim that every book mention is spam.

The outstanding work belongs to the earlier assignment: recover its recorded
recognition, pattern-accumulation and owner-notification acceptance criteria
and account for the undelivered portions without asking the owner to restate
them. This diagnostic/correction request performs no source change, paid
replay, production operation or sanction.

## Safety and artifacts

One key-only master, registered alias`news-vps`; every remote command bounded
with TERM/KILL deadlines, no transport/auth retries. Read-only/query-only SQLite
with1second busy timeout; localhealth plus one Telegram`getChat` read.
No Docker logs, model calls, external messages/sanctions, replay, restart,
config/schema/data changes, deployment, News access or binary rollback.
Master exited successfully; socket absence verified after the run.

Ignored evidence: `output/moderator-book-diag-20260917/`.
Exact IDs remain only in the local metadata receipt. `trace.json` SHA-256:
`83ccb3e61da5c630f565691cfd94bfebf0dc0a756481157c02d1a935e79a7db7`.
Source and feedback docs are the only tracked changes; no app implementation.
