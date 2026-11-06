import { randomUUID } from 'node:crypto';

const CLAIM_WINDOW_MS = 5 * 60_000;
const ALLOWED_SECONDS = new Set([60, 300, 1800, 3600, 21600, 86400, 604800]);

// Grants are intentionally process-local: restarting the Controller fails closed.
// An unlock authorizes operations from any currently connected (or later joined)
// Worker, but only when the caller explicitly supplies the browser-issued grant ID.
export class WebFullAccess {
  constructor({ now = () => Date.now(), audit = null, enrollmentRevision = () => 'enabled' } = {}) {
    this.now = now;
    this.audit = audit;
    this.enrollmentRevision = enrollmentRevision;
    this.lastRevision = this.enrollmentRevision();
    this.active = null;
    this.pending = null;
  }

  cleanup() {
    const now = this.now();
    const revision = this.enrollmentRevision();
    if (revision !== this.lastRevision) {
      this.active = null;
      this.pending = null;
      this.lastRevision = revision;
    }
    if (this.pending && this.pending.claimExpires <= now) this.pending = null;
    if (this.active && this.active.expires <= now) {
      this.active = null;
      this.pending = null;
    }
  }

  describe() {
    return this.active ? {
      active: true,
      full_access_grant_id: this.active.id,
      expires_at: new Date(this.active.expires).toISOString(),
      duration_seconds: this.active.durationSeconds,
      claim_available: this.pending !== null,
    } : { active: false };
  }

  issue(durationSeconds) {
    this.cleanup();
    if (!this.lastRevision) throw new Error('CCM phone authenticator is not confirmed.');
    if (!ALLOWED_SECONDS.has(durationSeconds)) throw new Error('Invalid unlock duration.');
    if (this.active) return { issued: false, ...this.describe() };
    const now = this.now();
    const id = randomUUID();
    this.active = { id, durationSeconds, expires: now + durationSeconds * 1000 };
    this.pending = {
      claimExpires: Math.min(now + CLAIM_WINDOW_MS, this.active.expires),
    };
    this.audit?.({ component: 'web_full_access', event: 'issued', duration_seconds: durationSeconds });
    return { issued: true, ...this.describe() };
  }

  status() {
    this.cleanup();
    return this.describe();
  }

  claim() {
    this.cleanup();
    if (!this.lastRevision) return null;
    if (!this.pending || !this.active) return null;
    this.pending = null;
    const { id, expires, durationSeconds } = this.active;
    this.audit?.({ component: 'web_full_access', event: 'claimed', duration_seconds: durationSeconds });
    return { full_access_grant_id: id, expires_at: new Date(expires).toISOString(), duration_seconds: durationSeconds };
  }

  authorize(grantId) {
    if (grantId === undefined || grantId === null) return false;
    this.cleanup();
    if (!this.lastRevision) throw new Error('CCM phone authenticator is not confirmed.');
    if (typeof grantId !== 'string' || grantId !== this.active?.id) {
      throw new Error('Full Access grant is unknown or expired. Unlock again on the CCM webpage.');
    }
    return true;
  }
}
