import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const MAX_RECENT_ENTRIES = 20;

function opaqueIdentifier(scope, value) {
  return createHash('sha256').update(`${scope}:${String(value)}`).digest('hex').slice(0, 16);
}

function countBy(db, table, field) {
  return Object.fromEntries(db.prepare(`SELECT ${field} AS key, COUNT(*) AS count FROM ${table} GROUP BY ${field}`).all()
    .filter((row) => typeof row.key === 'string')
    .map((row) => [row.key, Number(row.count) || 0]));
}

function schemaTables(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}

function hasEvery(tables, required) {
  return required.every((name) => tables.has(name));
}

function unavailable(reason) {
  return { state: 'unavailable', reason, counts: {}, recovery: {}, recentAudit: [] };
}

function openReadOnly(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 1000');
  return db;
}

function runtimeAudit(db, tables) {
  const entries = [];
  if (tables.has('runtime_inbound_update_receipts')) {
    for (const row of db.prepare(`SELECT receipt_id, status, received_at, completed_at, recovered_at
      FROM runtime_inbound_update_receipts ORDER BY received_at DESC, receipt_id DESC LIMIT ?`).all(MAX_RECENT_ENTRIES)) {
      entries.push({
        source: 'runtime', kind: 'inbound_delivery', identifier: opaqueIdentifier('runtime-receipt', row.receipt_id),
        status: row.status, at: row.completed_at || row.recovered_at || row.received_at,
      });
    }
  }
  if (tables.has('runtime_moderation_records')) {
    for (const row of db.prepare(`SELECT id, verdict, created_at FROM runtime_moderation_records
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(MAX_RECENT_ENTRIES)) {
      entries.push({
        source: 'runtime', kind: 'moderation_record', identifier: opaqueIdentifier('runtime-moderation', row.id),
        status: row.verdict, at: row.created_at,
      });
    }
  }
  return entries;
}

function gatekeeperAudit(db, tables) {
  const entries = [];
  if (tables.has('gatekeeper_invitations')) {
    for (const row of db.prepare(`SELECT id, status, updated_at FROM gatekeeper_invitations
      ORDER BY updated_at DESC, id DESC LIMIT ?`).all(MAX_RECENT_ENTRIES)) {
      entries.push({
        source: 'gatekeeper', kind: 'onboarding_case', identifier: opaqueIdentifier('gatekeeper-invitation', row.id),
        status: row.status, at: row.updated_at,
      });
    }
  }
  if (tables.has('gatekeeper_updates')) {
    for (const row of db.prepare(`SELECT update_id, state, updated_at FROM gatekeeper_updates
      ORDER BY updated_at DESC, update_id DESC LIMIT ?`).all(MAX_RECENT_ENTRIES)) {
      entries.push({
        source: 'gatekeeper', kind: 'telegram_update', identifier: opaqueIdentifier('gatekeeper-update', row.update_id),
        status: row.state, at: row.updated_at,
      });
    }
  }
  if (tables.has('gatekeeper_zapier_deliveries')) {
    for (const row of db.prepare(`SELECT delivery_key, state, updated_at FROM gatekeeper_zapier_deliveries
      ORDER BY updated_at DESC, delivery_key DESC LIMIT ?`).all(MAX_RECENT_ENTRIES)) {
      entries.push({
        source: 'gatekeeper', kind: 'integration_delivery', identifier: opaqueIdentifier('gatekeeper-delivery', row.delivery_key),
        status: row.state, at: row.updated_at,
      });
    }
  }
  return entries;
}

export function readRuntimeOverview(databasePath) {
  let db;
  try {
    db = openReadOnly(databasePath);
    const tables = schemaTables(db);
    const required = ['runtime_inbound_events', 'runtime_assistant_question_claims'];
    if (!hasEvery(tables, required)) return unavailable('runtime_schema_unavailable');
    const counts = {
      inboundEvents: countBy(db, 'runtime_inbound_events', 'status'),
      assistantClaims: countBy(db, 'runtime_assistant_question_claims', 'status'),
      inboundReceipts: tables.has('runtime_inbound_update_receipts')
        ? countBy(db, 'runtime_inbound_update_receipts', 'status') : {},
      moderation: tables.has('runtime_moderation_records') ? countBy(db, 'runtime_moderation_records', 'verdict') : {},
      dispositions: tables.has('runtime_assistant_moderation_dispositions')
        ? countBy(db, 'runtime_assistant_moderation_dispositions', 'status') : {},
      weakStrikeRecords: tables.has('runtime_moderation_weak_strikes')
        ? Number(db.prepare('SELECT COUNT(*) AS count FROM runtime_moderation_weak_strikes').get().count) || 0 : 0,
    };
    const recovery = {
      inboundReceipts: tables.has('runtime_inbound_update_receipts')
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM runtime_inbound_update_receipts WHERE status IN ('processing', 'uncertain')").get().count) || 0
        : null,
      conflicts: tables.has('runtime_inbound_update_conflicts')
        ? Number(db.prepare('SELECT COUNT(*) AS count FROM runtime_inbound_update_conflicts').get().count) || 0 : null,
    };
    return { state: 'available', counts, recovery, recentAudit: runtimeAudit(db, tables) };
  } catch {
    return unavailable('runtime_database_unavailable');
  } finally {
    db?.close();
  }
}

export function readGatekeeperOverview(databasePath) {
  let db;
  try {
    db = openReadOnly(databasePath);
    const tables = schemaTables(db);
    const required = ['gatekeeper_invitations', 'gatekeeper_updates'];
    if (!hasEvery(tables, required)) return unavailable('gatekeeper_schema_unavailable');
    const counts = {
      onboarding: countBy(db, 'gatekeeper_invitations', 'status'),
      invitationDelivery: countBy(db, 'gatekeeper_invitations', 'group_send_state'),
      updates: countBy(db, 'gatekeeper_updates', 'state'),
      siteOnboarding: tables.has('gatekeeper_site_cases') ? countBy(db, 'gatekeeper_site_cases', 'status') : {},
      integrations: tables.has('gatekeeper_zapier_deliveries') ? countBy(db, 'gatekeeper_zapier_deliveries', 'state') : {},
    };
    const recovery = {
      invitationDelivery: Number(db.prepare("SELECT COUNT(*) AS count FROM gatekeeper_invitations WHERE group_send_state IN ('intent', 'inconclusive')").get().count) || 0,
      updates: Number(db.prepare("SELECT COUNT(*) AS count FROM gatekeeper_updates WHERE state IN ('processing', 'inconclusive')").get().count) || 0,
      integrations: tables.has('gatekeeper_zapier_deliveries')
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM gatekeeper_zapier_deliveries WHERE state IN ('intent', 'inconclusive')").get().count) || 0 : null,
    };
    return { state: 'available', counts, recovery, recentAudit: gatekeeperAudit(db, tables) };
  } catch {
    return unavailable('gatekeeper_database_unavailable');
  } finally {
    db?.close();
  }
}

export function buildOperatorOverview({ config, now = () => new Date().toISOString() } = {}) {
  const runtime = readRuntimeOverview(config.runtimeDatabasePath);
  const gatekeeper = readGatekeeperOverview(config.gatekeeperDatabasePath);
  const recentAudit = [...runtime.recentAudit, ...gatekeeper.recentAudit]
    .sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')))
    .slice(0, MAX_RECENT_ENTRIES);
  return {
    schemaVersion: 1,
    product: 'AIchatTG',
    readOnly: true,
    generatedAt: now(),
    bots: {
      moderator: { database: runtime.state, flags: { ingressEnabled: config.runtimeFlags.ingressEnabled, moderationMode: config.runtimeFlags.moderationMode } },
      assistant: { database: runtime.state, flags: { ingressEnabled: config.runtimeFlags.ingressEnabled, providerEnabled: config.runtimeFlags.providerEnabled, notificationsEnabled: config.runtimeFlags.notificationsEnabled } },
      gatekeeper: { database: gatekeeper.state, flags: config.gatekeeperFlags },
    },
    runtime: { state: runtime.state, reason: runtime.reason || null, counts: runtime.counts, recovery: runtime.recovery },
    gatekeeper: { state: gatekeeper.state, reason: gatekeeper.reason || null, counts: gatekeeper.counts, recovery: gatekeeper.recovery },
    recentAudit,
  };
}
