# Suspected porn-spam policy — production receipt

Lifecycle: `production-verified`. Exact runtime source
`a41518f4a4fd105cf19e7fc1a64fd35b77233084`; Assistant **2.4.38 / 2026-09-16**.
One runtime recreation, zero rollbacks. Console remains **3.2.0 / f650fe8**.

## Authority and scope

The Product Owner answered «Да, подтверждаю.» to the exact-source, runtime-only,
three-current-chat release and irreversible-sanction/input-cost decision.
The asking task «Модератор» witnessed and relayed the answer in turn
`01a0a871-1515-75d3-905a-7156d240dc59`, started2026-09-16T04:19:38Z.
This is a turn ID, not a message ID; root does not claim a direct message-body
reread through the thread reader.

Root issued one-time lease `porn-spam-a41518f-20260916`,
04:21:40–04:51:40UTC, with root as the sole remote owner. It allowed one forward
runtime recreation and at most one image-only rollback on verified application
failure with healthy transport. Earlier admission deadlines and a final
remaining-time check were added to both operational helpers after independent
review; the lease was not extended.

The existing semantic moderation prompt now includes the versioned suspected
porn-spam supplement. A valid `spam_or_scam` verdict uses the existing immediate
ban/cleanup route, without a warning/review wait. No model, output limit,
configuration, schema, route, Guard/action implementation or provider stage
changed. The longer prompt can increase input cost on existing calls, as
disclosed and approved. Same three current chats; no replay or backfill.

Excluded: Console recreation, private Review/capture/notifications, Gatekeeper,
News, secrets/migrations, new paid or Telegram tests, real-person sanction
tests, `/ask` incident repair and the future cross-role judging architecture.

## Exact source and activation

- Reviewed main history through `c014530e28147ecfaad168e8f1402c38fa76dc19`
  was pushed; GitHub `refs/heads/main` matched before activation. Deploy source
  is the exact ancestor a41518f, not a dirty tree or a docs-overlay release.
- Clean detached source gate against335a35a passed. Exact Git archive SHA-256:
  `f90ca21018d75234c5c3ef32e8436483a05c518584d26d1b29df15fdbd174ee1`.
- Fresh baseline04:24:34UTC: runtime335a35a and Consolef650fe8 healthy/restart0.
  Private runtime env copied byte-for-byte, mode0600. Rendered runtime config
  matched the existing container before build and again immediately before up.
- Runtime-only exact image build succeeded; one exclusive activation marker
  recorded2026-09-16T04:32:23.262987Z. `up --no-build --no-deps` recreated only
  `aichattg-telegram-runtime`.
- Image ID:
  `sha256:dd64eee020fa3c04a93c4c0da558dbc8b7ba84fad295d026aa66dc39218d48c6`.
- Container ID:
  `85ce97848b88637877af4c43c9dfbf5ea963c63373f924676c58800204a62c2d`.
  StartedAt **2026-09-16T04:32:23.874617151Z**.

## Verification

`passed`: local Node20.20.0 suite951total/946passed/5explicit fixture skips/
0failed; migration9/9, scenario30machine/34human, isolation, whitespace and
independent policy/helper review. See [candidate evidence](2026-09-16-porn-spam-policy-candidate.md).

`passed`: production checks at04:32:42,04:33:16 and04:34:18UTC:

- Runtime healthy, restart0; exact image source label and unchanged image on
  subsequent checks. SQLite quick_check=ok and schema hash unchanged.
- Same runtime environment, private env-file hash, mounts, routes, logging,
  live mode and chat allowlists. Entire Console snapshot unchanged: source,
  image, container ID, start time, health, restart count, config and mounts.
- First two manifests compared48 runtime/core source files. The final manifest
  expanded to the entire copied core package, matching **58 files**, including
  its ten README/package/test files. Counts describe different coverage, not
  missing files. Domain artifacts are included under runtime/src.
- Loaded policy hash exactly
  `3d7cdbcc8323c406fe9b5e1f79dc9b48575b1c1e25d1e959319824912324ee9e`.
  In-image fake-fetch transport rendered the code-owned footer
  `Версия 2.4.38 от 16.09.2026`; no external request was possible through it.
- Internal health200; public HTTPS health200 and unauthenticated empty
  Moderator/Assistant webhook probes401/401 at04:32:43UTC. No valid update sent.
- Exact rollback335a35a image retained with current database preserved.

`not_run`: real-model recognition/precision/recall, live sanction test, new
paid/Telegram acceptance, historical replay or `/ask` repair. Synthetic labelled
outputs prove contract/enforcement behavior, not semantic detection accuracy.

Lease consumed/closed and sole SSH master closed **04:34:43UTC**, socket absence
verified. No Docker-log reader, detached diagnostic, extra master or rollback.
Independent Moderator-controller review of the retained baseline/lease,
activation, final verification, HTTPS and closure receipts accepted this result
without remote access and physically confirmed that the local socket is absent.

## Limitations and next work

Cleanup remains at most100 oldest eligible locally known same-chat/author
messages plus current, deduplicated (max101), not a full Telegram history
search. Other known messages from that author can be removed. Code rollback
cannot restore deleted messages or automatically unban users.

Native formatting-only quotation provenance is not supplied to the model; the
existing hard-link rule can still sanction a legitimate URL-containing report.
Invalid/unknown provider results and Guard failures retain fail-closed behavior.

The `/ask` router-contract rejection, no-silence/30-second prompt UX proposal,
and Assistant-judges/Moderator-enforces design remain separate unfinished work.
Private Review3.3.0 source is pushed but not deployed or collecting/sending;
its two bridge policy decisions remain open. See [release queue](../RELEASE_QUEUE.md).

## Retained receipts

Content-free receipts remain locally in ignored `output/porn-spam-policy-v1/`;
activation/config and verification receipts also remain in this exact remote
release directory. Private chat IDs/config and raw transcripts are not in Git.

| Receipt | SHA-256 |
| --- | --- |
| baseline.json | `27cb88dfc262969d7ebc5f9482133df2dff129054cff380d514c560c55c90f08` |
| activation-start.json | `977a16de851d348439cf083be2f561b83d192baecf8213c7185e4585cf707932` |
| activation-preflight.json | `8863f03df5363a8dc2d5fc98d045490a3a1372f06a957433088cb972e0e01582` |
| postverify-expanded.json | `59006bdeb7f38090eeee554464873ad968dc9bf755310e03578f1f62c734e51b` |
| public-check.json | `7aa08b839965d584ffb86d34b3565ca8a0fe2535ee2bd627e089c42ff6919d0c` |

Local `closure.json` records the consumed lease and verified socket absence;
SHA-256 `78648b86a29e33493531623adc31a4fcbc956e6aaa1ed27d38dd869ce7fb34e1`.
`lease.json` is an immutable issuance-only snapshot: its original `active`
field is superseded by `closure.json`, not continuing production authority.
