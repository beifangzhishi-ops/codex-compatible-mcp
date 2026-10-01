import crypto from 'node:crypto';
import path from 'node:path';
import {
  boundOutput,
  capCapturedOutput,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './output-budget.mjs';
import { resolvePermissionProfile } from './sandbox/sandbox-policy.mjs';
import { resolveGitAwarePermissionProfile } from './sandbox/git-policy.mjs';
import { resolveWorkspaceRelativePath } from './workspace-registry.mjs';

const MIN_YIELD_TIME_MS = 250;
const DEFAULT_EXEC_YIELD_TIME_MS = 2_000;
const WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS = 1_000;
const MAX_INITIAL_EXEC_YIELD_TIME_MS = 5_000;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_EMPTY_YIELD_TIME_MS = 1_000;
const MIN_EMPTY_YIELD_TIME_MS = 250;
const MAX_EMPTY_YIELD_TIME_MS = 30_000;
const MAX_PROCESSES = 64;
export const DEFAULT_PROCESS_RESULT_TTL_MS = 10 * 60_000;

function normalizeProcessResultTtl(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PROCESS_RESULT_TTL_MS;
}

function clampExecYield(milliseconds, platform) {
  const value = Number(milliseconds ?? DEFAULT_EXEC_YIELD_TIME_MS);
  const min = platform === 'windows'
    ? WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS
    : MIN_YIELD_TIME_MS;
  return Math.min(MAX_INITIAL_EXEC_YIELD_TIME_MS, Math.max(min, value));
}

function clampWriteYield(milliseconds, empty) {
  const defaultValue = empty ? DEFAULT_EMPTY_YIELD_TIME_MS : 250;
  const value = Number(milliseconds ?? defaultValue);
  if (empty) {
    return Math.min(
      MAX_EMPTY_YIELD_TIME_MS,
      Math.max(MIN_EMPTY_YIELD_TIME_MS, value),
    );
  }
  return Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, value));
}
function generateChunkId() {
  return crypto.randomBytes(3).toString('hex');
}

function resolveEnvironmentWorkdir(environment, requested) {
  if (!requested) return environment.cwd;
  if (path.isAbsolute(requested)) return path.normalize(requested);
  return path.resolve(environment.cwd, requested);
}

function waitForExit(record, milliseconds) {
  if (record.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      record.exitWaiters.delete(onExit);
      resolve(record.exited);
    }, Math.max(0, milliseconds));
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    record.exitWaiters.add(onExit);
  });
}

function appendOutput(record, chunk) {
  record.rawOutput += String(chunk ?? '');
  const capped = capCapturedOutput(record.rawOutput);
  record.rawOutput = capped.text;
  record.outputOmittedBytes += capped.omittedBytes;
}

export class ProcessManager {
  constructor({
    environmentRegistry,
    executorRegistry,
    workspaceRegistry = null,
    processResultTtlMs = process.env.CCM_PROCESS_RESULT_TTL_MS,
  }) {
    this.environmentRegistry = environmentRegistry;
    this.executorRegistry = executorRegistry;
    this.workspaceRegistry = workspaceRegistry;
    this.sessions = new Map();
    this.nextProcessId = 1000;
    this.processResultTtlMs = normalizeProcessResultTtl(processResultTtlMs);
  }

