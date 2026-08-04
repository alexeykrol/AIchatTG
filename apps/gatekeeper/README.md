# Telegram Gatekeeper

Standalone onboarding service for one Telegram bot and one allowlisted chat. It
does not import or modify the digest pipeline's assistant, moderation, shared
webhooks, configuration, database, Compose files, or production runtime.

## Flows

### A. Tribute + Telegram

1. The trigger is Tribute `new_subscription`: the raw request must have
   a valid `trbt-signature`, the subscription ID must be allowlisted, the price
   must be positive RUB, and the subscription must not be a trial. Telegram
   `message.new_chat_members` / `chat_member` is observed but is not evidence
   of payment and cannot create an invitation.
2. The service durably records the event and creates an opaque, expiring start
   token bound to the Telegram user and target chat. The token is reconstructed
   with a runtime HMAC key; only its hash and version are stored in SQLite.
3. The bot posts one invitation in the target chat with a deep link to its
   private chat. Product copy is edited in
   [`SCENARIO_TEXTS.md`](./SCENARIO_TEXTS.md) and mechanically synchronized into
   the validated machine catalog in
   [`ONBOARDING_SCENARIO.md`](./ONBOARDING_SCENARIO.md).
4. The user presses Start. The service binds the private sender to the opaque
   token, records `contact_established`, and sends the Tribute-specific
   instruction and product-owned links.
5. The user sends the course email as one private message. The service validates
   it, normalizes only the domain, encrypts it with an email-specific AES-GCM
   key context, stores no plaintext, uses a separately derived keyed
   fingerprint for idempotency, and then exposes the completion button.
6. The user presses the completion button. The service records `completed`,
   sends one completion event to Zapier when configured, and then completes the
   Telegram response. A repeated click sends neither event nor final DM again.

### B. Site + email (Telegram may be absent)

1. The site sends `student_registered` to the separate
   `/webhooks/site-registration` endpoint. The service verifies the exact raw
   body with a separate HMAC secret before JSON parsing.
2. The payload contains the provider event ID, occurrence time and email;
   Telegram ID/username are optional. The email is encrypted before SQLite is
   written. Plaintext payloads and email addresses are not logged.
3. Gatekeeper creates one expiring web capability and sends one
   `site_invite_requested` event to the configured Zapier hook. That payload
   includes the exact subject/body/button from the scenario and the personal
   onboarding URL, so Zapier does not own a second copy of the email text.
4. The user opens `/onboarding/site`, reads the two HTTPS resources and confirms
   completion. Gatekeeper records completion and emits one
   `onboarding_completed` event to the second Zapier hook. Exact duplicate site
   events and repeated completion submissions never retry an earlier delivery.

`SCENARIO_TEXTS.md` is the human editing surface: branch, stable point ID and
copy only, without JSON. `npm run scenario:sync` transfers that copy to the
strict machine JSON block; `npm run scenario:check` proves the two files match.
This source-of-truth contract covers contextual replies, buttons and links sent
to an onboarding user or administrator. Immutable application chrome—page and
tab titles, status labels, metric labels and technical HTTP errors—is versioned
with the UI/code and is intentionally outside the reply catalog. It is not a
second copy of an onboarding reply.
The machine Markdown is read again before
every external event or Telegram update, before that input is claimed in the
database. Saving a valid edit therefore affects the next input without a
restart. Missing or invalid content fails closed and never falls back to a
cached version. A single immutable snapshot is used for all actions caused by
one input.

The later approved public URLs use the controller-selected `AICHATTG_FQDN` and
the fixed `/gatekeeper` Compose route. This repository deliberately does not
select a hostname:

```text
https://<AICHATTG_FQDN>/gatekeeper/webhooks/tribute
https://<AICHATTG_FQDN>/gatekeeper/webhooks/site-registration
```

These endpoints deliberately do not share a payload or a signing secret.
Tribute uses `trbt-signature` with its API key; the site uses
`x-gatekeeper-site-signature` with `GATEKEEPER_SITE_WEBHOOK_SECRET`. Both can be
served by the same standalone Gatekeeper process and database after an exact
deployment, but a request can never be interpreted as the other provider's
event.

Both paths remain intentionally inactive (HTTP 404) until an exact reviewed
Gatekeeper production release is deployed. Do not configure either provider
while the checked-in active scenario is still `draft`.

