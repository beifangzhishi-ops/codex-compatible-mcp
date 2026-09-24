import fs from 'node:fs';
import path from 'node:path';
import { defaultControllerStateFile } from '../src/controller/controller-state.mjs';
import {
  hashPackageScript,
  parsePackageScriptCommand,
} from '../src/controller/package-script-policy.mjs';
import { TrustedPackageScriptStore } from '../src/controller/trusted-package-script-store.mjs';

function readArgs(argv) {
  const [action, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error('Unexpected argument: ' + token);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --' + key);
    options[key] = value;
    index += 1;
  }
  return { action, options };
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error('Missing --' + name);
  return value;
}

function executionIdentity(options) {
  const root = path.resolve(required(options, 'workspace-root'));
  const command = required(options, 'command');
  const parsed = parsePackageScriptCommand(command);
  if (!parsed) throw new Error('Command is not a simple package-script invocation.');
  const workdir = options.workdir || null;
  return {
    parsed,
    root,
    workdir,
    workspaceContext: {
      workspace_id: required(options, 'workspace-id'),
      workspace_root: root,
    },
    environment: {
      id: required(options, 'environment-id'),
      shell: {
        path: options.shell ||
          (process.platform === 'win32'
            ? 'powershell.exe'
            : (process.env.SHELL || '/bin/bash')),
      },
    },
    args: {
      cmd: command,
      workdir,
      tty: options.tty === 'true',
      shell: options.shell || null,
    },
  };
}

function trustInput(options) {
  const input = executionIdentity(options);
  const packageRoot = input.workdir
    ? path.resolve(input.root, input.workdir)
    : input.root;
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const scriptText = packageJson?.scripts?.[input.parsed.script];
  if (typeof scriptText !== 'string' || !scriptText) {
    throw new Error('package.json does not define scripts.' + input.parsed.script);
  }
  return {
    workspaceContext: input.workspaceContext,
    environment: input.environment,
    args: input.args,
    packageScript: {
      ...input.parsed,
      script_sha256: hashPackageScript(scriptText),
    },
  };
}

const { action, options } = readArgs(process.argv.slice(2));
const stateFile = options['state-file'] ||
  defaultControllerStateFile('trusted-package-scripts.json');
const store = new TrustedPackageScriptStore({ stateFile });

if (action === 'list') {
  process.stdout.write(JSON.stringify(store.list(), null, 2) + '\n');
} else if (action === 'trust') {
  const rule = store.trust(trustInput(options));
  process.stdout.write(JSON.stringify(rule, null, 2) + '\n');
} else if (action === 'revoke') {
  const input = executionIdentity(options);
  const count = store.revoke(input);
  process.stdout.write(JSON.stringify({ revoked: count }) + '\n');
} else {
  throw new Error('Usage: manage-trusted-package-script.mjs <trust|revoke|list> ...');
}
