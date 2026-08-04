import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  admitKnowledgeSnapshot,
  knowledgeManifestDigest,
} from '../../../packages/telegram-core/src/knowledge.mjs';
import {
  buildCourseKnowledgeSnapshot,
  evaluateCourseKnowledgeSnapshot,
  REVIEWED_COURSE_EXPORT_FORMAT,
} from '../build-course-knowledge-snapshot.mjs';

const builder = new URL('../build-course-knowledge-snapshot.mjs', import.meta.url);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function publicEntry({ id, sourceId, sourceRecordId, title, canonicalUrl, contentPath, content }) {
  return {
    id,
    sourceId,
    sourceRecordId,
    title,
    canonicalUrl,
    visibility: 'public',
    contentPath,
    contentSha256: sha256(content),
  };
}

function excludedEntry({ id, sourceId, sourceRecordId, title, canonicalUrl, visibility }) {
  return {
    id,
    sourceId,
    sourceRecordId,
    title,
    canonicalUrl,
    visibility,
    contentPath: null,
    contentSha256: null,
  };
}

function reviewedExport(entries) {
  return {
    format: REVIEWED_COURSE_EXPORT_FORMAT,
    provenance: {
      sourceSystem: 'reviewed-source-fixture',
      sourceExportId: 'reviewed-export-20260803',
      reviewedAt: '2026-08-03T12:00:00Z',
      reviewReference: 'fixture-review-001',
    },
    entries,
  };
}

async function fixture({ entries, files } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aichattg-course-knowledge-'));
  const sourceRoot = join(directory, 'reviewed-snapshot');
  await mkdir(sourceRoot);
  const defaultFiles = {
    'content/lesson-one.md': '# Lesson one\n\nThis is reviewed public teaching material.\n',
    'operations/navigation.md': '# Course operations\n\nUse the public course navigation menu.\n',
  };
  const allFiles = files || defaultFiles;
  for (const [relativePath, content] of Object.entries(allFiles)) {
    const target = join(sourceRoot, relativePath);
    await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    await writeFile(target, content);
  }
  const defaultEntries = [
    publicEntry({
      id: 'lesson:1', sourceId: 'course-content-v1', sourceRecordId: 'record-content-1',
      title: 'Lesson one', canonicalUrl: 'https://course.example.test/lesson-one',
      contentPath: 'content/lesson-one.md', content: allFiles['content/lesson-one.md'],
    }),
    publicEntry({
      id: 'operations:1', sourceId: 'course-operations-v1', sourceRecordId: 'record-operations-1',
      title: 'Course operations', canonicalUrl: 'https://course.example.test/operations',
      contentPath: 'operations/navigation.md', content: allFiles['operations/navigation.md'],
    }),
  ];
  const sourceExportPath = join(directory, 'reviewed-export.json');
  await writeFile(sourceExportPath, `${JSON.stringify(reviewedExport(entries || defaultEntries), null, 2)}\n`);
  return { directory, sourceRoot, sourceExportPath, entries: entries || defaultEntries, files: allFiles };
}

