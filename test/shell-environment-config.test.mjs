import test from 'node:test';
import assert from 'node:assert/strict';
import { codexConfigPath, parseCodexShellEnvironmentPolicy } from
  '../src/runtime/shell-environment-config.mjs';

test('Codex TOML shell_environment_policy has true default for ignore_default_excludes', () => {
  assert.deepEqual(parseCodexShellEnvironmentPolicy(''), {
    inherit: 'all',
    ignore_default_excludes: true,
    exclude: [],
    set: {},
    include_only: [],
    use_profile: false,
  });
});

test('Codex TOML shell_environment_policy accepts nested set values and legacy filters', () => {
  const result = parseCodexShellEnvironmentPolicy(`
[shell_environment_policy]
inherit = "core"
ignore_default_excludes = false
exclude = ["AWS_*"]
include_only = ["PATH", "TEXMFHOME"]
experimental_use_profile = true
[shell_environment_policy.set]
TEXMFHOME = "C:\\\\texmf"
PATH = "C:\\\\texlive"
`);
  assert.deepEqual(result, {
    inherit: 'core', ignore_default_excludes: false,
    exclude: ['AWS_*'], include_only: ['PATH', 'TEXMFHOME'],
    set: { TEXMFHOME: 'C:\\texmf', PATH: 'C:\\texlive' },
    use_profile: true,
  });
});

test('Codex canonical TOML filters map actions into case-insensitive patterns', () => {
  const result = parseCodexShellEnvironmentPolicy(`
[shell_environment_policy.filters]
"AWS_*" = "exclude"
"PATH" = "include"
`);
  assert.deepEqual(result.exclude, ['AWS_*']);
  assert.deepEqual(result.include_only, ['PATH']);
  assert.throws(() => parseCodexShellEnvironmentPolicy(`
[shell_environment_policy]
exclude = ["A"]
[shell_environment_policy.filters]
"A" = "exclude"
`), /cannot mix filters/);
  assert.throws(() => parseCodexShellEnvironmentPolicy(`
[shell_environment_policy.filters]
"PATH" = "include"
"path" = "exclude"
`), /Duplicate shell environment filter/);
});

test('Codex config location honors CODEX_HOME', () => {
  assert.equal(codexConfigPath({ CODEX_HOME: 'D:\\context' }, 'C:\\Users\\tester'),
    'D:\\context\\config.toml'.replace(/\\/g, import.meta.url.startsWith('file:///C:') ? '\\' : '/'));
});
