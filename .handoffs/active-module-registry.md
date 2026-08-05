# AIchatTG active-module registry

Updated: 2026-08-04 21:16 PDT. Public hostname: `aikrol.questtales.com`.

| Module | Classification | Current executor | Charter / isolated worktree | Controller / result recipient | Current state |
|---|---|---|---|---|---|
| Assistant | user-visible-workstream | `AIchatTG — Ассистент — Исполнитель` (`019fd023-a940-7cf2-864a-75b20fd842ef`) | `2026-08-04-2114-assistant-executor-charter.md`; `.codex/worktrees/0f48/AIchatTG` | permanent integrator `019fd019-af89-7b50-a16d-8c7928753f24` | onboarding dispatched from `8df2a2d`; runtime is deployed, but new course knowledge and optional historical import remain gated |
| Moderator | user-visible-workstream | `AIchatTG — Модератор — Исполнитель` (`019fd023-a949-7961-87cd-693bcb893e2c`) | `2026-08-04-2114-moderator-executor-charter.md`; `.codex/worktrees/d85f/AIchatTG` | permanent integrator `019fd019-af89-7b50-a16d-8c7928753f24` | onboarding dispatched from `8df2a2d`; runtime and webhook boundary are deployed |
| Gatekeeper + onboarding | user-visible-workstream | `AIchatTG — Привратник — Исполнитель` (`019fd023-adf4-7293-bff1-9fa1fc910b66`) | `2026-08-04-2114-gatekeeper-executor-charter.md`; `.codex/worktrees/bf83/AIchatTG` | permanent integrator `019fd019-af89-7b50-a16d-8c7928753f24` | onboarding dispatched from `8df2a2d`; module is integrated, scenario remains draft and production onboarding is inactive |
| Knowledge Base | user-visible-workstream | `AIchatTG — База знаний — Исполнитель` (`019fd023-a999-71d0-841d-89b9e8504eb4`) | `2026-08-04-2114-knowledge-executor-charter.md`; `.codex/worktrees/bf7e/AIchatTG` | permanent integrator `019fd019-af89-7b50-a16d-8c7928753f24` | onboarding dispatched from `8df2a2d`; course knowledge remains disabled and unimported |
| Operator console | controller-owned shared surface | permanent integrator | — | permanent integrator | deployed at `aikrol.questtales.com`; read-only Moderator, Assistant and Tests pages |
| Telegram product core | controller-owned shared contract | permanent integrator | — | permanent integrator | shared identity, disposition, recovery and knowledge admission contracts integrated |

The Product Owner replaced the former News-era Assistant and Gatekeeper
executors with the four AIchatTG-native executor tasks above on 2026-08-04.
Their older tasks are historical provenance, not current module writers.

The News Digest Telegram **publisher** is intentionally absent: it remains a
separate News module. Service-child assurance/review tasks must not be added to
this registry.
