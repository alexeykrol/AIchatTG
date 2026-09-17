/** Explicit, offline, one-time empty-store provisioning. This never starts a
 * collector, IPC listener, timer, Telegram client or runtime database. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModerationReviewBinding, reviewCapturePolicy } from '../../../packages/telegram-core/src/moderation-review-config.mjs';
import { createModerationReviewStore } from './moderation-review-store.mjs';

export function provisionModerationReview(args) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--provision' || typeof args[1] !== 'string' || !args[1]) {
    throw new Error('review_provision_explicit_binding_required');
  }
  const { binding } = loadModerationReviewBinding(args[1]);
  if (!binding) throw new Error('review_binding_unavailable');
  let ancestor = binding.storeRoot;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) throw new Error('review_provision_root_unsafe');
  const present = lstatSync(binding.storeRoot, { throwIfNoEntry: false });
  if (present && (!present.isDirectory() || present.isSymbolicLink() || readdirSync(binding.storeRoot).length)) {
    throw new Error('review_provision_requires_fresh_store');
  }
  const store = createModerationReviewStore({ root: binding.storeRoot, mode: 'live',
    limits: binding.limits, capturePolicy: reviewCapturePolicy(binding), maxEvents: binding.maxEvents,
    maxErasureReceipts: binding.maxErasureReceipts, maxAlertsPerHour: binding.maxAlertsPerHour, provision: true });
  try {
    const status = store.status();
    return { status: 'provisioned', schemaVersion: 2, counts: status.counts,
      collectionStarted: false, deliveryStarted: false };
  } finally { store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(provisionModerationReview(process.argv.slice(2)))); }
  catch { console.error('review_provision_failed; preserve existing files and inspect offline'); process.exitCode = 1; }
}
