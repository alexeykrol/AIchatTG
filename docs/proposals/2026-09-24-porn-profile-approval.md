# Decision: actual-model acceptance then conditional runtime release

Status: **proposed, not approved**. Candidate lifecycle: `prepared`.
The 11:05UTC instruction to remove two current advertisements was executed
separately; it is not authorization for the following paid test/deploy.
[Removal receipts](../reports/2026-09-24-two-porn-posts-enforcement.md).

## Exact candidate and baseline

- Candidate: `d8e5583eb7eef51659d627ed478e0cced3ae391c`, frozen branch
  `codex/porn-profile-policy-v2-20260924`, component2.4.44 / 2026-09-24.
- Current runtime: `ccea9af5652250c159169c986f7e531ee1ac1522`, component2.4.43;
  image `sha256:203c512895a1fd1c12137695d34678b5592c06dabb3d857160e3d599fe193d97`.
- Preserve Console3.4.0 source `8a2b27fb215a19d26cf35b6244dcd4151b7cac4d`,
  image `sha256:71b8cf9afc8147fd07927af1948c6738104173331e5b9c9697febf75ddd0719b`.
- Local evidence:1,528passed/5fixture skips, migration9/9, scenario30/34,
  independent policy tests and exact detached source guard passed.

## One bounded decision

1. Authorize at most **30 real provider calls, USD2 total and30minutes** from
   evaluation start, using the existing Moderator model/vendor/effort and exact
   candidate prompts. No Telegram sends, runtime handlers, production data or
   configuration writes. Include both actual private incident texts, the14
   prelabelled synthetic controls and a frozen held-out/contrast set within
   those limits. Preserve original input; do not assert unverified translations
   are verified. Freeze input/prompt/config hashes before calls. Archived
   actual clean decisions form baseline evidence; no repeated calls to force
   a pass. Account for every stage, reserve pessimistic cost before each call,
   verify current pricing and fail closed on missing usage or unknown spend.
2. **Only if every declared acceptance case passes**, authorize GitHub push
   of the frozen source branch and reviewed main/documentation history, exact
   archive/image build and one runtime-only deployment on registered
   `news-vps`. No Console restart, model change, schema migration, secret/env,
   webhook/route, Review or host logging change. The longer recognition prompt
   changes input size, not the configured model or number of normal calls.
3. Root alone creates fresh exact leases; the deployment lease expires60minutes
   after issue and must leave20minutes for verification/recovery at activation.
   This decision is for the 24September source/date; never silently change the
   SHA or release metadata. Stop on baseline drift, technical failure, missed
   positive, false-positive control, contract rejection, timeout or budget
   limit. Changed source/authority needs a new decision, not retry-to-pass.

## Verification and safe recovery

Before activation, verify exact source/clean archive, image labels/file hashes,
offline config loader, rendered component footer and unchanged mounted schema.
After activation, check repeated health/restarts, exact version/source/footer,
config/schema/Console preservation, live Review IPC and read-only webhook/
HTTPS/auth status. Native unsolicited-message recognition is not automatically
proved by a provider-only test or by a manual delete.

Preserve the baseline image/config and all current data. The exactccea image
remains available, but a ccea binary rollback is not part of this decision:
this incident run has not tested its rollback compatibility. Do not silently
replace the approved stop/preserve boundary with an image downgrade.
If activation or
verification fails, permit only one identity-verified stop of the changed
runtime; retain data and receipts for a separately tested forward repair.
No blind database restore, old-protocol downgrade, container/daemon/host-wide
restart or automatic retry. This may temporarily pause both bot adapters in
the shared AIchatTG runtime; Console remains untouched.

Safe default without approval: keep production2.4.43, no paid calls/push/deploy;
the two authorized advertisements are already removed and their authors banned.
