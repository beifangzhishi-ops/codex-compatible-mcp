import os from 'node:os';
import path from 'node:path';

export function defaultControllerStateDir() {
  if (process.env.CCM_CONTROLLER_STATE_DIR) {
    return path.resolve(process.env.CCM_CONTROLLER_STATE_DIR);
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'CCM');
  }
  if (process.env.XDG_STATE_HOME) {
    return path.join(process.env.XDG_STATE_HOME, 'ccm');
  }
  return path.join(os.homedir(), '.ccm');
}

export function defaultControllerStateFile(name) {
  return path.join(defaultControllerStateDir(), name);
}
