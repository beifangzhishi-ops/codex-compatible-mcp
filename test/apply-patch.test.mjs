import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPatchToEnvironment } from '../src/runtime/filesystem/codex-apply-patch-bridge.mjs';

async function tempEnvironment(permissionProfile = 'workspace-write') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-patch-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  return {
    root,
    workspace,
    environment: {
      id: 'patch-test',
      platform: process.platform,
      cwd: workspace,
      workspaceRoots: [workspace],
      permissionProfile,
    },
  };
}

async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}
test('apply_patch supports add, delete, update, and move', async () => {
  const fixture = await tempEnvironment();
  try {
    await fs.writeFile(
      path.join(fixture.workspace, 'update.txt'),
      'function f() {\n  old\n}\n',
    );
    await fs.writeFile(path.join(fixture.workspace, 'delete.txt'), 'bye\n');

    const patch = [
      '*** Begin Patch',
      '*** Add File: added.txt',
      '+hello',
      '*** Delete File: delete.txt',
      '*** Update File: update.txt',
      '*** Move to: moved.txt',
      '@@',
      ' function f() {',
      '-  old',
      '+  new',
      ' }',
      '*** End Patch',
    ].join('\n');

    const result = await applyPatchToEnvironment({
      environment: fixture.environment,
      patch,
    });

    assert.match(result.output, /Success\. Updated the following files:/);
    assert.match(result.output, /A added\.txt/);
    assert.match(result.output, /D delete\.txt/);
    assert.match(result.output, /M moved\.txt/);
    assert.equal(await fs.readFile(path.join(fixture.workspace, 'added.txt'), 'utf8'), 'hello\n');
    assert.equal(await fs.readFile(path.join(fixture.workspace, 'moved.txt'), 'utf8'), 'function f() {\n  new\n}\n');
    await assert.rejects(fs.stat(path.join(fixture.workspace, 'update.txt')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(fixture.workspace, 'delete.txt')), /ENOENT/);
  } finally {
    await cleanup(fixture.root);
  }
});
test('fuzzy context matching preserves real context indentation', async () => {
  const fixture = await tempEnvironment();
  try {
    const target = path.join(fixture.workspace, 'indent.txt');
    await fs.writeFile(target, 'start\n    keep\nold\nend\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: indent.txt',
      '@@',
      ' start',
      ' keep',
      '-old',
      '+new',
      ' end',
      '*** End Patch',
    ].join('\n');

    await applyPatchToEnvironment({
      environment: fixture.environment,
      patch,
    });

    assert.equal(
      await fs.readFile(target, 'utf8'),
      'start\n    keep\nnew\nend\n',
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('Codex preserves earlier applied hunks when a later hunk fails', async () => {
  const fixture = await tempEnvironment();
  try {
    const target = path.join(fixture.workspace, 'stable.txt');
    await fs.writeFile(target, 'old\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: stable.txt',
      '@@',
      '-old',
      '+new',
      '*** Update File: missing.txt',
      '@@',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n');

    await assert.rejects(
      applyPatchToEnvironment({ environment: fixture.environment, patch }),
      /missing\.txt/,
    );
    assert.equal(await fs.readFile(target, 'utf8'), 'new\n');
  } finally {
    await cleanup(fixture.root);
  }
});
test('workspace-write rejects targets outside workspace roots', async () => {
  const fixture = await tempEnvironment();
  try {
    const outside = path.join(fixture.root, 'outside.txt');
    await fs.writeFile(outside, 'old\n');

    const patch = [
      '*** Begin Patch',
      '*** Update File: ' + outside,
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');

    await assert.rejects(
      applyPatchToEnvironment({ environment: fixture.environment, patch }),
      /outside workspace roots/,
    );
    assert.equal(await fs.readFile(outside, 'utf8'), 'old\n');
  } finally {
    await cleanup(fixture.root);
  }
});

test('workspace-write rejects symlink or junction escapes', async () => {
  const fixture = await tempEnvironment();
  try {
    const outsideDir = path.join(fixture.root, 'outside-dir');
    const linkedDir = path.join(fixture.workspace, 'linked');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(
      outsideDir,
      linkedDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const patch = [
      '*** Begin Patch',
      '*** Add File: linked/escape.txt',
      '+blocked',
      '*** End Patch',
    ].join('\n');

    await assert.rejects(
      applyPatchToEnvironment({ environment: fixture.environment, patch }),
      /Failed to write file/,
    );
    await assert.rejects(
      fs.stat(path.join(outsideDir, 'escape.txt')),
      /ENOENT/,
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('Codex Add File and Move to overwrite existing destinations', async () => {
  const fixture = await tempEnvironment();
  try {
    await fs.writeFile(path.join(fixture.workspace, 'existing.txt'), 'before\n');
    await fs.writeFile(path.join(fixture.workspace, 'source.txt'), 'source\n');
    await fs.writeFile(path.join(fixture.workspace, 'destination.txt'), 'prior\n');
    const patch = [
      '*** Begin Patch',
      '*** Add File: existing.txt',
      '+overwritten',
      '*** Update File: source.txt',
      '*** Move to: destination.txt',
      '@@',
      '-source',
      '+moved',
      '*** End Patch',
    ].join('\n');
    const result = await applyPatchToEnvironment({ environment: fixture.environment, patch });
    assert.equal(await fs.readFile(path.join(fixture.workspace, 'existing.txt'), 'utf8'), 'overwritten\n');
    assert.equal(await fs.readFile(path.join(fixture.workspace, 'destination.txt'), 'utf8'), 'moved\n');
    await assert.rejects(fs.stat(path.join(fixture.workspace, 'source.txt')), /ENOENT/);
    assert.match(result.output, /M destination\.txt/);
  } finally {
    await cleanup(fixture.root);
  }
});

test('Codex updates preserve mixed original line endings', async () => {
  const fixture = await tempEnvironment();
  try {
    const target = path.join(fixture.workspace, 'mixed.txt');
    await fs.writeFile(target, 'alpha\r\nbeta\ncharlie\r\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: mixed.txt',
      '@@',
      ' alpha',
      '-beta',
      '+bravo',
      ' charlie',
      '*** End Patch',
    ].join('\n');
    await applyPatchToEnvironment({ environment: fixture.environment, patch });
    assert.equal(await fs.readFile(target, 'utf8'), 'alpha\r\nbravo\r\ncharlie\r\n');
  } finally {
    await cleanup(fixture.root);
  }
});

test('Codex accepts lenient heredoc input in the native parser', async () => {
  const fixture = await tempEnvironment();
  try {
    await applyPatchToEnvironment({
      environment: fixture.environment,
      patch: "<<'EOF'\n*** Begin Patch\n*** Add File: heredoc.txt\n+from codex\n*** End Patch\nEOF\n",
    });
    assert.equal(
      await fs.readFile(path.join(fixture.workspace, 'heredoc.txt'), 'utf8'),
      'from codex\n',
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('read-only patch is denied, full-access patch can target outside root', async () => {
  const fixture = await tempEnvironment();
  try {
    const outside = path.join(fixture.root, 'outside.txt');
    const patch = [
      '*** Begin Patch',
      '*** Add File: ' + outside,
      '+approved',
      '*** End Patch',
    ].join('\n');
    await assert.rejects(applyPatchToEnvironment({
      environment: { ...fixture.environment, permissionProfile: 'read-only' },
      patch,
    }), /read-only/);
    await assert.rejects(fs.stat(outside), /ENOENT/);
    await applyPatchToEnvironment({
      environment: { ...fixture.environment, permissionProfile: 'full-access' },
      patch,
    });
    assert.equal(await fs.readFile(outside, 'utf8'), 'approved\n');
  } finally {
    await cleanup(fixture.root);
  }
});
