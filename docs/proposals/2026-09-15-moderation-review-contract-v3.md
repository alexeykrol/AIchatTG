# Moderation Review contract v3 — root review corrections

Read contracts v1, v2 and this addendum together; the newest definition wins.
All implementation remains local synthetic only, protected root files untouched.

## Accepted root changes

1. Every new HTTP path uses the versioned prefix
   `/api/operator/moderation-review/v1` (replaces v1's unversioned prefix).
   Legacy `/api/moderation/*` writes remain rejected.
2. `insufficient_evidence` records an immutable human audit decision only.
   It creates **no** draft example: decision response `patternDraftId:null`.
   Only `hidden_advertising` and `legitimate` create versioned positive/negative
   drafts. There is still no training, activation or self-approval.
3. Decision request replay binds case, evidence version, decision ID, label,
   note and authenticated principal; any mismatch fails closed with 409.
4. Manual erasure retains only a content-free receipt containing opaque case ID,
   request ID, authenticated principal, numeric `expectedVersion`, deletion
   time and `erased:true`. Exact same-request retry succeeds; a mismatched
   version/principal/target/request ID conflicts. All linked raw text, hashes,
   revisions, notes, examples, delivery payload/receipt and context are removed.
5. SQLite `secure_delete` is a precaution, **not** a guarantee of physical
   erasure from filesystem snapshots, backups, storage devices or exports.
   The UI promises removal from the Review store only. No private-data backup
   or export feature exists in this slice; any production copies need explicit
   retention/deletion handling before collection starts.
6. The trusted `operator` principal is for the synthetic harness only. This
   does not establish the real owner/reviewer identity or production authority.

## Clarified module interfaces

- A negative detector result has the same shape with empty pattern/reason/
  related-message arrays. Fingerprint is a versioned, same-chat SHA-256 of
  normalized text; unrelated native IDs/user IDs do not make new fingerprints.
  Normalization must not erase product/URL identity and merge unrelated ads.
- Alert sender receives only `{text,url}`. `{ok:true,receipt?}` is sent;
  `{ok:false,definite:true}` is failed; other returns/exceptions are uncertain.
  Persist only an explicitly allowlisted opaque receipt identifier, not raw
  provider response/error bodies. Transport is fake/injected, not Telegram.
- `maxObservations` is a total retained revision bound. Reaching it rejects
  new intake, including edits, without silently evicting prior evidence.
- Inherited code-owned fixture character caps are explicitly synthetic, not
  approved production evidence limits. All code paths record truncation.
