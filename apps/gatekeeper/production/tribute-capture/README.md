# Tribute capture-only service

This is a standalone, temporary capture service. It has no dependency on the
News runtime, Gatekeeper database, Telegram, publishing code, provider SDKs, or
any third-party client.

## Contract

- Traefik receives only `POST https://news.questtales.com/webhooks/tribute`
  through the exact host-and-path router rule in `docker-compose.yml`.
- The service is in the `tribute-capture` Compose profile and defaults to
  disabled. Traefik does not expose its router unless the explicit runtime
  flag is true, and the process accepts no body unless both runtime values are
  present:
  `TRIBUTE_CAPTURE_ENABLED=true` and a non-empty
  `TRIBUTE_CAPTURE_HMAC_KEY`.
- Before JSON parsing, it holds at most 16 KiB of raw request data and requires
  exactly one `trbt-signature: <64-hex-hmac>` header (case-insensitive header
  name; bare hex value, no prefix), where the HMAC is HMAC-SHA256 over the
  exact raw bytes.
- A valid signed JSON request returns `202` and atomically creates the one
  private receipt permitted by this service. Later valid requests return
  `409` and create nothing, including after a restart. A receipt contains only
  an ID, timestamp, byte count, verified flag, valid-JSON flag and shape, plus
  an optional identifier-safe `event_name` taken only from `event`,
  `event_name`, `event_type`, or `type`. It never contains the body,
  arbitrary JSON fields/values, request headers, provider signature, body hash,
  name, email, URL, or other payload PII. Invalid, oversized, malformed, and
  disabled requests write no receipt.
- The service has no outbound HTTP calls. Its only persisted state is the
  dedicated `tribute-capture-receipts` Docker volume.

## Local verification

~~~bash
PATH=/Users/alexeykrolmini/.nvm/versions/node/v20.20.0/bin:$PATH npm --prefix news-digest-pipeline/telegram-gatekeeper/production/tribute-capture test
docker compose -f news-digest-pipeline/telegram-gatekeeper/production/tribute-capture/docker-compose.yml config --no-interpolate
~~~

No key is committed, generated, logged, or placed in a local `.env` file.

## Operations boundary

This repository change does not authorize Compose startup, route activation,
runtime key injection, a Tribute request, deployment, or cleanup. A future
one-time controller lease must specify the exact Git SHA, `tribute-capture`
profile, host and route, runtime-only key injection, at most one request,
30-minute expiry, receipt/volume cleanup, rollback, and stop conditions.
