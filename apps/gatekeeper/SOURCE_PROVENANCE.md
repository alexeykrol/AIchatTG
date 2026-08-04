# Gatekeeper source provenance

This directory is a mechanical local port from the Telegram Gatekeeper source
tree below. It is not a new implementation and it has not been connected to
any bot, domain, webhook, secret, or production runtime.

- Source repository: `/Users/alexeykrolmini/Code/News`
- Source Git object: `dbc492f85d7b8f96e601829de4fd369034a47787`
- Source path: `news-digest-pipeline/telegram-gatekeeper/`
- Source candidate: `origin/codex/telegram-gatekeeper-site-zapier-v1`
- Source candidate state: controller-accepted only; live DNS, HTTPS, Zapier,
  Site, Telegram, production deployment, and reverse-proxy activation were
  not run for this candidate.
- Source content manifest: `53c7b9c2eeaae21dedf5804cfea8e8c4581ad79c347c7a7316796781a0a39c38`
  calculated by byte-sorting changed paths and hashing the concatenated
  candidate Git blob bytes.

The local port has two deliberately mechanical adaptations: its package is
renamed from `@news/telegram-gatekeeper` to `@aichattg/gatekeeper`, and
`test/config.test.mjs` uses a location-independent scenario-path assertion
instead of assuming the former `telegram-gatekeeper/` filesystem path. No
runtime behavior, cryptographic derivation, scenario ID, or SQLite application
identifier was changed.

## Isolation promise

- Gatekeeper uses its own data root, database and runtime configuration.
- It must never open or write the Digest database.
- It does not own Telegram channel publishing; that remains in the Digest
  project.
- This port carries no credentials and does not activate a webhook.