The Site request body is deliberately small and provider-specific:

```json
{
  "event_id": "registration-unique-id",
  "event_type": "student_registered",
  "occurred_at": "2026-08-03T10:00:00Z",
  "email": "student@example.org",
  "telegram_user_id": 123456789,
  "telegram_username": "optional_username"
}
```

The last two fields are optional. The site computes lowercase hexadecimal
`HMAC-SHA256(GATEKEEPER_SITE_WEBHOOK_SECRET, exact-raw-body)` and sends it as
the single `x-gatekeeper-site-signature` header. Unknown keys, duplicate
signature headers, duplicate decoded JSON keys (including escaped aliases),
malformed email/IDs, reused event IDs with changed payloads, and unsigned
requests fail closed. Duplicate-key validation runs after HMAC verification and
before `JSON.parse`.

Zapier receives only allowlisted fields. The email hook receives `email`, the
personal `onboarding_url`, the scenario-owned `email_subject`, `email_text` and
`button_text`, plus stable case/event IDs and time. The completion hook receives
the case ID, source, completion time and only the available email/Telegram ID.
Both requests carry a stable `idempotency-key`; Gatekeeper makes no automatic
retry after a definite or ambiguous result.

Outbound delivery is restricted to exact HTTPS `hooks.zapier.com` URLs on the
default port. The destination hostname is resolved afresh immediately before
each request, and the request is refused if any answer is private, loopback,
link-local, carrier-grade NAT, metadata, documentation, multicast or another
special-use address. The HTTPS connection is pinned to a validated answer while
retaining `hooks.zapier.com` for TLS SNI/certificate validation, so the
transport cannot silently re-resolve to a different address. Redirect following
is disabled. There is no `NODE_ENV` or local-test bypass in runtime
configuration. The personal-link origin is a canonical HTTPS FQDN supplied
only by AIchatTG Compose from the same `AICHATTG_FQDN` used in its Traefik
router; Gatekeeper appends the fixed `/gatekeeper` public base path.

The handler follows Tribute's official webhook contract. It verifies the exact
raw request bytes with `HMAC-SHA256(GATEKEEPER_TRIBUTE_API_KEY, raw-body)` and
the `trbt-signature` header before JSON parsing. A valid paid event maps
`payload.telegram_user_id` and optional `payload.telegram_username` to the
existing invitation flow. The configured Telegram target chat is never taken
from Tribute payload data.

Tribute retries failed deliveries and may change `sent_at`. The idempotency key
and claim hash therefore use only stable provider fields and exclude `sent_at`.
Authentic but irrelevant events (another event name, a non-allowlisted tariff,
optional channel mismatch, non-RUB, trial, or zero price) return HTTP 200
`ignored` with no database or Telegram effect. An invalid signature returns
401; a malformed eligible event returns 400. The retired custom endpoint
`/webhooks/external/newcomer` is not exposed.

## Configuration

All secrets are runtime-only. Do not put them in Git.

```text
GATEKEEPER_BOT_TOKEN                  required
GATEKEEPER_BOT_USERNAME               required, without or with @
GATEKEEPER_TARGET_CHAT_ID              required
GATEKEEPER_TELEGRAM_WEBHOOK_SECRET     required
GATEKEEPER_TRIBUTE_API_KEY              required, Tribute API key used only at runtime
GATEKEEPER_TRIBUTE_SUBSCRIPTION_IDS     required, comma-separated Tribute subscriptionId allowlist
GATEKEEPER_TRIBUTE_CHANNEL_ID           optional extra defense; Tribute internal channel ID,
                                       not a Telegram chat ID
GATEKEEPER_LINK_SIGNING_SECRET         required, at least 32 characters
GATEKEEPER_DATA_ROOT                   default <this-module>/data
GATEKEEPER_DATABASE_PATH               default gatekeeper.sqlite below data root
GATEKEEPER_PORT                        default 8787
GATEKEEPER_CONTAINER_BIND              default false (loopback); only the AIchatTG
                                       Compose service sets its reviewed true value
GATEKEEPER_START_TOKEN_TTL_SECONDS     default 604800
GATEKEEPER_SITE_ENABLED                default false
GATEKEEPER_SITE_WEBHOOK_SECRET         required when Site is enabled, at least 32 characters
GATEKEEPER_SITE_TOKEN_TTL_SECONDS      default 604800, range 300..2592000
GATEKEEPER_PUBLIC_ORIGIN               canonical HTTPS FQDN origin, required when
                                       Site is enabled; Compose derives it from
                                       AICHATTG_FQDN and Gatekeeper fixes /gatekeeper
GATEKEEPER_ZAPIER_ENABLED              default false
GATEKEEPER_ZAPIER_SITE_INVITE_URL      required when Zapier is enabled,
                                       HTTPS hooks.zapier.com only
GATEKEEPER_ZAPIER_COMPLETION_URL       required when Zapier is enabled,
                                       HTTPS hooks.zapier.com only
GATEKEEPER_ZAPIER_AUTH_TOKEN           optional runtime-only Bearer token
GATEKEEPER_ZAPIER_TIMEOUT_MS           default 10000, range 1000..30000
GATEKEEPER_ADMIN_SETTINGS_TOKEN        optional, 32..256 printable ASCII characters;
                                       enables the read-only settings routes
```

