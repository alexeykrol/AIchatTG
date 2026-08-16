# AIchatTG architecture

## Scope

AIchatTG is one product, not three unrelated applications. The three bot roles
share an identity, access state, audit trail, delivery discipline, and safety
policy; they differ in their Telegram credentials, permissions, and actions.

| Role | Primary responsibility | Must not own |
|---|---|---|
| Moderator | Moderation decisions and enforcement | User teaching or onboarding copy |
| Assistant | Public support and approved knowledge navigation (live since 2026-08-15) | Ban/delete authority |
| Gatekeeper | Eligibility, onboarding, access handoff | Free-form assistant conversation |

## Target components

```text
Telegram updates / signed product events
                 |
        Telegram product core
        /       |        \
Moderator   Assistant   Gatekeeper
        \       |        /
  independent bot adapters, tokens and webhook endpoints
                 |
    AIchatTG-owned database and audit/recovery records
```

The product core provides versioned contracts for user identity, chat and
membership state, eligibility/onboarding disposition, moderation disposition,
idempotent event claims, delivery receipts, and escalation state. A bot must
not bypass another bot's ownership by writing its tables directly.

## Deployment boundary

AIchatTG runs on the existing VPS as distinct services. Traefik may route the
three bot endpoints and the optional read-only host-root operator console to it; the
News Digest service remains separately built and deployed. A release must build
from one AIchatTG commit and preserve its own runtime state. It must not rebuild
`news-digest`. Course knowledge is not built here: the `allcourses` laboratory
produces a content-addressed package and two slices, and this runtime admits
them read-only by signed manifest. That path went live on 2026-08-15; a
configured slice that fails admission stops the process at start-up rather than
serving a silently empty domain.

## Deliberate non-goals

- Moving the Telegram channel publisher out of News Digest.
- Sharing a SQLite file with News Digest.
- Changing a bot webhook, Traefik rule, secret, production database, or
  sending a Telegram message during the repository extraction.
- Designing the eventual cross-project API before a concrete integration needs
  one.
