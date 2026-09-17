import { lstatSync, mkdirSync, rmdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const unavailable = () => Object.assign(new Error('review_owner_unavailable'), {
  code: 'review_owner_unavailable', statusCode: 503,
});

/** Exclusive process fence, acquired BEFORE any private SQLite open/recovery.
 * A crashed owner's directory is deliberately not recovered by PID or time. */
export function acquireModerationReviewOwner(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw unavailable();
  const valid = (path) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw unavailable();
    return stat;
  };
  const directory = valid(root), path = join(root, '.review-owner');
  try { mkdirSync(path, { mode: 0o700 }); } catch { throw unavailable(); }
  const fence = valid(path);
  let closed = false;
  const verify = () => {
    if (closed) throw unavailable();
    try {
      const current = valid(path), parent = valid(root);
      if (current.ino !== fence.ino || current.dev !== fence.dev
        || parent.ino !== directory.ino || parent.dev !== directory.dev) throw unavailable();
    } catch { throw unavailable(); }
  };
  return Object.freeze({ verify, release() {
    if (closed) return;
    verify();
    // Nonrecursive and only the exact directory this process acquired.
    rmdirSync(path); closed = true;
  } });
}