Retrieve the allowed tariff IDs from Tribute's subscription list and configure
every paid tariff that should start onboarding. `GATEKEEPER_TRIBUTE_CHANNEL_ID`
is optional because it is a Tribute-internal identifier and is not the
`GATEKEEPER_TARGET_CHAT_ID` value.

Start the local service with Node 20.20.0:

```bash
npm ci
npm test
npm run scenario:check
npm run simulate:onboarding
npm start
```

`npm run simulate:onboarding` is fully local: it uses in-memory SQLite and a
fake Telegram recorder, reads the current Markdown in draft mode, and exercises
unverified membership → confirmed local payment fixture → Start → instruction
→ encrypted email → completion plus duplicate/privacy checks. It does not
require a bot token and cannot call Telegram or Tribute.

The checked-in scenario is intentionally `draft` and contains the named
`community_rules_url`, `newcomer_material_url`, and Site/email copy placeholders. No
repository evidence currently establishes the real onboarding URLs.
`npm run simulate:onboarding` is the only network-free flow that accepts a
draft; all HTTP ingress routes and Telegram webhook registration
always require `ready`. The retired `GATEKEEPER_ALLOW_DRAFT_SCENARIO` variable
is rejected, so an existing webhook cannot make a networked draft executable.
For a live candidate, replace all `[ЗАГЛУШКА: ...]`, `example.com`, and
`placeholder.invalid` links and set `status` to `ready`; a false `ready`
declaration still fails validation.
The retired `GATEKEEPER_INSTRUCTION_TEXT`,
`GATEKEEPER_INSTRUCTION_LINKS_JSON`, and
`GATEKEEPER_ALLOW_PLACEHOLDER_INSTRUCTION` variables are rejected so operators
cannot mistake them for overrides of the Markdown source of truth.

The standalone read-only Gatekeeper settings surface is
`/admin/gatekeeper`; its JSON snapshot is `/admin/settings/snapshot`. It shows
only aggregate counts and whether sources/destinations are configured. It never
returns secrets, endpoint identifiers, email, Telegram IDs or raw stored rows.
A runtime `GATEKEEPER_ADMIN_SETTINGS_TOKEN` is required for both routes. Without
it they return 404. With it they require HTTP Basic authentication using the
fixed username `gatekeeper` and the token as the password. The application
checks this boundary itself; a future reverse proxy must preserve the
`Authorization` header and must not replace or bypass this check. The service
still listens on loopback only, and this candidate does not create a public
route for the settings page.
A link from the shared News Digest navigation is intentionally outside this
module and requires the shared-interface owner.

Telegram webhook registration is deliberately separate from server startup
because it mutates external bot configuration:

```bash
node src/register-webhook.mjs
```

Rollback removes the temporary webhook without dropping queued updates:

```bash
npm run webhook:delete
```

Do not register a tunnel or send live messages without an exact approved test
window. If a Telegram delivery times out after the request may have reached the
provider, the stored delivery state is `inconclusive` and the service does not
blindly repeat it.

Entering the public `/webhooks/tribute` URL in Tribute is a separate external
configuration action and requires the same explicit test/deployment gate.

## Recovery and backup

`GET /health` exposes liveness only. Aggregate operational counts are available
through the authenticated read-only settings snapshot and the local CLI;
record-level recovery details remain local to the CLI:

