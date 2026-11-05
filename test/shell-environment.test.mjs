import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createShellEnvironment,
  isNonInheritableEnvVar,
  matchesEnvironmentPattern,
  populateShellEnvironment,
  setToolCallIdEnvVar,
} from '../src/runtime/shell-environment.mjs';

const win = { platform: 'win32' };

test('Codex default shell environment inherits all and keeps KEY/TOKEN names', () => {
  assert.deepEqual(populateShellEnvironment({
    PATH: 'test', OPENAI_API_KEY: 'fixture', MY_TOKEN: 'fixture', OTHER: 'kept',
  }, {}, win), {
    PATH: 'test', OPENAI_API_KEY: 'fixture', MY_TOKEN: 'fixture', OTHER: 'kept',
  });
});

test('Codex core inheritance is platform-specific and case-insensitive', () => {
  const vars = { Shell: 'pwsh', SystemRoot: 'C:\\Windows', AppData: 'app',
    TmpDir: 'tmp', OPENAI_API_KEY: 'fixture', EXTRA: 'drop' };
  assert.deepEqual(populateShellEnvironment(vars, { inherit: 'core' }, win), {
    Shell: 'pwsh', SystemRoot: 'C:\\Windows', AppData: 'app', TmpDir: 'tmp',
  });
  assert.deepEqual(populateShellEnvironment({ HOME: '/home/a', PATH: '/bin',
    EXTRA: 'no' }, { inherit: 'core' }, { platform: 'linux' }), {
    HOME: '/home/a', PATH: '/bin',
  });
  assert.deepEqual(populateShellEnvironment(vars, { inherit: 'none' }, win), {});
});

test('Codex policy steps: default excludes, custom excludes, overrides, include_only', () => {
  const env = populateShellEnvironment({
    API_KEY: 'inherited', ACCESS_SECRET: 'inherited', USER_TOKEN: 'inherited',
    TEST_VALUE: 'original', OMIT_ME: 'remove', KEEP_ME: 'survive', PATH: '/bin',
  }, {
    ignore_default_excludes: false,
    exclude: ['omit*', 'test_*'],
    set: { TEST_VALUE: 'forced', API_KEY: 'forced', KEEP_NEW: 'added' },
    include_only: ['test_*', 'keep_*'],
  }, { platform: 'linux', threadId: 'thread-1' });
  assert.deepEqual(env, {
    TEST_VALUE: 'forced', KEEP_ME: 'survive', KEEP_NEW: 'added',
    CODEX_THREAD_ID: 'thread-1',
  });
});

test('Codex Windows overrides replace casing variants instead of duplicating', () => {
  assert.deepEqual(populateShellEnvironment({ GH_HOST: 'old' },
    { set: { gh_host: 'new' } }, win), { gh_host: 'new' });
  assert.deepEqual(populateShellEnvironment({ GH_HOST: 'old' },
    { set: { gh_host: 'new' } }, { platform: 'linux' }), {
    GH_HOST: 'old', gh_host: 'new',
  });
});

test('Codex restricted launch context is scrubbed after overrides', () => {
  const vars = {
    CODEX_GUARDIAN_DECISIONS_API_KEY: 'fixture',
    node_repl_auth_token: 'fixture',
    OPENAI_FEDERATION_RULE_ID: 'fixture',
    OPENAI_WORKLOAD_IDENTITY_CONTEXT: 'fixture',
  };
  const env = populateShellEnvironment(vars, {
    set: {
      SAFE: 'yes', Node_Repl_Auth_Token: 'fixture',
      OpenAI_Identity_Token_File: '/fixture',
      CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: 'fixture',
    },
  }, win);
  assert.deepEqual(env, { SAFE: 'yes' });
  assert.equal(isNonInheritableEnvVar('Codex_Exec_Server_Noise_Auth_Token'), true);
});

test('Codex wildcard matching is case-insensitive and works with question marks', () => {
  assert.equal(matchesEnvironmentPattern('aws_secret', 'AWS_*'), true);
  assert.equal(matchesEnvironmentPattern('API_TOKEN', '*token*'), true);
  assert.equal(matchesEnvironmentPattern('VAR_1', 'var_?'), true);
  assert.equal(matchesEnvironmentPattern('VAR_12', 'var_?'), false);
  assert.equal(matchesEnvironmentPattern('xTOKENy', '*TOKEN*'), true);
});

test('Codex Windows startup supplies missing PATHEXT after include filtering', () => {
  assert.deepEqual(createShellEnvironment({ TEST: 'value' }, {
    inherit: 'none', set: { TEXMFHOME: 'C:\\texmf' },
  }, win), { TEXMFHOME: 'C:\\texmf', PATHEXT: '.COM;.EXE;.BAT;.CMD' });
  assert.deepEqual(createShellEnvironment({ Pathext: 'own' }, {}, win), {
    Pathext: 'own',
  });
});

test('Codex tool-call id replaces Windows-equivalent casing and ignores NUL', () => {
  const env = { CODEX_TOOL_CALL_ID: 'old', Codex_Tool_Call_Id: 'older',
    OTHER: 'ok' };
  setToolCallIdEnvVar(env, 'new', win);
  assert.deepEqual(env, { OTHER: 'ok', CODEX_TOOL_CALL_ID: 'new' });
  setToolCallIdEnvVar(env, 'invalid\0id', win);
  assert.deepEqual(env, { OTHER: 'ok' });
});
