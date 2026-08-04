# AIchatTG active-module registry

Updated: 2026-08-03. This is the target-project registry; it does not confer
production authority while AIchatTG remains locally prepared.

| Module | Classification | Current executor | Controller / result recipient | Current state |
|---|---|---|---|---|
| Moderator + Assistant runtime | user-visible-workstream | `Telegram assistant — Executor 2` (`019fbf1f-e000-7ce1-a485-a01567d13225`) | permanent integrator | independent local core integrated at `7a40212`; knowledge/provider parity and live cutover remain pending |
| Gatekeeper + onboarding | user-visible-workstream | `Telegram Gatekeeper` (`019fc401-2b06-7740-9c23-97f75c4e1327`) | permanent integrator | source ported locally from `dbc492f`; no active lease or external endpoint |
| Telegram product core | controller-owned shared contract | permanent integrator | permanent integrator | seam documented; implementation pending |

The News Digest Telegram **publisher** is intentionally absent: it remains a
separate News module. Service-child assurance/review tasks must not be added to
this registry.
