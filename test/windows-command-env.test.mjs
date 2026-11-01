import test from 'node:test';
import assert from 'node:assert/strict';
import { readCurrentCommandEnvironment, windowsCommandEnvInternals } from '../src/runtime/windows-command-env.mjs';

const entry = (name, value, expand = false) => ({ name, value, expand });

test('refreshes machine and user PATH and variables on every new command', () => {
  const base = {
    Path: 'old-path',
    TEMP: 'C:\\temp',
    USERPROFILE: 'C:\\Users\\tester',
    CCM_PERMISSION_PROFILE: 'workspace-write',
    CCM_PROXY: 'http://127.0.0.1:7890',
    LOCAL_ONLY: 'kept',
  };
  let userPath = '%USERPROFILE%\\new-bin';
  const readRegistry = (scope) => scope === 'Machine'
    ? new Map([
      ['PATH', entry('Path', 'C:\\Windows\\System32;%SystemRoot%\\Tools', true)],
      ['SYSTEMROOT', entry('SystemRoot', 'C:\\Windows')],
      ['SHARED', entry('SHARED', 'machine')],
      ['CCM_PROXY', entry('CCM_PROXY', 'malicious-machine')],
    ])
    : new Map([
      ['PATH', entry('Path', userPath, true)],
      ['SHARED', entry('shared', 'user')],
      ['CUSTOM', entry('Custom', 'enabled')],
      ['CCM_PERMISSION_PROFILE', entry('CCM_PERMISSION_PROFILE', 'full-access')],
    ]);
  const build = () => readCurrentCommandEnvironment(base, { platform: 'win32', readRegistry });
  const first = build();
  assert.equal(first.Path, 'C:\\Windows\\System32;C:\\Windows\\Tools;C:\\Users\\tester\\new-bin');
  assert.equal(first.shared, 'user');
  assert.equal(first.Custom, 'enabled');
  assert.equal(first.CCM_PERMISSION_PROFILE, 'workspace-write');
  assert.equal(first.CCM_PROXY, 'http://127.0.0.1:7890');
  assert.equal(first.LOCAL_ONLY, 'kept');
  assert.equal(Object.hasOwn(first, 'SHARED'), false);
  assert.equal(base.Path, 'old-path');
  userPath = 'D:\\new-tool';
  assert.equal(build().Path, 'C:\\Windows\\System32;C:\\Windows\\Tools;D:\\new-tool');
  assert.equal(first.Path.endsWith('new-bin'), true);
});

test('non-Windows commands retain their inherited process environment', () => {
  const base = { PATH: 'existing' };
  const actual = readCurrentCommandEnvironment(base, {
    platform: 'linux',
    readRegistry() { throw new Error('should not read Windows registry'); },
  });
  assert.deepEqual(actual, base);
  assert.notEqual(actual, base);
});

test('reads Windows registry values without executing a shell or using PATH lookup', () => {
  const calls = [];
  const values = windowsCommandEnvInternals.readRegistryEnvironment(
    'User',
    { SystemRoot: 'D:\\Windows' },
    (executable, args, options) => {
      calls.push({ executable, args, options });
      return {
        status: 0,
        stdout: 'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin\r\n    My Setting    REG_SZ    hello world\r\n',
      };
    },
  );
  assert.deepEqual(calls[0].args, ['query', 'HKCU\\Environment']);
  assert.equal(calls[0].executable, 'D:\\Windows\\System32\\reg.exe');
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(values.get('PATH'), entry('Path', '%USERPROFILE%\\bin', true));
  assert.deepEqual(values.get('MY SETTING'), entry('My Setting', 'hello world'));
});

test('registry read failure is reported instead of silently using stale PATH', () => {
  assert.throws(() => windowsCommandEnvInternals.readRegistryEnvironment(
    'Machine',
    { SystemRoot: 'C:\\Windows' },
    () => ({ status: 5, stdout: '', stderr: 'access denied' }),
  ), /Unable to read Windows Machine environment/);
});

test('reads the actual Windows registry into a command-only environment', {
  skip: process.platform !== 'win32',
}, () => {
  const current = readCurrentCommandEnvironment(process.env);
  assert.ok(current.Path.includes('Windows'));
  assert.equal(current.CCM_PERMISSION_PROFILE, process.env.CCM_PERMISSION_PROFILE);
  assert.notEqual(current, process.env);
});
