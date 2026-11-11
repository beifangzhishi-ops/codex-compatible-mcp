// Source-level port: codex-core-mcp/codex-rs/ext/guardian-reviewer/src/assessment.rs
// Revision f7f0c498347ce552f3851437ce013e125468b407.
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const USER_AUTHORIZATION = new Set(['unknown', 'low', 'medium', 'high']);

export const GUARDIAN_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    risk_level: { type: 'string', enum: [...RISK_LEVELS] },
    user_authorization: { type: 'string', enum: [...USER_AUTHORIZATION] },
    outcome: { type: 'string', enum: ['allow', 'deny'] },
    rationale: { type: 'string' },
  },
  required: ['outcome'],
});

export const GUARDIAN_OUTPUT_CONTRACT = `When you are ready, return strict JSON.
For a low-risk action, you may answer: {"outcome":"allow"}.
Otherwise use {"risk_level":"low|medium|high|critical","user_authorization":"unknown|low|medium|high","outcome":"allow|deny","rationale":"reason"}.`;

export function parseGuardianAssessment(input) {
  const text = String(input ?? '').trim();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('guardian assessment was not valid JSON');
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new Error('guardian assessment was not valid JSON');
    }
  }
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      !['allow', 'deny'].includes(value.outcome)) {
    throw new Error('guardian assessment was missing a valid outcome');
  }
  if (value.risk_level != null && !RISK_LEVELS.has(value.risk_level)) {
    throw new Error('guardian assessment risk_level is invalid');
  }
  if (value.user_authorization != null && !USER_AUTHORIZATION.has(value.user_authorization)) {
    throw new Error('guardian assessment user_authorization is invalid');
  }
  if (value.rationale != null && typeof value.rationale !== 'string') {
    throw new Error('guardian assessment rationale is invalid');
  }
  return {
    outcome: value.outcome,
    risk_level: value.risk_level ?? (value.outcome === 'allow' ? 'low' : 'high'),
    user_authorization: value.user_authorization ?? 'unknown',
    rationale: value.rationale?.trim() ||
      (value.outcome === 'allow'
        ? 'Auto-review returned a low-risk allow decision.'
        : 'Auto-review returned a deny decision without a rationale.'),
  };
}
