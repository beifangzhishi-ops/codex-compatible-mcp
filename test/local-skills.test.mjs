import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createToolRegistry } from '../src/tools/index.mjs';

const root = fileURLToPath(new URL('../plugins/local-computer-tools/', import.meta.url));
const skillNames = ['qq', 'wechat', 'sjtu-mail', 'local-transcription', 'bilibili-dash', 'bmg-browser'];

test('local app entrypoints are six on-demand Skills, without additional MCP server', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'local-computer-tools');
  assert.equal(manifest.version, '0.1.1');
  assert.equal(fs.existsSync(path.join(root, 'mcp.json')), false);
  for (const name of skillNames) {
    const content = fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.ok(content.startsWith('---\nname: ' + name + '\n'));
    assert.match(content, /DESKTOP-KFL6V1F/);
  }
  for (const name of ['qq', 'wechat', 'sjtu-mail', 'local-transcription']) {
    const content = fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
    const body = content.split('---', 3)[2].trim();
    assert.match(body, /^# /);
    assert.equal((body.match(/^- /gm) || []).length, 2);
  }
});

test('BMG selection defaults are scoped by scenario rather than carried across tasks', () => {
  const content = fs.readFileSync(path.join(root, 'skills', 'bmg-browser', 'SKILL.md'), 'utf8');
  const [header, body] = content.split('---').slice(1);
  for (const trigger of ['知乎', '闲鱼', '微信公众号']) {
    assert.ok(header.includes(trigger), trigger + ' is discoverable');
    assert.equal(body.includes(trigger), false, trigger + ' should only be maintained in description');
  }
  assert.match(body, /Continue using BMG for follow-up tasks in the same category/);
  assert.match(body, /ask the user and use it only after they agree/);
  assert.match(body, /do not automatically switch to BMG even if lighter tools fail/);
});

test('the core tool catalog stays lean while Quark remains direct', () => {
  const { registry } = createToolRegistry({});
  const names = new Set(registry.list().map(tool => tool.name));
  assert.equal(names.size, 27);
  assert.equal(names.has('quark_upload'), true);
  assert.equal(names.has('exec_command'), true);
  assert.equal(names.has('conversation'), true);
});
