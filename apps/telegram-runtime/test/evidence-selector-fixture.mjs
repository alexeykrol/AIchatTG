import assert from 'node:assert/strict';

// Positive, injected-label fixtures only. Never use this to repair or transform
// malformed semantic-parser cases: those must exercise the original raw JSON.
export function selectorFixture(input, semanticJson) {
  if (input.stage && input.stage !== 'router') return semanticJson;
  const user = typeof input.user === 'string' ? JSON.parse(input.user)
    : JSON.parse(input.messages[1].content);
  const entries = user.evidence_catalogue?.entries;
  assert.ok(Array.isArray(entries), 'router invocation must supply its own evidence catalogue');
  const verdict = JSON.parse(semanticJson);
  for (const domain of ['threat', 'abuse']) {
    verdict[domain].evidence = verdict[domain].evidence.map((span) => {
      assert.ok(user.message.includes(span), 'fixture evidence must already be verbatim');
      const entry = entries.find((item) => item.text === span)
        || entries.find((item) => span.includes(item.text));
      assert.ok(entry, `positive fixture needs a catalogue-contained excerpt: ${JSON.stringify(span)}`);
      return entry.id;
    });
  }
  return JSON.stringify(verdict);
}
