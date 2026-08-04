# AIchatTG knowledge snapshots

This directory contains only a content-free manifest template. Course material,
student data, News databases and News paths must never be committed or mounted
here.

A later approved importer may create a reviewed local snapshot beside this
manifest. Every entry must have a relative path and a SHA-256 digest. The
runtime rejects symlinks, files outside this directory, invalid manifests and
digest mismatches. A missing or empty snapshot fails closed for source-grounded
Assistant routes; it cannot fall back to News or an unreviewed source.

The manifest distinguishes `course-content-v1` from `course-operations-v1`.
The latter is the only source package eligible for access, payment, community
and learning-process support. Creating or importing actual course content is a
separate content/privacy approval, not part of this port.
