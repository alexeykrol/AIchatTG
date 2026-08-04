# Candidate course knowledge snapshot workflow

This is a local, candidate-side admission workflow. It creates runtime-ready
knowledge artifacts only from an explicitly supplied, human-reviewed source
export and a separate local snapshot directory. It does not query, mount, copy
or discover News files, databases, URLs, services, providers, Telegram, or
production state.

It is deliberately not an authorization to import course content. A permanent
integrator must separately review the exact source export, the generated
artifacts, privacy/content scope, target configuration and any production
release lease.

## Reviewed input contract

The JSON export must use the exact `aichattg-reviewed-course-export-v1` format:

```json
{
  "format": "aichattg-reviewed-course-export-v1",
  "provenance": {
    "sourceSystem": "reviewed-course-system",
    "sourceExportId": "reviewed-export-20260803",
    "reviewedAt": "2026-08-03T12:00:00Z",
    "reviewReference": "content-review-ticket-or-approval"
  },
  "entries": [
    {
      "id": "lesson:example-1",
      "sourceId": "course-content-v1",
      "sourceRecordId": "review-record-example-1",
      "title": "Example lesson",
      "canonicalUrl": "https://course.example.test/example-lesson",
      "visibility": "public",
      "contentPath": "content/example-lesson.md",
      "contentSha256": "REPLACE_WITH_SHA256_OF_THE_UTF8_FILE"
    },
    {
      "id": "operations:example-1",
      "sourceId": "course-operations-v1",
      "sourceRecordId": "review-record-operations-1",
      "title": "Example operations guidance",
      "canonicalUrl": "https://course.example.test/example-operations",
      "visibility": "public",
      "contentPath": "operations/example-operations.md",
      "contentSha256": "REPLACE_WITH_SHA256_OF_THE_UTF8_FILE"
    }
  ]
}
```

Every public record needs an HTTPS canonical URL, a stable source record ID,
and the SHA-256 of its UTF-8 `.md` or `.txt` file below the supplied snapshot
root. The builder rejects symlinks and root escapes. `non_public` and `removed`
records must name `null` for both content fields; they are preserved as explicit
`filtered` decisions and cannot enter a runtime manifest.

The builder blocks a candidate when a public file is empty, is only its title
(including a Markdown or HTML heading), differs from its reviewed digest,
duplicates an ID/source record, or leaves either source package empty. It never
silently converts a title, removed item, or unreviewed text into course content.

## Validate, then build a new output directory

Use Node 20.20.x. Validate before creating an artifact:

```bash
node scripts/aichattg/build-course-knowledge-snapshot.mjs \
  --validate \
  --source-export /secure-review/reviewed-export.json \
  --source-root /secure-review/reviewed-snapshot
```

The command prints an admission report with the exact input-export SHA-256,
review provenance, and per-record `admitted`, `filtered`, or `blocked`
decision. It exits nonzero if any public record is unsafe or a source package
would be empty. It does not print the source text.

Build only into a *new* directory; existing paths are refused to prevent an
in-place overwrite of a prior reviewed snapshot:

```bash
node scripts/aichattg/build-course-knowledge-snapshot.mjs \
  --source-export /secure-review/reviewed-export.json \
  --source-root /secure-review/reviewed-snapshot \
  --output-root /secure-review/aichattg-knowledge-candidate
```

The result is deterministic for identical reviewed inputs:

```text
aichattg-knowledge-candidate/
  admission-report.json
  admissions.json
  manifests/
    course-content-v1.manifest.json
    course-operations-v1.manifest.json
  snapshots/
    course-content-v1/
    course-operations-v1/
```

`admissions.json` provides one `expectedIdentity` per package:

```json
{
  "sourceId": "course-content-v1",
  "manifestDigest": "sha256 of the runtime-normalized manifest"
}
```

This pair is directly compatible with the existing
`TELEGRAM_RUNTIME_KNOWLEDGE_*_MANIFEST_PATH` and
`TELEGRAM_RUNTIME_KNOWLEDGE_*_MANIFEST_SHA256` configuration. It is not a
deployment instruction: keep both manifest paths below
`TELEGRAM_RUNTIME_KNOWLEDGE_ROOT`, provide only the reviewed digest values, and
obtain the separate product-owner approval and exact release lease before any
runtime or production change.
