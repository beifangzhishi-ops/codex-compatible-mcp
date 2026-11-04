import { randomUUID } from 'node:crypto';

const CLAIM_WINDOW_MS = 5 * 60_000;
const ALLOWED_SECONDS = new Set([60, 300, 1800, 3600, 21600, 86400, 604800]);

// Grants are intentionally process-local: restarting the Controller fails closed.
// An unlock authorizes operations from any currently connected (or later joined)
// Worker, but only when the caller explicitly supplies the claimed grant ID.
export class WebFullAccess {
  constructor({ now = () => Date.now(), audit = null, enrollmentRevision = () => 'enabled' } = {}) {
    this.now = now;
    this.audit = audit;
    this.enrollmentRevision = enrollmentRevision;
    this.lastRevision = this.enrollmentRevision();
    this.pending = null;
    this.grants = new Map();
  }

  cleanup() {
    const now = this.now();
    const revision = this.enrollmentRevision();
    if (revision !== this.lastRevision) {
      this.pending = null;
      this.grants.clear();
      this.lastRevision = revision;
    }
    if (this.pending && this.pending.claimExpires <= now) this.pending = null;
    for (const [id, record] of this.grants) {
      if (record.expires <= now) this.grants.delete(id);
    }
  }

  issue(durationSeconds) {
    this.cleanup();
    if (!this.lastRevision) throw new Error('CCM phone authenticator is not confirmed.');
    if (!ALLOWED_SECONDS.has(durationSeconds)) throw new Error('Invalid unlock duration.');
    if (this.pending) {
      return {
        issued: false, pending: true,
        claim_expires_at: new Date(this.pending.claimExpires).toISOString(),
      };
    }
    const now = this.now();
    this.pending = {
      id: randomUUID(),
      durationSeconds,
      claimExpires: now + CLAIM_WINDOW_MS,
    };
    this.audit?.({ component: 'web_full_access', event: 'issued', duration_seconds: durationSeconds });
    return {
      issued: true, pending: true,
      claim_expires_at: new Date(this.pending.claimExpires).toISOString(),
    };
  }

  status() {
    this.cleanup();
    return this.pending
      ? { pending: true, claim_expires_at: new Date(this.pending.claimExpires).toISOString() }
      : { pending: false };
  }

  claim() {
    this.cleanup();
    if (!this.lastRevision) return null;
    if (!this.pending) return null;
    const { id, durationSeconds } = this.pending;
    this.pending = null;
    const expires = this.now() + durationSeconds * 1000;
    this.grants.set(id, { expires });
    this.audit?.({ component: 'web_full_access', event: 'claimed', duration_seconds: durationSeconds });
    return { full_access_grant_id: id, expires_at: new Date(expires).toISOString(), duration_seconds: durationSeconds };
  }

  authorize(grantId) {
    if (grantId === undefined || grantId === null) return false;
    this.cleanup();
    if (!this.lastRevision) throw new Error('CCM phone authenticator is not confirmed.');
    const record = this.grants.get(grantId);
    if (typeof grantId !== 'string' || !record || record.expires <= this.now()) {
      throw new Error('Full Access grant is unknown or expired. Unlock and claim again.');
    }
    return true;
  }
}
