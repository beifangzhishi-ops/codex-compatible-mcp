export class ExecutorRegistry {
  constructor() {
    this.executors = new Map();
  }

  register(name, executor) {
    if (!name || !executor) throw new Error('Executor name and instance are required.');
    if (this.executors.has(name)) throw new Error(`Executor already registered: ${name}`);
    this.executors.set(name, executor);
    return executor;
  }

  resolve(environment) {
    const executor = this.executors.get(environment.backend);
    if (!executor) {
      throw new Error(
        `No executor registered for backend "${environment.backend}" (environment ${environment.id}).`,
      );
    }
    return executor;
  }
}
