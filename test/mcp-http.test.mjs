import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkerRuntime } from '../src/runtime/index.mjs';
import { createControllerRuntime } from '../src/controller/runtime.mjs';
import { RemoteWorkerClient } from '../src/worker/remote-worker-client.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { createToolRegistry } from '../src/tools/index.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import {
  APPROVAL_UI_HTML,
  APPROVAL_UI_URI,
  LEGACY_APPROVAL_UI_URI,
  PREVIOUS_APPROVAL_UI_URI,
} from '../src/ui/approval-app.mjs';

test('health exposes connected abnormal environments as degraded', async () => {
  const runtime = {
    environmentRegistry: {
      defaultEnvironmentId: 'stale-worker',
      listPublic: () => [{
        id: 'stale-worker',
        name: 'stale-worker',
        platform: 'windows',
        shell: { type: 'powershell', path: 'powershell.exe' },
        capabilities: { exec: true },
        sandbox_read_scope: 'host',
        sandbox_write_scope: 'context_root',
        backend: 'remote-worker',
        is_default: true,
      }],
    },
    workerHub: {
      environmentStatus: () => ({
        state: 'abnormal',
        abnormal_code: 'unknown_method',
        abnormal_reason: 'Unknown Remote Worker method: list_projects',
      }),
    },
    async close() {},
  };
  const controller = createHttpController({
    toolRegistry: new ToolRegistry(),
    runtime,
    port: 0,
  });
  await controller.start();
  try {
    const response = await fetch(
      'http://127.0.0.1:' + controller.address.port + '/ccm/health',
      { headers: { Connection: 'close' } },
    );
    const health = await response.json();
    assert.equal(health.status, 'degraded');
    assert.equal(health.environments[0].state, 'abnormal');
    assert.equal(health.environments[0].abnormal_code, 'unknown_method');
  } finally {
    await controller.close();
  }
});

