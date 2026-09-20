import { parsePatch } from './apply-patch.mjs';

export class RemoteFileService {
  constructor({ environmentRegistry, workerHub }) {
    if (!environmentRegistry || !workerHub) {
      throw new Error('RemoteFileService requires environmentRegistry and workerHub.');
    }
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
  }

  async applyPatch(args) {
    const parsed = parsePatch(args.patch);
    if (args.environment_id &&
        parsed.environmentId &&
        args.environment_id !== parsed.environmentId) {
      throw new Error(
        'apply_patch environment mismatch: argument=' + args.environment_id +
        ', patch=' + parsed.environmentId,
      );
    }

    const environment = this.environmentRegistry.resolve(
      args.environment_id || parsed.environmentId,
    );
    if (!environment.capabilities?.applyPatch) {
      throw new Error(
        'Environment does not support apply_patch: ' + environment.id,
      );
    }

    return this.workerHub.call(
      environment.id,
      'apply_patch',
      { ...args, environment_id: environment.id },
      { timeoutMs: 30_000 },
    );
  }
  async viewImage(args) {
    const environment = this.environmentRegistry.resolve(args.environment_id);
    if (!environment.capabilities?.viewImage) {
      throw new Error(
        'Environment does not support view_image: ' + environment.id,
      );
    }

    return this.workerHub.call(
      environment.id,
      'view_image',
      { ...args, environment_id: environment.id },
      { timeoutMs: 30_000 },
    );
  }

  async sendFile(args) {
    const environment = this.environmentRegistry.resolve(args.environment_id);
    if (!environment.capabilities?.sendFile) {
      throw new Error(
        'Environment does not support send_file: ' + environment.id,
      );
    }

    return this.workerHub.call(
      environment.id,
      'send_file',
      { ...args, environment_id: environment.id },
      { timeoutMs: 60_000 },
    );
  }
}
