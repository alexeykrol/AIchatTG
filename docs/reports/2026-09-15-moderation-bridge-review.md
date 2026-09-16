# Moderator live bridge — root contract review

Status: proposed; architecture/privacy decisions pending. Documentation only.
This is not an accepted implementation candidate or production authorization.
Accepted local feature remains1829573/Console3.3.0 (`prepared`); current last
verified production is Console3.2.0/f650fe8 and runtime335a35a, with closed lease.

## Grounded evidence

`passed`: both offered documents were read completely and copied unchanged into
canonical `docs/proposals/`; SHA-256 values match:

- Contract: `cd4859801a8be05a7a5e85cdab0acd42babe325f9bc714ae52a9135ffbd4aa5f`.
- Acceptance plan: `8a7184c9eefe91efbe40a69773e1ecf675aa1ee2733bd99c6aec79bf66b143d3`.

The current HTTP server calls `runtime.handleUpdate` after authentication/JSON
parsing; Review is not on that critical path. The current Review erasure deletes
the case and linked evidence and retains the agreed minimal erasure receipt.
Root verified these source facts directly. The proposed54 test scenarios have
not been executed and are not added to the accepted905-test result.

## Decisions required before accepting the affected implementation

1. **Protection versus review availability.** The offered pre-runtime admission
   returns503 before Guard handling if Review storage is down/full/uncertain.
   This would introduce a new dependency capable of delaying primary chat
   protection. It is outside the preserved-independent-Guard charter.
   Root recommends preserving primary moderation even if some review intake
   is unavailable, with an explicit visible coverage gap. That choice needs a
   revised contract: no silently equivalent promise of complete capture and no
   unapproved raw-data buffer or webhook behavior change. Ask the PO to confirm
   the priority; do not activate the offered blocking design by default.

2. **What remains after erasure.** The proposal retains pseudonymous HMAC event/
   native keys indefinitely to prevent restored intake, including all future
   edits of an erased native message. These are retained identifiers, not
   anonymous data or the currently approved minimal receipt. Ask the PO whether
   this closed technical-marker retention and future-edit suppression are
   wanted. Purpose, duration/capacity, stable key handling, copies/restore and
   authorized access still need exact implementation/live configuration review.
   Without acceptance, retain current erasure semantics and do not silently
   replace them with permanent suppression or a weaker replay guarantee.

These choices authorize neither real collection nor deployment. Actual reviewer,
private recipient, approved chats/start/fields/limits, concrete IPC ownership,
backups and exact source/config/rollback/lease remain separate live gates.

## Mandatory corrections found by independent review

`failed` as a contract claim: the proposed fallback says an opaque ordered
checkpoint rejects previously consumed envelopes, while the same contract has
no producer sequence and accepts out-of-order update IDs. A receiver-only
intakeSeq is absent from a retried request after a lost commit response and
cannot deduplicate it by itself. Remove that guarantee or specify a separately
reviewed durable ordered source protocol. No weak alternative is approved.

The proposed marker-capacity and in-flight-send refusals add restrictions on
manual erasure not present in acceptedv3. Do not silently adopt them. The revised
contract should reserve necessary deletion capacity at admission and explicitly
resolve concurrent generic notification behavior without indefinitely preventing
owner erasure; any remaining restriction must be disclosed for acceptance.

Independent source review `passed` in identifying these boundaries. No bridge
behavior tests were run. Worker may write a new documentation-only correction
addendum; original artifacts/hashes stay immutable. This is not permission for
the privacy or availability changes themselves.

## Current disposition

Proposal retained for provenance and decision-making, not accepted for bridge
implementation. No source reservations, production handoff or new lease were
issued. The worker is informed to preserve frozen code and await a revised
accepted charter. Existing review-only synthetic source and production stay
unchanged. Root will convert the PO choices into a versioned addendum and bounded
local implementation charter; routine routing remains root-owned.

`not_run`: new bridge code/tests, SSH/production diagnostics, actual recipient
checks, provider/Telegram calls, secret use, storage changes or deployment.
