# Moderation Review contract v5 — complete retained evidence

Root acceptance correction to v1–v4; synthetic/local only. The newer rule wins.
No production storage, collection, reviewer identity, limits or delivery is
authorized by this document.

## Evidence completeness

- Detection receives only the text/context actually retained in the private
  store. Original full-input hashes are used only to reject conflicting native
  revisions, never as evidence for a detector claim.
- If source text or context was clipped, the new observation introduces no
  suspicion, reason, repeat claim or alert. It remains visible with truncation
  flags and manually erasable as a retained observation.
- Such latest observations cannot corroborate repetition, become a grouping
  anchor through fingerprint fallback, or donate evidence to another case.
- Fingerprint fallback is removed entirely: only qualified detector-related
  latest messages may locate a shared case. Stale fingerprints after edits,
  exercise exclusions and future-dated observations are not grouping proof.
- A later complete revision of the same native message remains in its own
  existing case and may be assessed with visible complete evidence. Prior human
  decisions and historical evidence are preserved; no automatic retraction or
  relabeling of historical records is implied.
- Existing complete cases continue to group exact repeats within the same chat;
  reviewed/pending cases are not donor cases. Full-input revision-collision
  protection remains intact even when retained prefixes are identical.

## Synthetic preview safety

The demo accepts only an absent path or a fresh empty real directory. Nonempty
directories, symlinks and files are rejected before changing permissions,
creating a database or inserting fixture records. Store path safety still
applies. This local preview must never be connected to production data.

## Disabled root mount

The integrated server mounts the versioned Review handler after existing Basic
authentication, without a store, origin or collector. Authenticated status has
mode `disabled`, all capabilities false and counts null. Known case/history/
pattern/decision/erase routes return503; no ingestion route exists. Existing
legacy write rejection, Analytics, auth and release metadata stay intact.

Console3.3.0 identifies this local source slice only; production remains3.2.0
until a separate exact scope and release lease are accepted. A disabled mount
does not complete or activate the future private moderation workflow.
