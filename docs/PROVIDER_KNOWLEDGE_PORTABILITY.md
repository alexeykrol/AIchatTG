# Provider and knowledge portability contract

This contract is local AIchatTG code only. It is not an approval to configure a
provider, import course material, spend funds, change a bot webhook, or deploy.
It preserves the migration boundary described in
[MIGRATION_FROM_NEWS.md](MIGRATION_FROM_NEWS.md): News paths, configuration,
credentials, databases and runtime imports are not inputs to either adapter.

## Provider adapter

`apps/telegram-runtime/src/provider-adapter.mjs` is a demand-only JSON seam for
the Moderator safety classifier and Assistant route/answer calls. The runtime
constructs it from the explicitly supplied `config.provider` object; the module
does not read `process.env`, SDK defaults or any project outside AIchatTG.

`TELEGRAM_RUNTIME_PROVIDER_ENABLED` is `false` by default. While disabled, all
three operations reject with `ProviderUnavailableError(provider_disabled)` and
do not invoke `fetch`. An enabled provider needs all of the following runtime
configuration values:

- `TELEGRAM_RUNTIME_PROVIDER_ENDPOINT` — an explicit HTTPS endpoint without
  embedded credentials;
- `TELEGRAM_RUNTIME_PROVIDER_API_KEY`;
- `TELEGRAM_RUNTIME_PROVIDER_MODEL`.

Malformed or incomplete enabled configuration produces the closed
`provider_configuration_invalid` result before a transport call. Tests inject a
fake `fetchFn`; no real provider implementation, endpoint, key, model choice,
prompt, pricing or retry policy is bundled here. The current generic request
body is `{ kind, model, input }`; a future provider-specific implementation is
a separately reviewed adapter decision.

## Knowledge admissions

Knowledge is admitted per source package, never as one broad course mount. The
runtime configuration has two independent admission records under
`config.knowledge.admissions`:

| Source package | Manifest path variable | Expected manifest identity variable |
|---|---|---|
| `course-content-v1` | `TELEGRAM_RUNTIME_KNOWLEDGE_CONTENT_MANIFEST_PATH` | `TELEGRAM_RUNTIME_KNOWLEDGE_CONTENT_MANIFEST_SHA256` |
| `course-operations-v1` | `TELEGRAM_RUNTIME_KNOWLEDGE_OPERATIONS_MANIFEST_PATH` | `TELEGRAM_RUNTIME_KNOWLEDGE_OPERATIONS_MANIFEST_SHA256` |

The expected identity contains the exact source package and the normalized
manifest digest returned by `knowledgeManifestDigest()`. The loader then checks
every manifest entry's SHA-256 digest below the explicitly configured local
root. It rejects symlinks, root escapes, unknown package IDs, missing identities,
identity mismatches, empty snapshots and malformed files. There is no fallback
to a News file, database or URL.

The route gate remains unchanged: `teach` and `navigate` can receive only a
`course-content-v1` admission; `support` can receive only a
`course-operations-v1` admission; `redirect` receives no snapshot. A successful
admission for one package cannot unlock the other.

## Provenance and next gate

The port keeps `a729ccd` as the deployed safety/Assistant behavior source and
`ef1c6ea` as the accepted course-operations routing source, as recorded in
[ASSISTANT_MODERATOR_PARITY.md](ASSISTANT_MODERATOR_PARITY.md). This portability
layer deliberately does not copy their provider configuration or course content.
The permanent AIchatTG integrator must review an exact content snapshot and an
explicit provider budget/configuration before either is enabled.
