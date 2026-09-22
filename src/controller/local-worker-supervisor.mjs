import { spawn as nodeSpawn } from 'node:child_process';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class LocalWorkerSupervisor {
  constructor({
    workerHub,
    environmentId,
    agentPath,
    takeoverToken,
    nodePath = process.execPath,
    baseEnv = process.env,
    spawnProcess = nodeSpawn,
    startupTimeoutMs = 10_000,
    restartMinMs = 1_000,
    restartMaxMs = 30_000,
    log = () => {},
    onOutput = () => {},
  } = {}) {
    if (!workerHub || !environmentId || !agentPath) {
      throw new Error(
        'LocalWorkerSupervisor requires workerHub, environmentId, and agentPath.',
      );
    }
    this.workerHub = workerHub;
    this.environmentId = environmentId;
    this.agentPath = agentPath;
    this.takeoverToken = takeoverToken || null;
    this.nodePath = nodePath;
    this.baseEnv = baseEnv;
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
    this.restartMinMs = restartMinMs;
    this.restartMaxMs = restartMaxMs;
    this.log = log;
    this.onOutput = onOutput;
    this.child = null;
    this.restartTimer = null;
    this.restartCount = 0;
    this.restartAttempts = 0;
    this.stopping = false;
    this.state = 'idle';
    this.lastExit = null;
    this.lastError = null;

    this.onEnvironmentConnected = (environmentId) => {
      if (environmentId !== this.environmentId || this.stopping) return;
      this.state = 'connected';
      this.restartAttempts = 0;
      this.lastError = null;
    };
    this.onEnvironmentDisconnected = (environmentId) => {
      if (environmentId !== this.environmentId || this.stopping) return;
      if (this.child && !this.child.killed) this.state = 'reconnecting';
    };
  }

  status() {
    return {
      enabled: true,
      state: this.state,
      environment_id: this.environmentId,
      worker_pid: this.child?.pid || null,
      restart_count: this.restartCount,
      restart_attempts: this.restartAttempts,
      last_exit: this.lastExit,
      last_error: this.lastError,
    };
  }

  async start() {
    this.stopping = false;
    this.workerHub.on('environment_connected', this.onEnvironmentConnected);
    this.workerHub.on('environment_disconnected', this.onEnvironmentDisconnected);
    await this.#spawnWorker();
    const connected = await this.workerHub.waitForEnvironment(
      this.environmentId,
      this.startupTimeoutMs,
    );
    if (!connected) {
      this.lastError =
        'Local Remote Worker failed to register environment ' +
        this.environmentId + '.';
      this.log(this.lastError);
      if (this.child && !this.child.killed) this.child.kill();
      throw new Error(this.lastError);
    }
    this.state = 'connected';
    this.restartAttempts = 0;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.state = 'stopping';
    this.workerHub.off('environment_connected', this.onEnvironmentConnected);
    this.workerHub.off(
      'environment_disconnected',
      this.onEnvironmentDisconnected,
    );
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
    await sleep(0);
    this.state = 'stopped';
  }

  async #spawnWorker() {
    if (this.stopping) return;
    const hubAddress = this.workerHub.address;
    if (!hubAddress?.port) {
      throw new Error('WorkerHub must be listening before local Worker starts.');
    }
    this.state = this.restartAttempts > 0 ? 'restarting' : 'starting';
    const child = this.spawnProcess(this.nodePath, [this.agentPath], {
      env: {
        ...this.baseEnv,
        CCM_WORKER_HUB_CONNECT_HOST:
          this.workerHub.host === '0.0.0.0'
            ? '127.0.0.1'
            : this.workerHub.host === '::'
              ? '::1'
              : this.workerHub.host,
        CCM_WORKER_HUB_PORT: String(hubAddress.port),
        ...(this.takeoverToken
          ? { CCM_WORKER_TAKEOVER_TOKEN: this.takeoverToken }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.log(
      'local Worker started pid=' + String(child.pid || 'unknown') +
      ' environment=' + this.environmentId,
    );
    child.stdout?.on('data', (chunk) => this.onOutput('stdout', chunk));
    child.stderr?.on('data', (chunk) => this.onOutput('stderr', chunk));
    let terminated = false;
    const onTerminated = (code, signal, error = null) => {
      if (terminated) return;
      terminated = true;
      if (error) {
        this.lastError = String(error?.message || error);
        this.log('local Worker process error: ' + this.lastError);
      }
      if (this.child === child) this.child = null;
      const exit = {
        code: code ?? null,
        signal: signal || null,
        at: new Date().toISOString(),
      };
      this.lastExit = exit;
      this.log(
        'local Worker exited code=' + String(exit.code) +
        ' signal=' + String(exit.signal || 'none'),
      );
      if (this.stopping) return;
      this.state = 'restarting';
      this.restartCount += 1;
      this.restartAttempts += 1;
      this.#scheduleRestart();
    };
    child.once('error', (error) => {
      onTerminated(null, null, error);
    });
    child.once('exit', (code, signal) => {
      onTerminated(code, signal);
    });
  }

  #scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const delay = Math.min(
      this.restartMaxMs,
      this.restartMinMs * (2 ** Math.max(0, this.restartAttempts - 1)),
    );
    this.log('local Worker restart scheduled in ' + delay + ' ms');
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.stopping) return;
      try {
        await this.#spawnWorker();
      } catch (error) {
        this.lastError = String(error?.message || error);
        this.log('local Worker restart failed: ' + this.lastError);
        this.restartAttempts += 1;
        this.#scheduleRestart();
      }
    }, delay);
  }
}
