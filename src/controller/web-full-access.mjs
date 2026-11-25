import { randomUUID } from 'node:crypto';

export const FULL_ACCESS_DURATIONS = [60, 300, 1800, 3600, 21600, 86400, 604800];

// Grants exist only in Controller memory and are valid across Workers.
export class WebFullAccess {
  constructor({ now = () => Date.now(), audit = null } = {}) {
    this.now = now;
    this.audit = audit;
    this.grants = new Map();
  }

  cleanup() {
    const now = this.now();
    for (const [id, grant] of this.grants) {
      if (grant.expires <= now) this.grants.delete(id);
    }
  }

  list() {
    this.cleanup();
    return [...this.grants].map(([id, grant]) => ({
      full_access_grant_id: id,
      expires_at: new Date(grant.expires).toISOString(),
      duration_seconds: grant.durationSeconds,
    }));
  }

  issue(durationSeconds) {
    if (!FULL_ACCESS_DURATIONS.includes(durationSeconds)) throw new Error('Invalid authorization duration.');
    this.cleanup();
    const id = randomUUID();
    const expires = this.now() + durationSeconds * 1000;
    this.grants.set(id, { expires, durationSeconds });
    this.audit?.({ component: 'web_full_access', event: 'issued', duration_seconds: durationSeconds });
    return { full_access_grant_id: id, expires_at: new Date(expires).toISOString(), duration_seconds: durationSeconds };
  }

  revoke(id) {
    this.cleanup();
    const removed = this.grants.delete(id);
    if (removed) this.audit?.({ component: 'web_full_access', event: 'revoked' });
    return removed;
  }

  authorize(grantId) {
    if (grantId === undefined || grantId === null) return false;
    this.cleanup();
    if (!this.grants.has(grantId)) {
      throw new Error('Full Access grant is unknown or expired. Issue a grant on the CCM management webpage.');
    }
    return true;
  }
}
