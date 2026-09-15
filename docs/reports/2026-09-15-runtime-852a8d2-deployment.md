# Course profile and service-pair cleanup deployment — 2026-09-15 UTC

Lifecycle: `deployed`. Infrastructure checks passed; functional acceptance did
not pass completely. Do not mark this candidate `production-verified`.

## Approval and scope

- Product Owner approved the proposed exact release with “Деплой, комить, пуш.”
- Deployed source: `852a8d282c4d3ace8a303425de308e1d91dc9ff3`; implementation
  commit: `62e1ebf1c323e36edeb306094688b911608e968a`.
- One-time lease: this root-owned run on registered alias `news-vps`, from
  preflight at 06:48 UTC through this release's post-deployment verification;
  expires when this run finishes. Only `aichattg-telegram-runtime` may be
  recreated, with rollback to `049cc22d02aa052a5002cf8377185b1e3dcb4943` on
  startup/health failure. Auth/transport failure stops the run, without retries.
- Preserve environment values, secrets, webhook routes, permissions, databases,
  knowledge and adjacent services. No schema migration, data import, bot
  registration, rights change, logging-driver change or News operation.
- Closed-chat test scope reuses the owner's maximum of 50 substantive questions:
  baseline used 28; this release predeclares eight more (ten synthetic sends,
  including two bare menu commands). No separate paid judge or quota change.

## Exact artifact and production checks

- `passed`: source commits pushed; remote `origin/main` verified at the
  candidate before build. The later documentation receipt commit is not the
  deployed runtime image.
- Archive SHA-256:
  `648455c370597f2b9a60112098e432e5b2398f3b1098d4b3fb9285d94681e744`.
- Image: `aichattg/telegram-runtime:852a8d282c4d3ace8a303425de308e1d91dc9ff3`.
- Image ID: `sha256:0c9d3c6c38f9d77415d54ba5a0eae34c1841c899606391062b00fe4d9ab6cc39`.
- Container: `2f5a2f7ad84bda3c83a6b08063c328b2ed747488ea92303b4f6049cc3fda7f21`.
- Started: `2026-09-15T06:49:50.137168826Z`.
- `passed`: OCI revision equals the candidate; all 50 runtime/core source
  files inside the running container match the exact release archive.
- `passed`: all 64 Compose environment parameters match the predecessor.
  Whole container environment digest, bind mounts, Traefik labels and SQLite
  schema digest remain unchanged. `runtime.env` is byte-identical, mode 0600.
  Compose received the candidate through an explicit `AICHATTG_SOURCE_SHA`
  override; the preserved file still contains its historical SHA value.
- `passed`: healthy, restart count 0; internal runtime `/health` returns
  HTTP 200 with `ingressEnabled: true`. Public Console `/health` returns 200;
  unauthenticated requests to both runtime webhook paths return 401.
- `passed`: repeated verification at 06:59:55 UTC (ten minutes after startup)
  matched source/config/schema again, with healthy / restart 0 and unchanged
  Console; the exact rollback image is present.
- `passed`: Console container ID remains
  `fe42d729f5fffa1147e0b30ae47199155df58655ef5720b9e13f146462a0a82b`, image
  `5e67451e6cf2d5b3afb336ccd42897bdeefd6f2b`, healthy and restart count 0.
- `passed`: repeated full local test run under Node 20.20.0: 622 passed,
  0 failed, 0 skipped; Gatekeeper scenario 30 machine / 34 human entries;
  release-source isolation and `git diff --check`. No local test spends money.

Release and content-free receipts:
`/home/agent/aichattg/releases/852a8d282c4d3ace8a303425de308e1d91dc9ff3/`
(`evidence/preflight.json`, `config-check.json`, `postverify.json`, `finalverify.json`).
One key-only SSH master served the root integrator. One later diagnostic read
used `docker-logs-safe.sh` (20s deadline, tail 200, since 10m), filtered on the
host to the single failed synthetic cleanup event. It finished with exit 0;
no raw production logs were retained or printed and no reader was left running.
The SSH master was closed after the final receipt transfer. Available local
Claude Code and Codex transcripts were archived with `scripts/save-dialogs.sh`;
raw dialogues and live-test receipts remain Git-ignored.

## Post-fix live acceptance

Frozen [eight-case plan](2026-09-15-assistant-postfix-acceptance-plan.json),
SHA-256 `f4e6235a19f9e9521773ab7a67188f6a0187ceb4a7f4647ffa6f57dbdd1d7f39`.
Target: closed `Чат1_Ментор_Test`, `-1002222077798`; named synthetic sender
`8994494918`. Harness verifies target/SHA/quota before sending, serializes
requests with the existing cooldown, and performs no ambiguous-send retries.

