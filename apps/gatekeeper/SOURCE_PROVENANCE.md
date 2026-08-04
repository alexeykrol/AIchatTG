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

The first local port renamed the package and removed location assumptions.
Later AIchatTG commits added the validated scenario catalog, Site/Zapier
contracts and standalone deployment boundaries. The immutable source object
above remains provenance for the imported baseline; current behavior is defined
by this repository's Git history and tests.

## Isolation promise

- Gatekeeper uses its own data root, database and runtime configuration.
- It must never open or write the Digest database.
- It does not own Telegram channel publishing; that remains in the Digest
  project.
- This port carries no credentials and does not activate a webhook.
