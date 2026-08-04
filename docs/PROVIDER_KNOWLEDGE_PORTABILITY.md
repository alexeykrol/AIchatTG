# Provider and knowledge portability contract

This contract is local AIchatTG code only. It is not an approval to configure a
provider, import course material, spend funds, change a bot webhook, or deploy.
It preserves the migration boundary described in
[MIGRATION_FROM_NEWS.md](MIGRATION_FROM_NEWS.md): News paths, configuration,
credentials, databases and runtime imports are not inputs to either adapter.

## Provider adapter

`apps/telegram-runtime/src/provider-adapter.mjs` is a demand-only OpenAI Chat
Completions transport for the Moderator safety classifier
and Assistant route/answer calls. The runtime constructs it from the explicitly
supplied `config.provider` object; the module does not read `process.env`, SDK
defaults or any project outside AIchatTG.

`TELEGRAM_RUNTIME_PROVIDER_ENABLED` is `false` by default. While disabled, all
three operations reject with `ProviderUnavailableError(provider_disabled)` and
do not invoke `fetch`.

When it is enabled, the following values are all required. The values are local
AIchatTG runtime configuration only; this repository intentionally provides no
endpoint, key or model defaults.

| Purpose | Required variables |
| --- | --- |
| Provider identity and endpoint | `TELEGRAM_RUNTIME_PROVIDER_VENDOR=openai`, `TELEGRAM_RUNTIME_PROVIDER_ENDPOINT`, `TELEGRAM_RUNTIME_PROVIDER_API_KEY` |
| Moderator safety classifier tuple | Fixed: `gpt-5.6-terra`, `medium`, router cap `1024`; abuse-stage cap `768` |
| Assistant router tuple | `TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MODEL`, `TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_REASONING_EFFORT`, `TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ROUTER_MAX_OUTPUT_TOKENS` |
| Assistant answer tuple | `TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MODEL`, `TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_REASONING_EFFORT`, `TELEGRAM_RUNTIME_PROVIDER_ASSISTANT_ANSWER_MAX_OUTPUT_TOKENS` |

The endpoint must be an explicit HTTPS base URL ending exactly in `/v1`, with no
credentials, query, fragment or non-443 port; literal localhost and IP endpoints
are rejected. The only accepted vendor literal is `openai`. The Moderator tuple
is a safety-policy invariant, rather than a deployment knob: it must be
`gpt-5.6-terra` with `medium` reasoning and a router cap of 1024. Its second,
abuse-severity stage has a code-owned 768-token cap. Assistant tuples remain
independent and each needs a model identifier, one of `none`, `minimal`, `low`,
`medium`, or `high` for reasoning effort, and an integer output cap from 1
through 4096.

Each Assistant operation makes exactly one `POST` to `<endpoint>/chat/completions`
with its selected tuple. Moderator safety makes exactly one Terra/medium router
call and only for an admitted abuse route makes one Terra/medium severity call.
Both safety calls request JSON-mode output and use closed duplicate-key-safe
contracts; threat takes priority and therefore does not make a severity call.
There is no automatic retry, no parameter fallback, and no secondary provider.
A failed request is surfaced as `ProviderRequestError` with `retryable=false`.

Successful results include a content-free `receipt` containing only vendor,
operation, configured/returned model IDs, reasoning effort, HTTP status,
optional request ID, token counts, `costUsd: null` (no local price card), and
`retryCount: 0`. It never includes a prompt, question, dialogue, knowledge
snapshot, completion, API key, or response body. Tests inject a fake `fetchFn`;
no real provider request, endpoint, key, model choice, pricing decision, or
retry policy is exercised by local checks.

Malformed enabled configuration fails closed before a transport call with a
specific `ProviderUnavailableError` code such as `provider_vendor_invalid`,
`provider_endpoint_invalid`, or `provider_model_tuples_invalid`. Legacy
`TELEGRAM_RUNTIME_LLM_*` variables and the old single
`TELEGRAM_RUNTIME_PROVIDER_MODEL` variable are unsupported and ignored.

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
