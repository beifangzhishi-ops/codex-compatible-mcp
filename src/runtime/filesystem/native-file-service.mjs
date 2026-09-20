import { applyPatchToEnvironment } from './apply-patch.mjs';
import {
  DEFAULT_MAX_VIEW_IMAGE_BYTES,
  viewImageFromEnvironment,
} from './view-image.mjs';

export class NativeFileService {
  constructor({
    environmentRegistry,
    maxViewImageBytes = Number(
      process.env.CCM_MAX_VIEW_IMAGE_BYTES || DEFAULT_MAX_VIEW_IMAGE_BYTES,
    ),
  } = {}) {
    if (!environmentRegistry) {
      throw new Error('NativeFileService requires an environment registry.');
    }
    this.environmentRegistry = environmentRegistry;
    this.maxViewImageBytes = maxViewImageBytes;
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
}
