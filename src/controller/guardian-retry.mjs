// Source-level adaptation: codex-core-mcp/codex-rs/ext/guardian-reviewer/src/retry.rs.
// A retry restarts the model's review session under the same shared deadline.
// CCM's owner-approved writable reviewer tools must never be replayed on retry.
import { setTimeout as sleep } from 'node:timers/promises';

export function mayRetryGuardian(error, { toolInvocations = 0 } = {}) {
  if (toolInvocations > 0) return false;
  if (error?.guardianKind === 'parse') return true;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return false;
  if (error?.httpStatus && [408, 429].includes(error.httpStatus)) return true;
  if (error?.httpStatus >= 500 && error.httpStatus <= 599) return true;
  // Network connection failure without an HTTP status is retryable, as in
  // Codex's HttpConnectionFailed/ResponseStreamConnectionFailed(None).
  return error instanceof TypeError;
}

export async function waitForGuardianRetry(attempt, { signal } = {}) {
  const delayMs = Math.min(5000, 200 * (2 ** Math.max(0, attempt - 1)));
  await sleep(delayMs, undefined, { signal });
}
