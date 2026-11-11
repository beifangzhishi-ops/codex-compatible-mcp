import { CpaReviewClient } from './cpa-review-client.mjs';
import { GUARDIAN_OUTPUT_SCHEMA, parseGuardianAssessment } from './guardian-assessment.mjs';
import { guardianInstructions, guardianReviewPrompt } from './guardian-prompts.mjs';
import { GuardianToolDispatcher } from './guardian-tool-dispatcher.mjs';
import { readCcmSection } from '../runtime/ccm-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mayRetryGuardian, waitForGuardianRetry } from './guardian-retry.mjs';

const DEFAULT_REVIEW_TIMEOUT_MS = 90_000;

function localCpaClientKey(config) {
  if (process.env.CCM_GUARDIAN_API_KEY) return process.env.CCM_GUARDIAN_API_KEY;
  if (!config.api_key_config) return null;
  if (!path.isAbsolute(config.api_key_config)) {
    throw new Error('Guardian CPA configuration path must be absolute');
  }
  const data = fs.readFileSync(config.api_key_config, 'utf8');
  const lines = data.split(/\r?\n/);
  const offset = lines.findIndex((line) => /^\s*api-keys:\s*$/.test(line));
  if (offset < 0) throw new Error('CPA local api-keys list not found');
  const match = lines.slice(offset + 1).find((line) => /^\s*-\s*\S+/.test(line));
  if (!match) throw new Error('CPA client key is not available');
  return match.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, '');
}

export class GuardianReviewer {
  constructor({ config = null, client = null, toolRegistry = null, audit = null } = {}) {
    this.getConfig = typeof config === 'function'
      ? config : () => config || readCcmSection('controller').guardian || {};
    this.client = client;
    this.toolRegistry = toolRegistry;
    this.audit = typeof audit === 'function' ? audit : null;
  }

  attachToolRegistry(registry) {
    this.toolRegistry = registry;
  }

  isEnabled() {
    return this.getConfig()?.enabled === true;
  }

  async review({ approval, action, reviewContext = '', signal = null }) {
    const config = this.getConfig();
    if (config?.enabled !== true) throw new Error('Guardian reviewer is not enabled');
    const deadline = Number.isFinite(config.timeout_ms)
      ? Math.min(Math.max(config.timeout_ms, 1000), 180000)
      : DEFAULT_REVIEW_TIMEOUT_MS;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    const timeout = setTimeout(() => controller.abort(new Error('Guardian review timed out')), deadline);
    timeout.unref?.();
    const dispatcher = new GuardianToolDispatcher({
      registry: this.toolRegistry, audit: this.audit,
    });
    const client = this.client || new CpaReviewClient({
      apiKey: localCpaClientKey(config),
      baseUrl: config.base_url || undefined,
      model: config.model || undefined,
      maxTurns: config.max_turns || undefined,
      maxToolCalls: config.max_tool_calls || undefined,
    });
    this.audit?.({
      component: 'guardian', event: 'review_requested',
      approval_id: approval.approval_id,
      intent_sha256: approval.intent_sha256,
      model: client.model || 'codex-auto-review',
    });
    try {
      const maxAttempts = Math.min(3, Math.max(1, Number(config.max_attempts) || 2));
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let toolInvocations = 0;
        try {
          const result = await client.complete({
            instructions: guardianInstructions(),
            prompt: guardianReviewPrompt({ action, reviewContext }),
            schema: GUARDIAN_OUTPUT_SCHEMA,
            tools: dispatcher.availableTools(),
            invokeTool: (name, args, { signal: toolSignal } = {}) => {
              toolInvocations++;
              return dispatcher.invoke(name, args, {
                approvalId: approval.approval_id,
                workspaceHandle: action.workspace_handle,
                signal: toolSignal,
              });
            },
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            throw controller.signal.reason || new Error('Guardian review cancelled');
          }
          let assessment;
          try {
            assessment = parseGuardianAssessment(result.text);
          } catch (error) {
            error.guardianKind = 'parse';
            throw error;
          }
      this.audit?.({
        component: 'guardian',
        event: assessment.outcome === 'allow' ? 'review_allowed' : 'review_denied',
        approval_id: approval.approval_id,
        intent_sha256: approval.intent_sha256,
        outcome: assessment.outcome,
        risk_level: assessment.risk_level,
        user_authorization: assessment.user_authorization,
        rounds: result.rounds,
        tool_calls: result.toolCalls,
        attempt_count: attempt,
      });
      return assessment;
        } catch (error) {
          if (controller.signal.aborted || attempt === maxAttempts ||
              !mayRetryGuardian(error, { toolInvocations })) throw error;
          this.audit?.({
            component: 'guardian', event: 'review_retry',
            approval_id: approval.approval_id, attempt_count: attempt,
            error_name: error?.name || 'Error',
          });
          await waitForGuardianRetry(attempt, { signal: controller.signal });
        }
      }
      throw new Error('Guardian retry attempts exhausted');
    } catch (error) {
      this.audit?.({
        component: 'guardian', event: controller.signal.aborted
          ? 'review_timeout_or_cancelled' : 'review_failed',
        approval_id: approval.approval_id, intent_sha256: approval.intent_sha256,
        error_name: error?.name || 'Error',
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