test('MCP lists and calls tools through a Remote Worker', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-mcp-'));
  const runtime = createControllerRuntime({
    // Test the explicit manual-approval path independently of the host's live Guardian setting.
    guardianReviewer: { isEnabled: () => false },
    workerPort: 0,
    auditLogFile: path.join(tempRoot, 'audit.jsonl'),
    codexPolicyStateFile: path.join(tempRoot, 'rules', 'default.rules'),
    trustedPackageScriptStateFile: path.join(tempRoot, 'trusted-package-scripts.json'),
    workspaceHandleStateFile: path.join(tempRoot, 'workspace-handles.json'),
    transferTaskStateFile: path.join(tempRoot, 'transfer-tasks.json'),
    fileTransferStateDir: path.join(tempRoot, 'file-transfers'),
    fileDownloadOrigin: () => 'https://example.test',
    planStateDir: path.join(tempRoot, 'plans'),
  });
  const workerRuntime = createWorkerRuntime({
    environment: {
      id: 'mcp-worker',
      cwd: tempRoot,
      permissionProfile: 'workspace-write',
    },
    projectlessRoot: path.join(tempRoot, 'projectless'),
  });
  await runtime.start();

  const worker = new RemoteWorkerClient({
    runtime: workerRuntime,
    workerId: 'mcp-worker',
    port: runtime.workerHub.address.port,
  });
  await worker.connect();
  await runtime.workerHub.waitForEnvironment('mcp-worker');

  const { registry } = createToolRegistry(runtime);
  const controller = createHttpController({ toolRegistry: registry, runtime, port: 0 });
  await controller.start();

  const client = new Client({ name: 'ccm-test-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + controller.address.port + '/ccm/mcp'),
  );

  try {
    await client.connect(transport);
    assert.match(client.getInstructions(), /CCM provides MCP tools for connected computers/);
    assert.match(client.getInstructions(), /Host chooses and sequences peer tools/);
    assert.match(client.getInstructions(), /keyboard\/mouse automation/);
    assert.doesNotMatch(client.getInstructions(), /resident\/long-running processes|visible console windows/);
    assert.doesNotMatch(client.getInstructions(), /rg --files/);
    assert.match(client.getInstructions(), /available proxy/);
    assert.match(client.getInstructions(), /historical compatibility/);
    assert.match(client.getInstructions(), /obsolete implementations, names and references/);
    assert.match(client.getInstructions(), /without defensive phrasing/);
    assert.match(client.getInstructions(), /Read applicable AGENTS.md/);
    assert.match(client.getInstructions(), /Maintain project README.md/);
    assert.match(client.getInstructions(), /verified absolute executable and file paths/);
    assert.match(client.getInstructions(), /Prefer root-cause fixes/);
    assert.doesNotMatch(client.getInstructions(), /code review findings first|retain actual uncertainty/i);
    assert.doesNotMatch(client.getInstructions(), /list_projects|workspace_handle|write_stdin|claim_full_access|plan_patch|publish|conversation|ExecPolicy|run_as_admin|request_approval|verification code/i,
      'tool-specific instructions must not pollute every tool discovery entry');
    assert.ok(client.getInstructions().length < 1600, 'Controller introduction should contain only Host defaults and server identity');
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, registry.list().map((tool) => tool.name).sort());
    assert.equal(names.length, 19);
    assert.equal(names.includes('create_projectless_handle'), false);
    for (const name of ['list_workers','claim_full_access',
      'plan_patch','plan_read','restart','import_chatgpt_file','conversation','publish',
      'transfer']) {
      assert.ok(names.includes(name), name + ' must be a top-level MCP tool');
    }
    const toolDescription = (name) => {
      const tool = listed.tools.find((item) => item.name === name);
      assert.ok(tool, name + ' must be present');
      return tool.description;
    };
    assert.match(toolDescription('list_workers'), /connection state/);
    assert.match(toolDescription('transfer'), /action=start \(default\)/);
    for (const name of ['transfer_path','transfer_status','transfer_cancel']) assert.ok(!names.includes(name));
    for(const name of ['list_projects','select_workspace','register_workspace','unregister_workspace']) assert.ok(!names.includes(name));
    assert.match(toolDescription('exec_command'), /omitted handles auto-create a projectless context/);
    assert.match(toolDescription('write_stdin'), /Empty chars polls are read-only/);
    assert.match(toolDescription('request_verification_input'), /automatic code-free follow-up/);
    assert.match(toolDescription('request_verification_input'), /Do NOT inspect or request the code/);
    assert.match(toolDescription('claim_full_access'), /Never request or expose phone enrollment secrets/);
    assert.match(toolDescription('plan_patch'), /implementation authorization/);
    assert.match(toolDescription('plan_patch'), /Summarize, do not paste the Plan/);
    assert.match(toolDescription('plan_read'), /lifecycle-neutral/);
    assert.match(toolDescription('publish'), /inspect actual screenshots/);
    assert.match(toolDescription('publish'), /withhold all links/);
    assert.match(toolDescription('conversation'), /chatgpt\.com\/share/);
    assert.match(toolDescription('conversation'), /聊天分享链接/);
    assert.match(toolDescription('conversation'), /Do not use web search, browsing or BMG/);
    assert.match(toolDescription('request_approval'), /CCM executes the action directly after approval/);
    const commandTool = listed.tools.find((tool) => tool.name === 'exec_command');
    assert.ok(commandTool.description.includes('When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)'));
    assert.match(commandTool.description, /resident\/long-running processes in the background without visible console windows/);
    assert.match(commandTool.description, /no-console process launch mode, not merely a hidden parent terminal/);
    assert.match(commandTool.description, /proactively supply a practical prefix_rule/);
    assert.match(commandTool.description, /run_as_admin=true uses an unrestricted administrator Agent after one-shot Guardian approval/);
    assert.match(commandTool.description, /state=review_failed, approval_required=false/);
    assert.match(commandTool.description, /If approval_required=true, call request_approval/);
    assert.match(commandTool.description, /proactively consider run_as_admin=true/);
    assert.match(commandTool.description, /Distinguish generic Access is denied, sandbox, path and network errors/);
    assert.match(commandTool.description, /Native Codex ExecPolicy/);
    assert.match(commandTool.description, /do not silently start a replacement session/);
    assert.ok(commandTool.description.length < 2700, 'exec_command description should stay compact including upstream search guidance');
    assert.ok(listed.tools.reduce((size, tool) => size + (tool.description?.length || 0), 0) < 18000,
      'total registered tool descriptions should stay within their context budget');
    assert.match(commandTool.inputSchema.properties.prefix_rule.description, /stable, narrowly useful ordered-token prefix/);
    const receiveFileTool = listed.tools.find((tool) => tool.name === 'import_chatgpt_file');
    assert.deepEqual(receiveFileTool._meta?.['openai/fileParams'], ['file']);
    assert.deepEqual(receiveFileTool.inputSchema.properties.file.required, ['download_url','file_id']);
    assert.equal(receiveFileTool.inputSchema.properties.file.additionalProperties, false);
    for (const name of ['resolve_pending_action','get_approval_status','submit_verification_input','get_verification_input_status']) {
      assert.deepEqual(listed.tools.find((tool) => tool.name === name)?._meta?.ui?.visibility, ['app']);
    }
    assert.equal(listed.tools.find((tool) => tool.name === 'request_approval')?._meta?.ui?.resourceUri, APPROVAL_UI_URI);
    assert.equal(listed.tools.find((tool) => tool.name === 'publish')?._meta?.ui?.resourceUri, undefined);
    assert.equal(listed.tools.find((tool) => tool.name === 'publish')?._meta?.['openai/outputTemplate'], undefined);
    const discovered = await client.callTool({name:'list_workers', arguments:{}});
    assert.equal(discovered.isError, undefined);
    assert.equal(discovered.structuredContent.default_environment_id, 'mcp-worker');
    assert.equal(discovered.structuredContent.environments[0].id, 'mcp-worker');
    assert.match(discovered.structuredContent.environments[0].connected_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Object.hasOwn(discovered.structuredContent.environments[0], 'projects'), false);
    const approvalResource = await client.readResource({ uri: APPROVAL_UI_URI });
    assert.equal(approvalResource.contents[0].text, APPROVAL_UI_HTML);
    assert.equal(approvalResource.contents[0]._meta.ui.prefersBorder, true);
    const legacyApprovalResource = await client.readResource({ uri: LEGACY_APPROVAL_UI_URI });
    assert.equal(legacyApprovalResource.contents[0].text, APPROVAL_UI_HTML);
    const previousApprovalResource = await client.readResource({ uri: PREVIOUS_APPROVAL_UI_URI });
    assert.equal(previousApprovalResource.contents[0].text, APPROVAL_UI_HTML);

    const projectless = await client.callTool({
      name: 'exec_command',
      arguments: { cmd: 'Write-Output AUTO_CONTEXT_OK' },
    });
    assert.equal(projectless.isError, undefined);
    const projectlessResult = projectless.structuredContent;
    const workspaceHandle = projectlessResult.workspace_handle;
    const workspaceRoot = projectlessResult.workspace_root;
    assert.equal(projectlessResult.workspace_kind, 'projectless');
    assert.match(projectlessResult.output, /AUTO_CONTEXT_OK/);

    await fs.writeFile(path.join(workspaceRoot, 'transfer-source.txt'), 'MCP transfer');
    const transfer = await client.callTool({
      name: 'transfer',
      arguments: { source_handle: workspaceHandle, source_path: 'transfer-source.txt', target_handle: workspaceHandle, target_path: 'transfer-target.txt' },
    });
    assert.equal(transfer.isError, undefined, JSON.stringify(transfer));
    const transferId = transfer.structuredContent.transfer_id;
    let transferState;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await client.callTool({ name: 'transfer', arguments: { action: 'status', transfer_id: transferId } });
      assert.equal(status.isError, undefined, JSON.stringify(status));
      transferState = status.structuredContent;
      if (['completed', 'failed', 'cancelled'].includes(transferState.state)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(transferState.state, 'completed', JSON.stringify(transferState));
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'transfer-target.txt'), 'utf8'), 'MCP transfer');
    const invalidTransfer = await client.callTool({ name: 'transfer', arguments: { action: 'status', transfer_id: transferId, source_path: 'invalid' } });
    assert.equal(invalidTransfer.isError, true);
    const cancelled = await client.callTool({ name: 'transfer', arguments: { action: 'cancel', transfer_id: transferId } });
    assert.equal(cancelled.isError, undefined);
    assert.equal(cancelled.structuredContent.state, 'completed');

    const seededWorkspace = workerRuntime.workspaceRegistry.listRegistered()[0];
    const { manageProject } = await import('../src/controller/project-management.mjs');
    const selectedWorkspace = await manageProject(runtime,'handle',{environment_id:'mcp-worker',workspace_id:seededWorkspace.workspace_id});
    assert.equal(selectedWorkspace.workspace_kind,'registered');
    assert.equal((await manageProject(runtime,'handle',{environment_id:'mcp-worker',workspace_id:seededWorkspace.workspace_id})).workspace_handle,selectedWorkspace.workspace_handle);

    const result = await client.callTool({
      name: 'exec_command',
      arguments: {
        workspace_handle: workspaceHandle,
        cmd: 'Write-Output MCP_OK',
      },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(Object.hasOwn(result, 'resultType'), false);
    assert.match(result.content[0].text, /MCP_OK/);
    assert.equal(result.structuredContent.workspace_kind, 'projectless');

    const escalationPending = await client.callTool({
      name: 'exec_command',
      arguments: {
        workspace_handle: workspaceHandle,
        cmd: 'Write-Output MCP_ESCALATED_OK',
        sandbox_permissions: 'require_escalated',
        justification: 'Allow this MCP test command once?',
      },
    });
    assert.equal(escalationPending.isError, undefined);
    assert.equal(escalationPending.structuredContent.approval_required, true);
    const escalation = await client.callTool({
      name: 'request_approval',
      arguments: {
        approval_id: escalationPending.structuredContent.approval_id,
      },
    });
    assert.equal(escalation.isError, undefined);
    assert.equal(escalation.structuredContent.approval_required, true);
    assert.match(escalation.content[0].text, /CCM executes the action directly after approval/i);
    assert.equal(typeof escalation._meta?.approval_nonce, 'string');

    const approvalId = escalation.structuredContent.approval_id;
    const escalatedResult = await client.callTool({
      name: 'resolve_pending_action',
      arguments: {
        approval_id: approvalId,
        approval_nonce: escalation._meta.approval_nonce,
        decision: 'approve',
      },
    });
    assert.equal(escalatedResult.isError, undefined);
    assert.match(escalatedResult.content[0].text, /MCP_ESCALATED_OK/);
    assert.equal(escalatedResult.structuredContent.state, 'consumed');

    const peerCore = await client.callTool({
      name: 'exec_command',
      arguments: { workspace_handle: workspaceHandle, cmd: 'Write-Output PEER_CORE_OK' },
    });
    assert.equal(peerCore.isError, undefined);
    assert.match(peerCore.structuredContent.output, /PEER_CORE_OK/);
    const patchResult = await client.callTool({
      name: 'apply_patch',
      arguments: {
        workspace_handle: workspaceHandle,
        patch: [
          '*** Begin Patch',
          '*** Add File: mcp.txt',
          '+patched through MCP',
          '*** End Patch',
        ].join('\n'),
      },
    });
    assert.equal(patchResult.isError, undefined);
    assert.match(patchResult.content[0].text, /A mcp\.txt/);
    assert.equal(
      await fs.readFile(path.join(workspaceRoot, 'mcp.txt'), 'utf8'),
      'patched through MCP\n',
    );

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2F+QAAAAASUVORK5CYII=',
      'base64',
    );
    await fs.writeFile(path.join(workspaceRoot, 'tiny.png'), png);
    const imageResult = await client.callTool({
      name: 'view_image', arguments: { workspace_handle: workspaceHandle, path: 'tiny.png' },
    });
    assert.equal(imageResult.isError, undefined);
    const image = imageResult.content.find((item) => item.type === 'image');
    assert.ok(image);
    assert.equal(image.mimeType, 'image/png');
    assert.equal(Buffer.from(image.data, 'base64').length, png.length);
    const docBytes = Buffer.alloc(3 * 1024 * 1024, 0x61);
    await fs.writeFile(path.join(workspaceRoot, 'preview.docx'), docBytes);
    const publishResult = await client.callTool({
      name: 'publish',
      arguments: { workspace_handle: workspaceHandle, path: 'preview.docx' },
    });
    assert.equal(publishResult.isError, undefined);
    assert.ok(!publishResult.content.some((item) => item.type === 'resource_link'));
    assert.match(publishResult.structuredContent.download_url, /^https:\/\/example\.test\/ccm\/download\//);
    assert.equal(publishResult.structuredContent.preview_url, undefined);
    assert.equal(publishResult.structuredContent.byte_length, docBytes.length);
    const token = publishResult.structuredContent.download_url.split('/').at(-1);
    assert.equal(publishResult.structuredContent.publication_id, token);
    const download = await fetch('http://127.0.0.1:' + controller.address.port + '/ccm/download/' + token);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), docBytes);

    const planLines = ['# Delivered plan', 'Formula: $E=mc^2$', ...Array.from({ length: 500 }, (_, i) => 'step ' + i)];
    const createdPlan = await runtime.planManager.create([
      '*** Begin Patch', '*** Add File: plan.md', ...planLines.map((line) => '+' + line), '*** End Patch',
    ].join('\n'));
    assert.equal((await runtime.planManager.read(createdPlan.plan_id)).truncated, true);
    const planPublish = await client.callTool({
      name: 'publish',
      arguments: { plan_id: createdPlan.plan_id },
    });
    assert.equal(planPublish.isError, undefined);
    assert.equal(planPublish.structuredContent.plan_id, createdPlan.plan_id);
    assert.equal(planPublish.structuredContent.environment_id, undefined);
    assert.equal(planPublish.structuredContent.markdown_truncated, false);
    assert.equal(planPublish.structuredContent.render_inspection.visual_review_required, true);
    const renderedShots = planPublish.content.filter((item) => item.type === 'image');
    if (process.env.CCM_RUN_PUBLISH_VISUAL_TEST === '1') assert.ok(renderedShots.length >= 1, 'publish must expose screenshots as MCP image content');
    assert.equal(renderedShots.length, planPublish.structuredContent.render_inspection.screenshot_count ?? 0);
    if (renderedShots.length) {
      assert.equal(renderedShots[0].mimeType, 'image/jpeg');
      assert.ok(Buffer.from(renderedShots[0].data, 'base64').length > 1000);
    } else {
      assert.equal(planPublish.structuredContent.render_inspection.status, 'unavailable');
      assert.match(planPublish.content[0].text, /visual review was not possible/);
    }
    assert.match(planPublish.structuredContent.preview_url, /^https:\/\/example\.test\/ccm\/preview\//);
    const planToken = planPublish.structuredContent.download_url.split('/').at(-1);
    assert.equal(planPublish.structuredContent.publication_id, planToken);
    const planDownload = await fetch('http://127.0.0.1:' + controller.address.port + '/ccm/download/' + planToken);
    assert.equal(planDownload.status, 200);
    assert.deepEqual(Buffer.from(await planDownload.arrayBuffer()), await runtime.planManager.snapshot(createdPlan.plan_id));
    const planPreview = await fetch('http://127.0.0.1:' + controller.address.port + '/ccm/preview/' + planToken);
    assert.equal(planPreview.status, 200);
    assert.match(planPreview.headers.get('content-type'), /^text\/html/);
    assert.match(await planPreview.text(), /<h1>Delivered plan<\/h1>/);

    const listedAgain = await client.listTools();
    assert.deepEqual(listedAgain.tools.map((tool) => tool.name).sort(), names);
  } finally {
    await client.close().catch(() => {});
    await worker.close().catch(() => {});
    workerRuntime.close();
    await controller.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});


test('MCP blocks oversized tool results before transport', async () => {
  const runtime = createWorkerRuntime();
  const registry = new ToolRegistry();
  registry.register({
    name: 'oversized_test',
    description: 'Test-only oversized result.',
    inputSchema: {},
    handler: async () => ({
      content: [{ type: 'text', text: 'x'.repeat(100_000) }],
    }),
  });
  const controller = createHttpController({
    toolRegistry: registry,
    runtime,
    port: 0,
    maxToolResultBytes: 65_536,
  });
  await controller.start();

  const port = controller.address.port;
  const client = new Client({ name: 'ccm-size-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + port + '/ccm/mcp'),
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'oversized_test',
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /blocked oversized tool result/);
    assert.ok(result.content[0].text.length < 1024);
  } finally {
    await client.close().catch(() => {});
    await controller.close();
  }
});
