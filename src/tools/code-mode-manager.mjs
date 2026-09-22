import { randomUUID } from 'node:crypto';
import { boundOutput } from '../runtime/output-budget.mjs';
import { ToolSurface } from './tool-registry.mjs';

const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WAIT_YIELD_MS = 5_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const MAX_EXEC_YIELD_MS = 30_000;
const MAX_WAIT_YIELD_MS = 30_000;
const MAX_CALLS_PER_EXEC = 32;
const MAX_ACTIVE_JOBS = 32;
const MAX_NESTED_RESULT_BYTES = 1024 * 1024;
const MAX_NESTED_CONTENT_ITEMS = 32;
const MAX_COMPACT_RESULT_BYTES = 256 * 1024;
const JOB_TTL_MS = 15 * 60_000;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function compactStructured(value, maxStringChars) {
  if (typeof value === 'string') {
    if (value.length <= maxStringChars) return value;
    const bounded = boundOutput(value, Math.max(64, Math.floor(maxStringChars / 4)));
    return bounded.output;
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactStructured(item, maxStringChars));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        compactStructured(item, maxStringChars),
      ]),
    );
  }
  return value;
}

function compactToolResult(result, maxTokens) {
  const passthroughContent = Array.isArray(result?.content)
    ? result.content.filter(
        (item) => item?.type === 'image' ||
          item?.type === 'resource' ||
          item?.type === 'resource_link',
      )
    : [];
  const sizeSafeResult = result && typeof result === 'object'
    ? {
        ...result,
        content: Array.isArray(result.content)
          ? result.content.map((item) => {
              if (item?.type === 'image') {
                return {
                  type: 'image',
                  mimeType: item.mimeType,
                  byte_length: Buffer.from(item.data || '', 'base64').length,
                  data_omitted: true,
                };
              }
              if (item?.type !== 'resource') return item;
              return {
                type: 'resource',
                resource: {
                  uri: item.resource?.uri,
                  mimeType: item.resource?.mimeType,
                  _meta: item.resource?._meta,
                  blob_omitted: true,
                },
              };
            })
          : result.content,
      }
    : result;
  let incomingBytes;
  try {
    incomingBytes = Buffer.byteLength(JSON.stringify(sizeSafeResult ?? {}), 'utf8');
  } catch {
    return {
      compact: {
        is_error: true,
        content: [{
          type: 'text',
          text: 'Nested tool returned a result that could not be serialized.',
        }],
      },
      passthroughContent: [],
    };
  }

  if (incomingBytes > MAX_NESTED_RESULT_BYTES) {
    return {
      compact: {
        is_error: true,
        content: [{
          type: 'text',
          text: 'Nested tool result exceeded the 1 MiB Code Mode input limit.',
        }],
      },
      passthroughContent: [],
    };
  }

  const sourceContent = Array.isArray(result?.content)
    ? result.content.slice(0, MAX_NESTED_CONTENT_ITEMS)
    : [];
  const content = sourceContent.map((item) => {
        if (item?.type === 'text') {
          const bounded = boundOutput(item.text || '', maxTokens);
          return {
            type: 'text',
            text: bounded.output,
            ...(bounded.truncated
              ? { original_token_count: bounded.originalTokenCount }
              : {}),
          };
        }
        if (item?.type === 'image') {
          return {
            type: 'image',
            mime_type: item.mimeType,
            byte_length: Buffer.from(item.data || '', 'base64').length,
            data_omitted: true,
          };
        }
        if (item?.type === 'resource') {
          return {
            type: 'resource',
            uri: item.resource?.uri,
            mime_type: item.resource?.mimeType,
            byte_length: item.resource?.blob
              ? Buffer.from(item.resource.blob, 'base64').length
              : undefined,
            data_omitted: true,
          };
        }
        return compactStructured(item, maxTokens * 4);
      });

  const compact = {
    is_error: result?.isError === true,
    content,
    ...(Array.isArray(result?.content) &&
        result.content.length > MAX_NESTED_CONTENT_ITEMS
      ? {
          omitted_content_items:
            result.content.length - MAX_NESTED_CONTENT_ITEMS,
        }
      : {}),
    ...(result?.structuredContent !== undefined
      ? {
          structured_content: compactStructured(
            result.structuredContent,
            maxTokens * 4,
          ),
        }
      : {}),
  };

  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') >
      MAX_COMPACT_RESULT_BYTES) {
    delete compact.structured_content;
    compact.structured_content_omitted = true;
  }
  return { compact, passthroughContent };
}

