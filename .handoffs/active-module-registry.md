# AIchatTG active-module registry

Updated: 2026-08-04. Public hostname: `aikrol.questtales.com`.

| Module | Classification | Current executor | Controller / result recipient | Current state |
|---|---|---|---|---|
| Moderator + Assistant runtime | user-visible-workstream | `Telegram assistant — Executor 2` (`019fbf1f-e000-7ce1-a485-a01567d13225`) | permanent integrator | AIchatTG runtime and webhook boundary deployed; new course index and optional historical import remain pending |
| Gatekeeper + onboarding | user-visible-workstream | `Telegram Gatekeeper` (`019fc401-2b06-7740-9c23-97f75c4e1327`) | permanent integrator | standalone module integrated; scenario remains draft and production onboarding is not active |
| Operator console | controller-owned shared surface | permanent integrator | permanent integrator | deployed at `aikrol.questtales.com`; read-only Moderator, Assistant and Tests pages |
| Telegram product core | controller-owned shared contract | permanent integrator | permanent integrator | shared identity, disposition, recovery and knowledge admission contracts integrated |

The News Digest Telegram **publisher** is intentionally absent: it remains a
separate News module. Service-child assurance/review tasks must not be added to
this registry.