Local ignored receipts:
`output/assistant-acceptance-2026-09-15-postfix-852a8d2/`.
The folder retains `manifest.json`, `receipts.jsonl`, separate manual
`assessment.json`, `local-tests.log` and the content-free `deploy-evidence/`.
Receipt SHA-256:
`4e4f4382ab27db92e15ef560bbab054694cec90c6a17581fb207ee7dd90e5fe3`.
Run: `2026-09-15T06:50:50Z`–`06:53:39.626Z`. Six substantive questions and one
bare command were sent before the harness stopped with
`MENU_CLEANUP_NOT_VERIFIED`. No send/deletion retry followed. The cumulative
owner-authorized question count is 34/50 (28 baseline + 6 here), not 36;
16 questions remain unused. Remaining capacity is not permission to bypass
the stop or change bot permissions/test identities.

| Case | Question / answer IDs | Delivery | Content | Functional result |
|---|---|---|---|---|
| CAP-01 | 514 / 515 | passed | passed | Course navigator capabilities, no technical fallback. |
| CAP-03 | 516 / 517 | passed | partial | Course/AI/automation/learning topics named, but the frozen general-rules versus personal-account-operations distinction is omitted. |
| USE-01 | 518 / 519 | passed | passed | Reply, `/ask`, mention, `/help`, no unaddressed interruption. |
| USE-02 | 520 / 521 | passed | passed | Explicitly states `/ai` is retired. |
| PROFILE-ID | 522 / 523 | passed | failed | “Кто ты и как тебя зовут?” falls through the anchored single-clause profile matcher and reaches `boundary:out_of_coverage:domain_no_signal`. |
| MENU-01 | 526 / 527 | passed | passed | Useful process-design answer; two-message cleanup acceptance failed. |
| MENU-02 | not sent | not_run | not_run | Stopped before this case. |
| MIXED-RAG | not sent | not_run | not_run | Stopped before this case. |

### Exact cleanup result and remaining uncertainty

- Menu event `assistant:901420493` proves bare command **524**, hint **525**,
  same chat/user; substantive answer event is `assistant:901420494`.
- Persisted one-shot cleanup: `finished`; hint `deleted` by Assistant;
  command `uncertain` by Guard, public reason `telegram_refused`.
- Bounded diagnostic recovered only the error class:
  **`Bad Request: message to delete not found`**. The Guard's live rights
  check passed; this was not `guard_rights_unproven`.
- Read-only receipt lookup for IDs 524/525/526 found Assistant receipts for
  524 and 526, but no Moderator receipt for this synthetic command.
- The [Telegram bot-to-bot documentation](https://core.telegram.org/api/bots/bot-to-bot)
  says receipt of another bot's messages depends on the addressed/reply
  context and Bot-to-Bot Communication Mode. This supports a synthetic
  visibility limitation as a hypothesis, but does **not** prove why this
  particular delete returned not-found. No BotFather/permission change or
  alternative-token deletion was attempted.
- Ordinary human-menu cleanup remains `not_run`. A real-user test in the
  closed chat is needed before generalizing this synthetic failure or
  claiming the owner-visible menu issue is closed. Do not repeat deletion
  of 524: its uncertain receipt remains fenced.

### Content assessment and measured usage

Content: **4 passed, 1 partial, 1 failed**, assessed against the frozen expectations and
the restored profile/course source, separately from delivery (6/6).
The MENU-01 answer covers goal, trigger/input, role, ordered steps, exceptions,
quality checks, human participation and output, matching process-design
material. Live link/login availability was not tested.

Actual paid usage: one `gpt-5.6-terra` answer (input 8,264; output 714) and
two `gpt-5.6-luna` analyzer calls (input 5,262; output 302); no separate
router or paid judge. Four deterministic profile/usage answers made no paid
call; the failed identity case used the analyzer but no answer model. Dollar
cost is unavailable and is not inferred from token counts.

The compound-identity mismatch is independently reproduced at the local
profile-detector seam. Existing 622 tests passed because the compound phrasing
was absent. A narrow anchored identity matcher plus positive/negative and
provider-bypass regressions is recommended; no unapproved corrective image
was deployed during this exact-source release.
CAP-03 also needs review against its predeclared account-boundary subcriterion;
the course-purpose correction works, but that omission is not a full pass.

## Scope limits and rollback

The release restores the course navigator profile and forward-only cleanup of
the proven bare command/hint pair. It does not bulk-delete legacy clutter.
Unknown/edited/unmapped targets and uncertain deletion outcomes fail closed;
substantive questions and answers are not cleanup targets.

The six source/navigation findings in
[the baseline report](2026-09-15-assistant-live-baseline.md) remain open
(`QUALITY-2`); this deploy does not change the admitted knowledge package.
Human ingress and moderation outside the closed synthetic chat are `not_run`.

Rollback image `049cc22d02aa052a5002cf8377185b1e3dcb4943`, ID
`sha256:0651c6c38001d69eb6f7e5d74d61c2ff85af94d7a7b872ef931cb351cf2d7292`,
source and mode-0600 environment remain on the host. No database restoration is
required or authorized. Rollback was not needed. After this one-time run ends,
another production operation requires a fresh exact approval.
