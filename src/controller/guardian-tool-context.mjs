import { AsyncLocalStorage } from 'node:async_hooks';

const reviewerInvocation = new AsyncLocalStorage();

// Internal-only origin tagging, not a new model-facing authorization parameter.
export function runReviewerTool(callback) {
  return reviewerInvocation.run(true, callback);
}

export function isReviewerTool() {
  return reviewerInvocation.getStore() === true;
}