function liveSessionFrom(event) {
  const sessionId = event?.result?.structured_content?.session_id;
  return Number.isInteger(sessionId)
    ? { call_index: event.call_index, tool: event.tool, session_id: sessionId }
    : null;
}

export class CodeModeManager {
  constructor({ registry } = {}) {
    if (!registry) throw new Error('CodeModeManager requires a ToolRegistry.');
    this.registry = registry;
    this.jobs = new Map();
  }

  #cleanup() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (now - job.startedAt > JOB_TTL_MS) this.jobs.delete(id);
    }
  }

  #format(job, { running, maxOutputTokens }) {
    const newEvents = job.events.slice(job.delivered);
    job.delivered = job.events.length;
    const newContent = job.contentItems.slice(job.deliveredContent);
    job.deliveredContent = job.contentItems.length;

    const liveSessions = job.events
      .map(liveSessionFrom)
      .filter(Boolean);
    const state = running
      ? 'running'
      : liveSessions.length > 0
        ? 'awaiting_io'
        : 'completed';

    const payload = {
      state,
      has_errors: job.hasErrors,
      calls: newEvents,
      live_sessions: liveSessions,
      next_operation: running
        ? 'wait'
        : liveSessions.length > 0
          ? 'write_stdin'
          : null,
      message: running
        ? 'Nested execution is still running. Resume it with wait.'
        : liveSessions.length > 0
          ? 'Nested execution finished, but one or more process sessions are still running. Continue those sessions with write_stdin.'
          : job.hasErrors
            ? 'Nested execution completed with one or more tool errors.'
            : 'Nested execution completed.',
    };

    if (running) payload.cell_id = job.id;

    const text = boundOutput(
      JSON.stringify(payload, null, 2),
      maxOutputTokens,
    ).output;

    return { payload, text, content: newContent };
  }
  #prepareCalls(calls, parallel) {
    if (!Array.isArray(calls) || calls.length === 0) {
      throw new Error('exec requires at least one nested tool call.');
    }
    if (calls.length > MAX_CALLS_PER_EXEC) {
      throw new Error(
        'exec supports at most ' + MAX_CALLS_PER_EXEC + ' nested calls.',
      );
    }

    return calls.map((call, callIndex) => {
      if (!call || typeof call.tool !== 'string' || !call.tool.trim()) {
        throw new Error('Nested call ' + callIndex + ' requires a tool name.');
      }
      const tool = this.registry.resolve(call.tool.trim(), {
        surface: ToolSurface.CODE_MODE,
      });
      if (!tool) {
        throw new Error(
          'Tool is not available on the Code Mode surface: ' + call.tool,
        );
      }
      if (parallel && !tool.supportsParallel) {
        throw new Error(
          'Tool does not declare parallel-call support: ' + tool.qualifiedName,
        );
      }

      return {
        callIndex,
        tool,
        arguments: this.registry.validateArguments(
          tool,
          call.arguments || {},
        ),
      };
    });
  }

  async #invoke(prepared, maxTokens) {
    const startedAt = Date.now();
    let result;
    try {
      result = await prepared.tool.handler(prepared.arguments, {
        source: 'code_mode',
        nested: true,
      });
    } catch (error) {
      result = {
        content: [{
          type: 'text',
          text: String(error?.message || error),
        }],
        isError: true,
      };
    }

    const compacted = compactToolResult(result, maxTokens);
    return {
      event: {
        call_index: prepared.callIndex,
        tool: prepared.tool.qualifiedName,
        wall_time_seconds: (Date.now() - startedAt) / 1000,
        result: compacted.compact,
      },
      passthroughContent: compacted.passthroughContent,
    };
  }

  async #runJob(job, preparedCalls, {
    parallel,
    continueOnError,
    perCallTokens,
  }) {
    if (parallel) {
      await Promise.all(
        preparedCalls.map((prepared) =>
          this.#invoke(prepared, perCallTokens).then((invocation) => {
            job.events.push(invocation.event);
            job.contentItems.push(...invocation.passthroughContent);
            if (invocation.event.result.is_error) job.hasErrors = true;
          })),
      );
    } else {
      for (const prepared of preparedCalls) {
        const invocation = await this.#invoke(prepared, perCallTokens);
        job.events.push(invocation.event);
        job.contentItems.push(...invocation.passthroughContent);
        if (invocation.event.result.is_error) {
          job.hasErrors = true;
          if (!continueOnError) break;
        }
      }
    }

    job.done = true;
    job.completedAt = Date.now();
  }

  async exec({
    calls,
    parallel = false,
    continue_on_error: continueOnError = false,
    yield_time_ms: yieldTimeMs,
    max_output_tokens: maxOutputTokens,
  }) {
    this.#cleanup();
    if (this.jobs.size >= MAX_ACTIVE_JOBS) {
      throw new Error(
        'Too many active Code Mode jobs; wait for existing jobs to finish.',
      );
    }

    const preparedCalls = this.#prepareCalls(calls, parallel === true);
    const outputTokens = clampInteger(
      maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      256,
      20_000,
    );
    const perCallTokens = Math.max(
      256,
      Math.min(4_000, Math.floor(outputTokens / preparedCalls.length)),
    );
    const yieldMs = clampInteger(
      yieldTimeMs,
      DEFAULT_EXEC_YIELD_MS,
      0,
      MAX_EXEC_YIELD_MS,
    );

    const job = {
      id: randomUUID(),
      startedAt: Date.now(),
      completedAt: null,
      done: false,
      hasErrors: false,
      events: [],
      delivered: 0,
      contentItems: [],
      deliveredContent: 0,
      donePromise: null,
    };

    job.donePromise = this.#runJob(job, preparedCalls, {
      parallel: parallel === true,
      continueOnError: continueOnError === true,
      perCallTokens,
    }).catch((error) => {
      job.hasErrors = true;
      job.events.push({
        call_index: -1,
        tool: 'ccm.exec',
        wall_time_seconds: 0,
        result: {
          is_error: true,
          content: [{ type: 'text', text: String(error?.message || error) }],
        },
      });
      job.done = true;
      job.completedAt = Date.now();
    });

    this.jobs.set(job.id, job);
    if (!job.done) {
      await Promise.race([job.donePromise, wait(yieldMs)]);
    }

    const running = !job.done;
    const formatted = this.#format(job, {
      running,
      maxOutputTokens: outputTokens,
    });
    if (!running) this.jobs.delete(job.id);
    return formatted;
  }

  async wait({
    cell_id: cellId,
    yield_time_ms: yieldTimeMs,
    max_output_tokens: maxOutputTokens,
  }) {
    this.#cleanup();
    const job = this.jobs.get(cellId);
    if (!job) throw new Error('Unknown or expired Code Mode cell_id: ' + cellId);

    const outputTokens = clampInteger(
      maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      256,
      20_000,
    );
    const yieldMs = clampInteger(
      yieldTimeMs,
      DEFAULT_WAIT_YIELD_MS,
      0,
      MAX_WAIT_YIELD_MS,
    );

    if (!job.done) {
      await Promise.race([job.donePromise, wait(yieldMs)]);
    }

    const running = !job.done;
    const formatted = this.#format(job, {
      running,
      maxOutputTokens: outputTokens,
    });
    if (!running) this.jobs.delete(job.id);
    return formatted;
  }

  close() {
    this.jobs.clear();
  }
}