```bash
npm run ops:status
```

The database and every operational or backup path must remain below the
exclusive `GATEKEEPER_DATA_ROOT`. Relative paths are resolved from that root.
The service rejects traversal, symlink escapes, the shared `news-digest.db`,
and existing SQLite files that contain non-Gatekeeper tables. Runtime data
directories are private (`0700`) and SQLite/backup files are private (`0600`).
Opening an exclusive schema-v1/v2 Gatekeeper database performs additive
migrations through v3. V2 creates `gatekeeper_private_emails`; v3 adds isolated
Site cases and Zapier delivery receipts without rewriting the existing
invitation/event/update tables. Email ciphertext, IV, authentication tag and a
keyed normalized-address fingerprint are private Gatekeeper data and are
included in normal SQLite backups. Legacy invitations remain stored and fail
closed until paid eligibility is confirmed again. A new Tribute event records
the current `tribute` source. An exact authenticated retry of a matching legacy
event may only promote that same event from the former `external_webhook` label
to `tribute`; a mismatched or unrelated legacy event never receives eligibility.

Zapier delivery rows contain only the stable delivery key, event type, internal
case ID, tri-state result and bounded provider status/error code. They contain
no email or payload body. Site event replay matching uses a secret-keyed
fingerprint, not an unkeyed payload digest, so the encrypted email cannot be
tested offline from a stolen database. Domain transitions and their Zapier
outbox intents are committed in one SQLite transaction. `intent`/`inconclusive`
deliveries are visible in the authenticated aggregate snapshot and local
operational status and are never automatically retried.

Private email-message recovery stores only Telegram identifiers and an empty
sentinel, never the candidate address. Its update idempotency field contains a
keyed digest rather than a plain hash, so the address cannot be tested against
the database offline. A confirmed-absent Telegram response can therefore be
replayed without retaining or re-entering the email.

### Personal-data classification

Email is confidential onboarding data: Gatekeeper encrypts it at rest and uses
only secret-keyed fingerprints. Telegram numeric user/chat IDs, usernames and
display names are restricted operational routing metadata. They remain
plaintext inside the isolated private SQLite database because Telegram
destination matching, idempotency, recovery and auditable delivery require the
exact identifiers. They are not returned by the admin UI, published, or placed
in Zapier payloads except that an available numeric Telegram user ID may be
included in the allowlisted completion event. Database and backup modes remain
`0600` below a `0700` exclusive data root. This is the candidate's explicit
data classification; changing it requires a separate schema/privacy decision.

Before runtime changes, create a WAL-aware SQLite backup to a new destination
below the same data root:

```bash
GATEKEEPER_BACKUP_PATH=backups/new-backup.sqlite npm run ops:backup
```

An `intent` or `inconclusive` group send is never retried automatically. After
checking Telegram manually, resolve it as either delivered or absent:

```bash
GATEKEEPER_RESOLUTION_CONFIRMED=true \
  npm run ops:resolve-delivery -- <invitation-id> sent <message-id>

GATEKEEPER_RESOLUTION_CONFIRMED=true \
  npm run ops:resolve-delivery -- <invitation-id> not_sent
```

When the prior side effect was delivered, also close the corresponding
uncertain update without replaying it:

```bash
GATEKEEPER_RESOLUTION_CONFIRMED=true \
  npm run ops:resolve-update -- <update-id>
```

If a stored update itself is `processing`, `failed`, or `inconclusive`, replay
it only after confirming the prior side effect was absent. Resolve any uncertain
group delivery first:

```bash
GATEKEEPER_REPLAY_CONFIRMED_ABSENT=true \
  npm run ops:replay-update -- <update-id>
```

For a completion update whose final DM was separately confirmed absent, add
`GATEKEEPER_REPLAY_COMPLETION_DM_CONFIRMED_ABSENT=true` to that replay command.
Only this extra, operator-controlled gate sends the missing completion DM. An
ordinary repeated callback, and a generic replay without this extra gate, send
no second DM. Once completion has been persisted, any Telegram failure in the
callback/DM sequence remains `inconclusive` even when the provider definitely
rejected one call. This prevents a normal provider retry from consuming the
only operator-recoverable update without sending the final DM.

These commands are recovery tools, not automatic retries. `ops:replay-update`
can send a real Telegram message and therefore requires the same explicit
external-action gate as normal live testing.