  #allocateProcessId() {
    let liveProcesses = 0;
    for (const record of this.sessions.values()) {
      if (!record.exited) liveProcesses += 1;
    }
    if (liveProcesses >= MAX_PROCESSES) {
      throw new Error('Too many active exec sessions; limit is ' + MAX_PROCESSES + '.');
    }
    do {
      this.nextProcessId += 1;
      if (this.nextProcessId > 2_000_000_000) this.nextProcessId = 1000;
    } while (this.sessions.has(this.nextProcessId));
    return this.nextProcessId;
  }

  async execCommand(args) {
    const environment = args.workspace_id
      ? this.workspaceRegistry?.environmentFor(
          args.workspace_id,
          args.expected_workspace_root,
        )
      : this.environmentRegistry.resolve(args.environment_id);
    if (!environment) {
      throw new Error('Workspace execution requires a workspace registry.');
    }
    const executor = this.executorRegistry.resolve(environment);
    const cwd = args.workspace_id
      ? resolveWorkspaceRelativePath(environment.cwd, args.workdir, 'workdir')
      : resolveEnvironmentWorkdir(environment, args.workdir);
    const basePermissionProfile = resolvePermissionProfile(
      environment,
      args.sandbox_permissions,
    );
    const permissionProfile = resolveGitAwarePermissionProfile(
      basePermissionProfile,
      args.cmd,
      {
        shell: args.shell || environment.shell?.path || environment.shell?.type,
        platform: environment.platform,
      },
    );
    const processId = this.#allocateProcessId();
    const requestedShell = args.shell ? { path: args.shell } : environment.shell;

    const record = {
      processId,
      environmentId: environment.id,
      command: args.cmd,
      cwd,
      rawOutput: '',
      deliveredOffset: 0,
      outputOmittedBytes: 0,
      startedAt: Date.now(),
      exited: false,
      exitCode: null,
      signal: null,
      permissionProfile,
      sandboxed: !['full-access', 'trusted-git'].includes(permissionProfile),
      exitWaiters: new Set(),
      tty: Boolean(args.tty),
      child: null,
      expiryTimer: null,
    };

    record.child = executor.startProcess({
      environment,
      command: args.cmd,
      cwd,
      shell: requestedShell,
      permissionProfile,
      tty: record.tty,
      onData: (data) => appendOutput(record, data),
      onExit: (code, signal) => this.#markExited(record, code, signal),
    });
    record.sandboxed = Boolean(record.child.sandboxed);

    this.sessions.set(processId, record);
    const yieldTime = clampExecYield(args.yield_time_ms, environment.platform);
    await waitForExit(record, yieldTime);
    return this.#resultFor(record, args.max_output_tokens, false);
  }
  async writeStdin(args) {
    const record = this.sessions.get(args.session_id);
    if (!record) {
      throw new Error('Unknown or expired session_id: ' + args.session_id);
    }
    if (record.exited) {
      return this.#resultFor(record, args.max_output_tokens, true);
    }

    const chars = args.chars ?? '';
    if (chars) {
      if (!record.child.stdinWritable) {
        throw new Error('Process stdin is not writable.');
      }
      record.child.write(chars);
    }

    const yieldTime = clampWriteYield(args.yield_time_ms, chars.length === 0);
    await waitForExit(record, yieldTime);
    return this.#resultFor(record, args.max_output_tokens, true);
  }

  #markExited(record, code, signal) {
    record.exited = true;
    record.exitCode = Number.isInteger(code) ? code : null;
    record.signal = signal ?? null;
    for (const waiter of record.exitWaiters) waiter();
    record.exitWaiters.clear();
    record.expiryTimer = setTimeout(() => {
      if (this.sessions.get(record.processId) === record && record.exited) {
        this.sessions.delete(record.processId);
      }
    }, this.processResultTtlMs);
    record.expiryTimer.unref?.();
  }

  #deleteRecord(record) {
    if (record.expiryTimer) {
      clearTimeout(record.expiryTimer);
      record.expiryTimer = null;
    }
    this.sessions.delete(record.processId);
  }

  #resultFor(
    record,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    incremental = false,
  ) {
    const start = incremental ? record.deliveredOffset : 0;
    const raw = record.rawOutput.slice(start);
    record.deliveredOffset = record.rawOutput.length;
    const bounded = boundOutput(raw, maxOutputTokens);

    const result = {
      chunk_id: generateChunkId(),
      wall_time_seconds: Number(
        ((Date.now() - record.startedAt) / 1000).toFixed(4),
      ),
      output: bounded.output,
    };
    if (record.exited && record.exitCode !== null) {
      result.exit_code = record.exitCode;
    }
    if (!record.exited) {
      result.session_id = record.processId;
    }
    if (bounded.truncated || record.outputOmittedBytes > 0) {
      result.original_token_count = bounded.originalTokenCount;
    }

    if (record.exited) {
      this.#deleteRecord(record);
    }
    return result;
  }

  terminateSession(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    this.#deleteRecord(record);
    if (!record.exited) {
      try {
        record.child.kill();
      } catch {}
    }
    return true;
  }

  terminateAll() {
    for (const sessionId of [...this.sessions.keys()]) {
      this.terminateSession(sessionId);
    }
  }
}
