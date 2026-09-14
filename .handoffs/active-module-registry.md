# AIchatTG active-module registry

> **Historical as of 2026-09-14.** This registry is no longer live: the Claude Code session at the repository root is the sole integrator and executor, and the Codex executors below are provenance only.
> Current governance is described in `AGENTS.md` ("Integrator and executor protocol").

Updated: 2026-08-04 22:19 PDT. Public hostname: `aikrol.questtales.com`.

> **Статус-пометка 2026-08-16.** Таблица ниже описывает организацию работы на
> 2026-08-04 (четыре исполнителя Codex в изолированных worktree) и с тех пор не
> обновлялась. Считать её **исторической**, пока владелец не подтвердит
> исполнителей заново. Что изменилось по факту и проверено:
> - **Knowledge Base:** «course knowledge remains disabled and unimported»
>   больше не верно — знание допущено и работает в бою с 2026-08-15
>   (пакет `ai-140310bf9472`, срезы `org`/`value`, образ `8579023`).
> - **Тесты:** актуальный агрегат `npm test` — 407 (403 pass / 4 skipped /
>   0 fail) под Node 20.20, а не 70/70 и 4/4 из строк ниже.
> - **Assistant:** «course knowledge … remain gated» снято тем же выкатом.
> Текущее состояние домена ведётся в `allcourses/.claude/SNAPSHOT.md` и
> `CHANGELOG.md` этого репозитория.

| Module | Classification | Current executor | Charter / isolated worktree | Controller / result recipient | Current state |
|---|---|---|---|---|---|
| Assistant | user-visible-workstream | `Ассистент — Исполнитель` (`019fd023-a940-7cf2-864a-75b20fd842ef`) | `2026-08-04-2114-assistant-executor-charter.md`; `codex/aichattg-assistant-executor-v1`; `.codex/worktrees/0f48/AIchatTG` | permanent integrator `019fd019-af89-7b50-a16d-8c7928753f24` | ready; charter and former-News provenance accepted; clean, runtime tests 70/70 passed; course knowledge and optional historical import remain gated |
| Moderator | user-visible-workstream | `Модератор — Исполнитель` (`019fd023-a949-7961-87cd-693bcb893e2c`) | `2026-08-04-2114-moderator-executor-charter.md`; `codex/aichattg-moderator-executor-v1`; `.codex/worktrees/d85f/AIchatTG` | permanent integrator `019fd019-af89-7b50-a16d-8c7928753f24` | ready; charter and former-News provenance accepted; clean, runtime tests 70/70 passed; runtime and webhook boundary are deployed |
| Gatekeeper + onboarding | user-visible-workstream | `Привратник — Исполнитель` (`019fd023-adf4-7293-bff1-9fa1fc910b66`) | `2026-08-04-2114-gatekeeper-executor-charter.md`; `codex/aichattg-gatekeeper-executor-v1`; `.codex/worktrees/bf83/AIchatTG` | permanent integrator `019fd019-af89-7b50-a16d-8c7928753f24` | ready; charter and former-News provenance accepted; clean, tests 132/132 and scenario check passed; scenario remains draft and production onboarding is inactive |
| Knowledge Base | user-visible-workstream | `База знаний — Исполнитель` (`019fd023-a999-71d0-841d-89b9e8504eb4`) | `2026-08-04-2114-knowledge-executor-charter.md`; `codex/aichattg-knowledge-executor-v1`; `.codex/worktrees/bf7e/AIchatTG` | permanent integrator `019fd019-af89-7b50-a16d-8c7928753f24` | ready; charter accepted at `8df2a2d`, clean, focused tests 4/4 passed; no former-News executor transfer; course knowledge remains disabled and unimported |
| Operator console | controller-owned shared surface | permanent integrator | — | permanent integrator | deployed at `aikrol.questtales.com`; read-only Moderator, Assistant and Tests pages |
| Telegram product core | controller-owned shared contract | permanent integrator | — | permanent integrator | shared identity, disposition, recovery and knowledge admission contracts integrated |

The Product Owner replaced the former News-era Assistant and Gatekeeper
executors with the four AIchatTG-native executor tasks above on 2026-08-04.
Their older tasks are historical provenance, not current module writers.

## Accepted former-News transfers

| Module | Source executor | Accepted handoff | SHA-256 | Acceptance |
|---|---|---|---|---|
| Assistant | News `Telegram` (`019fbf1f-e000-7ce1-a485-a01567d13225`) | `2026-08-04-2203-aichattg-assistant-worker-continuation.md` | `b8c9ac593355c89f29781716bb4379c3000dbe985a6651dcde538e439209b188` | `TRANSFER ACCEPTED: aichattg-assistant-source-provenance`; exact refs and 70/70 tests passed |
| Moderator | News `Telegram` (`019fbf1f-e000-7ce1-a485-a01567d13225`) | `2026-08-04-2203-aichattg-moderator-worker-continuation.md` | `f4e66b6c244e1faa1f78b292964f48a1857b59b390ea06cc6291e82dc952f2a8` | `TRANSFER ACCEPTED: aichattg-moderator-source-provenance`; exact refs and 70/70 tests passed |
| Gatekeeper | News `Telegram Gatekeeper` (`019fc401-2b06-7740-9c23-97f75c4e1327`) | `2026-08-04-2208-gatekeeper-to-aichattg-executor.md` | `7bb7b358bb66af2b335f4dbdf26961cce79e968e97fb7bbd8366173cbe9ac5c1` | `TRANSFER ACCEPTED: aichattg-gatekeeper-executor-v1`; exact refs, 132/132 and scenario check passed |

Knowledge Base intentionally has no former-News executor transfer. Historical
News indexes, databases, config, secrets and runtime artifacts remain rejected
as transfer inputs.

The News Digest Telegram **publisher** is intentionally absent: it remains a
separate News module. Service-child assurance/review tasks must not be added to
this registry.
