import path from 'node:path';
import { applyPatchToEnvironment } from './apply-patch.mjs';
import {
  DEFAULT_MAX_VIEW_IMAGE_BYTES,
  viewImageFromEnvironment,
} from './view-image.mjs';
import {
  DEFAULT_MAX_SEND_FILE_BYTES,
  sendFileFromEnvironment,
} from './send-file.mjs';
import {
  DEFAULT_MAX_RECEIVE_FILE_BYTES,
  receiveFileFromEnvironment,
} from './receive-file.mjs';
import { resolveWorkspaceRelativePath } from '../workspace-registry.mjs';

export class NativeFileService {
  constructor({
    environmentRegistry,
    workspaceRegistry = null,
    maxViewImageBytes = Number(
      process.env.CCM_MAX_VIEW_IMAGE_BYTES || DEFAULT_MAX_VIEW_IMAGE_BYTES,
    ),
    maxSendFileBytes = Number(
      process.env.CCM_MAX_SEND_FILE_BYTES || DEFAULT_MAX_SEND_FILE_BYTES,
    ),
    maxReceiveFileBytes = Number(
      process.env.CCM_MAX_RECEIVE_FILE_BYTES || DEFAULT_MAX_RECEIVE_FILE_BYTES,
    ),
  } = {}) {
    if (!environmentRegistry) {
      throw new Error('NativeFileService requires an environment registry.');
    }
    this.environmentRegistry = environmentRegistry;
    this.workspaceRegistry = workspaceRegistry;
    this.maxViewImageBytes = maxViewImageBytes;
    this.maxSendFileBytes = maxSendFileBytes;
    this.maxReceiveFileBytes = maxReceiveFileBytes;
  }

  async applyPatch(args) {
    const environment = args.workspace_id
      ? this.workspaceRegistry?.environmentFor(
          args.workspace_id,
          args.expected_workspace_root,
        )
      : this.environmentRegistry.resolve(args.environment_id);
    if (!environment) throw new Error('Workspace patching requires a workspace registry.');
    const workdir = args.workspace_id
      ? resolveWorkspaceRelativePath(environment.cwd, args.workdir, 'workdir')
      : args.workdir;
    return applyPatchToEnvironment({
      environment,
      patch: args.patch,
      workdir,
      environmentId: args.environment_id || environment.id,
    });
  }

  async viewImage(args) {
    const environment = args.workspace_id
      ? this.workspaceRegistry?.environmentFor(
          args.workspace_id,
          args.expected_workspace_root,
        )
      : this.environmentRegistry.resolve(args.environment_id);
    if (!environment) throw new Error('Workspace image reads require a workspace registry.');
    const imagePath = args.workspace_id
      ? resolveWorkspaceRelativePath(environment.cwd, args.path, 'path')
      : args.path;
    return viewImageFromEnvironment({
      environment,
      path: imagePath,
      maxBytes: this.maxViewImageBytes,
    });
  }

  async sendFile(args) {
    const environment = args.workspace_id
      ? this.workspaceRegistry?.environmentFor(
          args.workspace_id,
          args.expected_workspace_root,
        )
      : this.environmentRegistry.resolve(args.environment_id);
    if (!environment) throw new Error('Workspace file transfer requires a workspace registry.');
    return sendFileFromEnvironment({
      environment,
      path: args.path,
      maxBytes: this.maxSendFileBytes,
    });
  }

  async receiveFile(args) {
    const environment = args.workspace_id
      ? this.workspaceRegistry?.environmentFor(
          args.workspace_id,
          args.expected_workspace_root,
        )
      : this.environmentRegistry.resolve(args.environment_id);
    if (!environment) throw new Error('Workspace file transfer requires a workspace registry.');
    const destination = args.destination == null || args.destination === ''
      ? null
      : path.relative(
          environment.cwd,
          resolveWorkspaceRelativePath(environment.cwd, args.destination, 'destination'),
        );
    return receiveFileFromEnvironment({
      environment,
      file: args.file,
      destination,
      overwrite: args.overwrite === true,
      maxBytes: this.maxReceiveFileBytes,
    });
  }
}
