import { classifySafetyV3 } from '../src/safety-v3.mjs';

function routerJson({
  threat = false, threatTypes = [], threatEvidence = [],
  abuse = false, abuseTypes = [], abuseEvidence = [],
  confidence = 0.98,
} = {}) {
  return JSON.stringify({
    threat: { match: threat, types: threatTypes, confidence, evidence: threatEvidence },
    abuse: { match: abuse, types: abuseTypes, confidence, evidence: abuseEvidence },
    target: threat || abuse ? 'participant' : 'none',
    context_used: false,
  });
}

function literalEvidence(message) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new TypeError('safety fixture requires non-empty raw message text');
  }
  return message.trim().slice(0, 240);
}

/**
 * Produce the exact strict v3 semantic contract used at the judgement
 * submission boundary. This deliberately exercises `classifySafetyV3` instead
 * of returning a hand-written safetyTrace, so runtime tests cannot silently
 * drift from parser/evidence/severity validation.
 */
export async function safetyVerdict({
  message,
  safetyRoute = 'clean',
  abuseLevel = null,
  confidence = 0.98,
  context = {},
} = {}) {
  const evidence = literalEvidence(message);
  if (!['clean', 'abuse', 'threat'].includes(safetyRoute)) {
    throw new TypeError(`unsupported fixture safety route: ${safetyRoute}`);
  }
  if (safetyRoute === 'abuse' && !['weak', 'strong'].includes(abuseLevel)) {
    throw new TypeError('abuse fixture requires weak or strong abuseLevel');
  }
  if (safetyRoute !== 'abuse' && abuseLevel != null) {
    throw new TypeError('only abuse fixture may provide abuseLevel');
  }

  const replies = safetyRoute === 'clean'
    ? [routerJson({ confidence })]
    : safetyRoute === 'threat'
      ? [routerJson({ threat: true, threatTypes: ['interpersonal_threat'], threatEvidence: [evidence], confidence })]
      : [
        routerJson({ abuse: true, abuseTypes: ['targeted_insult'], abuseEvidence: [evidence], confidence }),
        JSON.stringify({
          severity: abuseLevel,
          confidence,
          basis: abuseLevel === 'weak' ? 'isolated_disrespect' : 'severe_personal_degradation',
        }),
      ];
  return classifySafetyV3({
    message,
    context,
    async invoke() { return { text: replies.shift() }; },
  });
}
