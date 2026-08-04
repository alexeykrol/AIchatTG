const state = document.querySelector('#state');
const bots = document.querySelector('#bots');
const counts = document.querySelector('#counts');
const recovery = document.querySelector('#recovery');
const audit = document.querySelector('#audit');

function el(tag, text) { const node = document.createElement(tag); node.textContent = text; return node; }
function json(value) { return JSON.stringify(value, null, 2); }

function renderBot(name, detail) {
  const card = document.createElement('article'); card.className = 'card';
  card.append(el('h2', name));
  const badge = el('span', detail.database); badge.className = `badge ${detail.database === 'available' ? '' : 'unavailable'}`;
  card.append(badge);
  card.append(el('pre', json(detail.flags)));
  bots.append(card);
}

try {
  const response = await fetch('api/v1/overview', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const overview = await response.json();
  state.textContent = `Read-only snapshot: ${overview.generatedAt}`;
  renderBot('Moderator', overview.bots.moderator);
  renderBot('Assistant', overview.bots.assistant);
  renderBot('Gatekeeper', overview.bots.gatekeeper);
  counts.textContent = json({ runtime: overview.runtime.counts, gatekeeper: overview.gatekeeper.counts });
  recovery.textContent = json({ runtime: overview.runtime.recovery, gatekeeper: overview.gatekeeper.recovery });
  for (const row of overview.recentAudit) {
    const tr = document.createElement('tr');
    for (const value of [row.source, row.kind, row.identifier, row.status, row.at]) tr.append(el('td', value || '—'));
    audit.append(tr);
  }
} catch {
  state.textContent = 'The read-only status is unavailable.';
}
