import { randomUUID } from 'node:crypto';

const CLAIM_WINDOW_MS = 5 * 60_000;
const ALLOWED_SECONDS = new Set([60, 300, 1800, 3600, 21600, 86400, 604800]);

// Grants are intentionally process-local: restarting the Controller fails closed.
// An unlock authorizes operations from any currently connected (or later joined)
// Worker, but only after a claim consumes the pending browser-issued grant.
// A browser copy can be recovered once via the tool if ChatGPT blocks the ID.
export class WebFullAccess {
  constructor({ now = () => Date.now(), audit = null, enrollmentRevision = () => 'enabled' } = {}) {
    this.now = now;
    this.audit = audit;
    this.enrollmentRevision = enrollmentRevision;
    this.lastRevision = this.enrollmentRevision();
    this.pending = null;
    this.recovery = null;
    this.grants = new Map();
  }

  cleanup() {
    const now = this.now();
    const revision = this.enrollmentRevision();
    if (revision !== this.lastRevision) {
      this.pending = null;
      this.recovery = null;
      this.grants.clear();
      this.lastRevision = revision;
    }
    if (this.pending && this.pending.claimExpires <= now) this.pending = null;
    for (const [id, grant] of this.grants) {
      if (grant.expires <= now) this.grants.delete(id);
    }
    if (this.recovery && (this.recovery.recoverExpires <= now || !this.grants.has(this.recovery.id))) {
      this.recovery = null;
    }
  }

  describe() {
    return this.pending ? {
      pending: true,
      full_access_grant_id: this.pending.id,
      expires_at: new Date(this.pending.expires).toISOString(),
      claim_expires_at: new Date(this.pending.claimExpires).toISOString(),
      duration_seconds: this.pending.durationSeconds,
    } : { pending: false };
  }

  issue(durationSeconds) {
    this.cleanup();
    if (!this.lastRevision) throw new Error('CCM phone authenticator is not confirmed.');
    if (!ALLOWED_SECONDS.has(durationSeconds)) throw new Error('Invalid unlock duration.');
    if (this.pending) return { issued: false, ...this.describe() };
    this.recovery = null;
    const now = this.now();
    this.pending = {
      id: randomUUID(), durationSeconds,
      expires: now + durationSeconds * 1000,
      claimExpires: Math.min(now + CLAIM_WINDOW_MS, now + durationSeconds * 1000),
    };
    this.audit?.({ component: 'web_full_access', event: 'issued', duration_seconds: durationSeconds });
    return { issued: true, ...this.describe() };
  }

  status() {
    this.cleanup();
    return this.describe();
  }

  claim(expectedId = null) {
    this.cleanup();
    if (!this.lastRevision) return null;
    if (!this.pending) {
      if (expectedId !== null || !this.recovery) return null;
      const { id, expires, durationSeconds } = this.recovery;
      this.recovery = null;
      this.audit?.({ component: 'web_full_access', event: 'recovered' });
      return { full_access_grant_id: id, expires_at: new Date(expires).toISOString(), duration_seconds: durationSeconds };
    }
    if (expectedId !== null && expectedId !== this.pending.id) return null;
    const { id, expires, durationSeconds, claimExpires } = this.pending;
    this.pending = null;
    this.grants.set(id, { expires });
    this.recovery = expectedId !== null
      ? { id, expires, durationSeconds, recoverExpires: claimExpires }
      : null;
    this.audit?.({ component: 'web_full_access', event: 'claimed', duration_seconds: durationSeconds });
    return { full_access_grant_id: id, expires_at: new Date(expires).toISOString(), duration_seconds: durationSeconds };
  }

  authorize(grantId) {
    if (grantId === undefined || grantId === null) return false;
    this.cleanup();
    if (!this.lastRevision) throw new Error('CCM phone authenticator is not confirmed.');
    const grant = typeof grantId === 'string' ? this.grants.get(grantId) : null;
    if (!grant || grant.expires <= this.now()) {
      throw new Error('Full Access grant is unknown or expired. Unlock again on the CCM webpage.');
    }
    return true;
  }
}
