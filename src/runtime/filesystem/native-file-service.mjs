import { applyPatchToEnvironment } from './apply-patch.mjs';
import {
  DEFAULT_MAX_VIEW_IMAGE_BYTES,
  viewImageFromEnvironment,
} from './view-image.mjs';
import {
  DEFAULT_MAX_SEND_FILE_BYTES,
  sendFileFromEnvironment,
} from './send-file.mjs';

export class NativeFileService {
  constructor({
    environmentRegistry,
    maxViewImageBytes = Number(
      process.env.CCM_MAX_VIEW_IMAGE_BYTES || DEFAULT_MAX_VIEW_IMAGE_BYTES,
    ),
    maxSendFileBytes = Number(
      process.env.CCM_MAX_SEND_FILE_BYTES || DEFAULT_MAX_SEND_FILE_BYTES,
    ),
  } = {}) {
    if (!environmentRegistry) {
      throw new Error('NativeFileService requires an environment registry.');
    }
    this.environmentRegistry = environmentRegistry;
    this.maxViewImageBytes = maxViewImageBytes;
    this.maxSendFileBytes = maxSendFileBytes;
  }

  async applyPatch(args) {
    const environment = this.environmentRegistry.resolve(args.environment_id);
    return applyPatchToEnvironment({
      environment,
      patch: args.patch,
      workdir: args.workdir,
      environmentId: args.environment_id || environment.id,
    });
  }

  async viewImage(args) {
    const environment = this.environmentRegistry.resolve(args.environment_id);
    return viewImageFromEnvironment({
      environment,
      path: args.path,
      maxBytes: this.maxViewImageBytes,
    });
  }

  async sendFile(args) {
    const environment = this.environmentRegistry.resolve(args.environment_id);
    return sendFileFromEnvironment({
      environment,
      path: args.path,
      maxBytes: this.maxSendFileBytes,
    });
  }
}