test('builds two deterministic runtime-compatible source packages from a reviewed public snapshot', async () => {
  const current = await fixture();
  try {
    const firstOutput = join(current.directory, 'first-output');
    const secondOutput = join(current.directory, 'second-output');
    const first = buildCourseKnowledgeSnapshot({
      sourceExportPath: current.sourceExportPath, sourceRoot: current.sourceRoot, outputRoot: firstOutput,
    });
    buildCourseKnowledgeSnapshot({
      sourceExportPath: current.sourceExportPath, sourceRoot: current.sourceRoot, outputRoot: secondOutput,
    });

    assert.equal(first.report.status, 'admissible');
    assert.deepEqual(first.report.counts, {
      total: 2,
      admitted: { 'course-content-v1': 1, 'course-operations-v1': 1 },
      filtered: 0,
      blocked: 0,
    });
    for (const sourceId of ['course-content-v1', 'course-operations-v1']) {
      const manifestPath = join(firstOutput, 'manifests', `${sourceId}.manifest.json`);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const expectedIdentity = first.admissions.admissions[sourceId].expectedIdentity;
      assert.equal(expectedIdentity.sourceId, sourceId);
      assert.equal(expectedIdentity.manifestDigest, knowledgeManifestDigest(manifest));
      assert.equal(admitKnowledgeSnapshot({ manifest, root: firstOutput, expectedIdentity }).available, true);
    }
    assert.equal(
      await readFile(join(firstOutput, 'admissions.json'), 'utf8'),
      await readFile(join(secondOutput, 'admissions.json'), 'utf8'),
    );
    assert.equal(
      await readFile(join(firstOutput, 'manifests', 'course-content-v1.manifest.json'), 'utf8'),
      await readFile(join(secondOutput, 'manifests', 'course-content-v1.manifest.json'), 'utf8'),
    );
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('filters removed and non-public records while preserving explicit provenance in the admission report', async () => {
  const current = await fixture();
  try {
    const entries = [
      ...current.entries,
      excludedEntry({
        id: 'lesson:private', sourceId: 'course-content-v1', sourceRecordId: 'record-private-1', title: 'Private lesson',
        canonicalUrl: 'https://course.example.test/private', visibility: 'non_public',
      }),
      excludedEntry({
        id: 'lesson:removed', sourceId: 'course-content-v1', sourceRecordId: 'record-removed-1', title: 'Removed lesson',
        canonicalUrl: 'https://course.example.test/removed', visibility: 'removed',
      }),
    ];
    await writeFile(current.sourceExportPath, `${JSON.stringify(reviewedExport(entries), null, 2)}\n`);
    const outputRoot = join(current.directory, 'output');
    const result = buildCourseKnowledgeSnapshot({
      sourceExportPath: current.sourceExportPath, sourceRoot: current.sourceRoot, outputRoot,
    });
    assert.equal(result.report.counts.filtered, 2);
    assert.deepEqual(result.report.decisions.filter((item) => item.decision === 'filtered').map((item) => item.reason), [
      'non_public', 'removed',
    ]);
    assert.equal(result.report.sourceExport.provenance.reviewReference, 'fixture-review-001');
    assert.match(result.report.sourceExport.sha256, /^[a-f0-9]{64}$/u);
    const manifest = JSON.parse(await readFile(join(outputRoot, 'manifests', 'course-content-v1.manifest.json'), 'utf8'));
    assert.deepEqual(manifest.entries.map((entry) => entry.id), ['lesson:1']);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('blocks title-only public content and leaves no output snapshot behind', async () => {
  const titleOnly = '# Lesson one\n';
  const current = await fixture({ files: {
    'content/lesson-one.md': titleOnly,
    'operations/navigation.md': '# Course operations\n\nUse the public course navigation menu.\n',
  } });
  try {
    const titleEntry = publicEntry({
      id: 'lesson:1', sourceId: 'course-content-v1', sourceRecordId: 'record-content-1',
      title: 'Lesson one', canonicalUrl: 'https://course.example.test/lesson-one',
      contentPath: 'content/lesson-one.md', content: titleOnly,
    });
    await writeFile(current.sourceExportPath, `${JSON.stringify(reviewedExport([titleEntry, current.entries[1]]), null, 2)}\n`);
    const evaluation = evaluateCourseKnowledgeSnapshot({
      sourceExportPath: current.sourceExportPath, sourceRoot: current.sourceRoot,
    });
    assert.equal(evaluation.report.status, 'blocked');
    assert.ok(evaluation.report.decisions.some((item) => item.reason === 'title_only_content'));
    const outputRoot = join(current.directory, 'must-not-exist');
    assert.throws(() => buildCourseKnowledgeSnapshot({
      sourceExportPath: current.sourceExportPath, sourceRoot: current.sourceRoot, outputRoot,
    }), /title_only_content/u);
    assert.equal(existsSync(outputRoot), false);

    const result = spawnSync(process.execPath, [
      builder.pathname, '--validate', '--source-export', current.sourceExportPath, '--source-root', current.sourceRoot,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /title_only_content/u);
    assert.doesNotMatch(result.stdout, /Use the public course navigation menu/u);
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});

test('blocks empty source packages, changed content and symlinked source material', async () => {
  const current = await fixture();
  try {
    const changedPath = join(current.sourceRoot, 'content', 'lesson-one.md');
    await writeFile(changedPath, '# Lesson one\n\nChanged after review.\n');
    let evaluation = evaluateCourseKnowledgeSnapshot({
      sourceExportPath: current.sourceExportPath, sourceRoot: current.sourceRoot,
    });
    assert.ok(evaluation.report.decisions.some((item) => item.reason === 'content_digest_mismatch'));

    await writeFile(changedPath, current.files['content/lesson-one.md']);
    await rm(changedPath);
    await symlink(join(current.sourceRoot, 'operations', 'navigation.md'), changedPath);
    assert.throws(() => evaluateCourseKnowledgeSnapshot({
      sourceExportPath: current.sourceExportPath, sourceRoot: current.sourceRoot,
    }), /regular non-symlink file/u);

    await rm(changedPath);
    await writeFile(changedPath, current.files['content/lesson-one.md']);
    const contentOnly = [current.entries[0]];
    await writeFile(current.sourceExportPath, `${JSON.stringify(reviewedExport(contentOnly), null, 2)}\n`);
    evaluation = evaluateCourseKnowledgeSnapshot({ sourceExportPath: current.sourceExportPath, sourceRoot: current.sourceRoot });
    assert.equal(evaluation.report.status, 'blocked');
    assert.ok(evaluation.report.decisions.some((item) => item.reason === 'source_package_empty'
      && item.sourceId === 'course-operations-v1'));
  } finally {
    await rm(current.directory, { recursive: true, force: true });
  }
});
