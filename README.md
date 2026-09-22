# CCM — Codex-Compatible MCP

CCM is a Codex-inspired execution harness for MCP clients. It focuses on a small, stable coding/execution surface, persistent process sessions, Remote Workers, native sandboxing, bounded tool output, patching, and image reads.

CCM does **not** attempt to reproduce Codex's model loop or own the host application's conversation history. The MCP client remains the orchestrator; CCM owns the execution world.

## Status

CCM is currently targeting **v0.1** as its first public release.

- Milestone 1 — Execution Core: implemented and regression-tested.
- Milestone 2 — Environment + Remote Worker: implemented and regression-tested.
- Milestone 3 — Editing (`apply_patch`, `view_image`): implemented and regression-tested.
- Milestone 4 — Tool Architecture / Code Mode: implemented and regression-tested.

The v0.1 release gate is defined in [PROJECT.md](PROJECT.md). v0.1 is intended to be directly publishable rather than a private prototype.

## Architecture

```text
MCP client
   |
   v
CCM Controller
   |- MCP HTTP server
   |- ToolRegistry
   |- Environment Registry
   |- Workspace Context Manager
   |- RemoteProcessManager / RemoteFileService
   '- WorkerHub
          |
          v
      Remote Worker
         |- native shell / filesystem semantics
         |- Worker-local Workspace Registry
         |- ProcessManager
         |- PTY
         |- native sandbox
         |- apply_patch
         '- view_image
```

Every execution environment uses the same Remote Worker protocol. The machine hosting the Controller is not a special execution backend: by default, `npm start` launches a normal Remote Worker locally and connects it through loopback.

Registered workspaces are owned by each Worker, not by the Controller. Entering or hot-registering a real project requires one-shot user approval and returns an opaque `workspace_context`. Normal development tools carry only that context. Workspace contexts are persisted by the Controller and remain valid across Controller or Worker restarts. Worker-local projectless mappings are persisted as well, so a surviving projectless directory can be resumed after a Worker restart.

When no real project is selected, create an explicit projectless context with the deferred `ccm.create_projectless_context` capability through `tool_search` + `exec`. Pass `environment_id` to create it on a specific Worker, or omit `environment_id` to use the primary environment. Projectless workspaces are created under `CCM_PROJECTLESS_ROOT` (default: the user's `Documents\\CCM` directory) and do not require workspace approval. Do not register temporary directories, `Documents`, drive roots, or other arbitrary paths merely to obtain an execution context.

## Direct MCP tools

| Tool | Purpose |
| --- | --- |
| `list_environments` | Show connected execution environments and capabilities. |
| `exec_command` | Run a native shell command inside an existing `workspace_context`. |
| `respond_to_escalation` | Record an explicit user decision for a pending one-shot CCM approval. |
| `write_stdin` | Write to or poll a live process session returned by `exec_command`. |
| `tool_search` | Discover deferred ToolRegistry capabilities without expanding the top-level MCP schema. |
| `exec` | Dispatch one or more nested registered capabilities, sequentially or safely in parallel. |
| `wait` | Resume a nested `exec` cell that yielded before completion. |

Normal repository inspection, search, Git, builds, tests, and diagnostics should usually go through `exec_command`.

### Core deferred capabilities

These are core CCM operations but intentionally stay off the top-level MCP schema. Discover them with `tool_search` and invoke them through `exec`.

| Capability | Purpose |
| --- | --- |
| `ccm.create_projectless_context` | Create a temporary projectless context on a chosen Worker, or on the primary Worker when no environment is specified. |
| `ccm.list_workspaces` | Discover registered projects on one Worker without entering them. |
| `ccm.select_workspace` | Enter an explicitly selected registered project after user approval. |
| `ccm.register_workspace` | Register and enter an explicitly selected project directory after user approval. |
| `ccm.apply_patch` | Apply a Codex-style patch inside an existing workspace context. |
| `ccm.view_image` | Read a bounded image inside an existing workspace context. |

## ToolRegistry and Code Mode

CCM stores capability exposure as three independent surfaces:

- **Direct** — included in MCP `tools/list`.
- **Deferred** — omitted from the initial schema and discoverable through `tool_search`.
- **Code Mode** — callable as a nested capability through `exec`.

Convenience states such as Direct, Deferred, CodeModeOnly, DirectModelOnly, DeferredModelOnly, and Hidden are derived from those surfaces rather than stored as one rigid enum.

The direct MCP surface is intentionally kept small and stable. New ordinary capabilities should default to the **Deferred + Code Mode** surfaces and be invoked through `tool_search` + `exec`. Add a new top-level Direct tool only when the capability is fundamental to bootstrapping, environment discovery, explicit approval, process continuation, or nested-tool discovery/dispatch.

Keeping ordinary additions off the Direct surface prevents routine feature work from changing the client's top-level MCP schema. In particular, adding a deferred capability should **not require deleting and recreating the CCM integration in ChatGPT or another MCP client**. Updating CCM server code may still require restarting the Controller and/or Worker processes so the new implementation is loaded; that is separate from recreating the client integration.

Do not promote a capability to Direct merely for convenience. Prefer a deferred `ccm-extra.*` or other namespaced capability when the operation can be discovered and called through `tool_search` + `exec`. Existing examples include `ccm.view_image` and the bundled `ccm-extra.*` workflows below.

CCM deliberately does not embed a second JavaScript interpreter for Code Mode. The host application remains responsible for loops, branching, and data processing. CCM's `exec/wait` pair is a bounded structured dispatcher over ToolRegistry capabilities. `state=completed` is terminal. If nested dispatch has finished but an `exec_command` leaves a live process session, CCM returns `state=awaiting_io` with `next_operation=write_stdin` until those process sessions are continued separately.

### ChatGPT Share conversation export

`ccm-extra.chatgpt_share_export` exports public ChatGPT Share conversations without BMG or browser automation.

Supported features:

- `mode=text`: readable user/assistant conversation export.
- `mode=full`: preserves all message records exposed by the Share payload, including system/tool records and message metadata.
- ranch=active: follows the current Share branch when available.
- ranch=all: exports all mapping nodes for debugging or archival.
- Markdown and JSON output formats.
- `output_path` is optional. Omitted or relative paths are written under the Git-ignored `.cache/chatgpt-share-export/` directory; absolute paths are honored directly.
- Non-text messages such as image-only messages are retained rather than silently dropped.

The exporter only recovers information present in the public Share payload. Information removed upstream by ChatGPT is not recoverable.

### Bundled specialized deferred capabilities

CCM ships optional Windows workflows ported from WCM without expanding the top-level MCP schema:

- `ccm-extra.research_ppt_pipeline` returns the user-validated research PowerPoint production workflow, including production-mode selection, source/image review, canonical per-slide specs, mandatory `ccm-extra.send_file` delivery of Imagegen reference images, GPT decide-and-auto-advance handling of returned slide images, QA, mandatory whole-deck user review, and mode-specific delivery.
- `ccm-extra.send_file` transfers an exact file from a selected CCM environment to the GPT client only when a user-facing handoff is actually needed (preview/download/upload to another tool). It returns a temporary MCP `resource_link`; after the client approves/materializes it, `resources/read` serves the exact file bytes from a bounded TTL cache. Do not use it merely for model-side inspection when the file can be read or viewed locally in CCM; prefer local reading, `view_image`, command-line inspection, or temporary local previews to avoid unnecessary materialization/approval prompts. The transfer does not use BMG or Library upload.
- `ccm-extra.quark_upload` submits one or more files through that local Quark desktop session and can wait for verified completion.
- `ccm-extra.bilibili_download_dash` downloads signed DASH video/audio URLs obtained from an authenticated browser session and remuxes them with `ffmpeg -c copy`.

Discover them with `tool_search` (for example, `quark upload` or `bilibili`) and invoke them through `exec`. Long uploads/downloads may return a live process session; continue that session with the top-level `write_stdin` tool.

The Quark helper reuses only the login state of the local Quark desktop client and does not export account credentials. The Bilibili helper intentionally leaves authenticated `playurl` discovery to the browser/BMG layer and accepts only the resulting short-lived signed media URLs; it does not export cookies or attempt to bypass account/quality restrictions.



## Requirements

CCM requires Node.js 20 or newer and a Rust toolchain with Cargo.

On Windows, building the native execution helpers also requires Visual Studio 2022 Build Tools with the C++ toolchain and the Windows .NET Framework C# compiler. `scripts/build-native.mjs` locates these automatically when they are installed in standard locations.

## Quick start

```powershell
git clone <your-ccm-repository-url>
cd codex-compatible-mcp
npm ci
npm test
npm start
```

By default:

```text
MCP endpoint:  http://127.0.0.1:18209/ccm/mcp
Health:        http://127.0.0.1:18209/ccm/health
WorkerHub:     127.0.0.1:18301
```

`npm start` builds the native helpers first, starts the Controller, then launches one local Remote Worker unless `CCM_SPAWN_LOCAL_WORKER=0`.

A standalone Worker can be started with:

```powershell
npm run worker
```

The `preworker` script builds the native helper for the current platform first.

## Windows scheduled-task operation

CCM includes public Task Scheduler helpers for both Controller hosts and standalone Remote Workers. They run hidden under the current Windows user, start at logon, use `IgnoreNew` to avoid duplicate instances, and configure Task Scheduler restart-on-failure behavior. Each supervisor also restarts its own child process if that child exits unexpectedly.

For a Controller machine that should run the Controller, its local Worker, and the OAuth sidecar as one service group:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-ccm-autostart.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\ccm-status.ps1
```

Remove it with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-ccm-autostart.ps1
```

For a standalone Windows Remote Worker, first create its ignored runtime config:

```powershell
Copy-Item .\config\worker.env.example .\config\worker.env
notepad .\config\worker.env
```

Set at least `CCM_WORKER_HUB_CONNECT_HOST` and `CCM_WORKSPACE`; normally also give the Worker a stable `CCM_ENVIRONMENT_ID`. Then install and inspect the Worker task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-ccm-worker-autostart.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\ccm-worker-status.ps1
```

Remove it with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-ccm-worker-autostart.ps1
```

The Remote Worker supervisor reads `config/worker.env` itself, builds the native helpers on startup, and launches `src/worker/agent.mjs`. The Worker agent owns connection retry/reconnect behavior, so temporary Controller/network loss does not cause a process restart. `config/worker.env`, PID files, and supervisor logs are local runtime state and are not committed.

The Worker task installer resolves the current fully qualified Windows identity for both the logon trigger and task principal. This also supports machines whose hostname and local username are identical.

## OAuth-protected public endpoint

For ChatGPT/plugin use, expose the OAuth sidecar rather than the raw Controller.

CCM's OAuth gateway follows the same deployment pattern proven in WCM:

- OAuth 2.0 authorization code flow with PKCE S256
- dynamic public-client registration
- Protected Resource Metadata and Authorization Server Metadata
- bearer access tokens, refresh-token rotation, and revocation
- a local approval secret required at consent time
- only the OAuth sidecar is exposed through HTTPS ingress; the Controller and WorkerHub stay private

Prepare a local deployment:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\ccm-enable-oauth.ps1 `
  -PublicBaseUrl https://your-machine.your-tailnet.ts.net
npm run public
```

The default local ports are:

```text
OAuth sidecar: 127.0.0.1:18208
MCP Controller: 127.0.0.1:18209
WorkerHub:      127.0.0.1:18301
```

For Tailscale Funnel, apply the path routes after the sidecar is healthy:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-ccm-funnel.ps1 -Apply
```

The public MCP resource is `https://<host>/ccm/mcp`. Runtime OAuth configuration is stored in ignored `config/ccm.env`; OAuth tokens/state and the local approval secret remain under ignored `.state/`.

## Remote Worker example

The WorkerHub has no authentication or transport encryption in v0.1. Keep it on loopback or a trusted/private network.

On the Controller:

```powershell
$env:CCM_SPAWN_LOCAL_WORKER = "0"
$env:CCM_WORKER_HUB_BIND_HOST = "0.0.0.0"
npm start
```

On a trusted remote Windows Worker:

```powershell
$env:CCM_WORKER_HUB_CONNECT_HOST = "<controller-private-ip>"
$env:CCM_WORKER_HUB_PORT = "18301"
$env:CCM_ENVIRONMENT_ID = "build-windows"
$env:CCM_WORKSPACE = "C:\work\project"
$env:CCM_PERMISSION_PROFILE = "workspace-write"
npm run worker
```

The legacy `CCM_WORKER_HUB_HOST` variable is accepted as a fallback for both bind and connect configuration, but new deployments should use the explicit bind/connect variables.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CCM_HOST` | `127.0.0.1` | MCP HTTP bind host. |
| `CCM_PORT` | `18209` | MCP HTTP port. |
| `CCM_MCP_PATH` | `/ccm/mcp` | MCP endpoint path. |
| `CCM_WORKER_HUB_BIND_HOST` | `127.0.0.1` | Controller-side WorkerHub bind host. |
| `CCM_WORKER_HUB_CONNECT_HOST` | `127.0.0.1` | Worker-side Controller address. |
| `CCM_WORKER_HUB_PORT` | `18301` | WorkerHub TCP port. |
| `CCM_SPAWN_LOCAL_WORKER` | enabled | Set to `0` to prevent `npm start` from spawning a local Worker. |
| `CCM_ENVIRONMENT_ID` | OS hostname | Environment id advertised by a Worker. |
| `CCM_WORKER_ID` | environment id | Worker connection id. |
| `CCM_WORKSPACE` | current directory | Legacy/default project root; seeded into the Worker's registered-workspace registry. |
| `CCM_PROJECTLESS_ROOT` | `~/Documents/CCM` | Root used for automatically created projectless workspaces. |
| `CCM_WORKSPACE_REGISTRY_FILE` | `<install>/.state/workspaces.json` for the packaged Worker | Worker-local registered and projectless workspace registry. |
| `CCM_WORKSPACE_CONTEXT_FILE` | `<install>/.state/workspace-contexts.json` for the packaged Controller | Persistent Controller workspace-context registry. |
| `CCM_PERMISSION_PROFILE` | `workspace-write` | `read-only`, `workspace-write`, or `full-access`. |
| `CCM_MAX_MCP_TOOL_RESULT_BYTES` | 2 MiB | Serialized MCP tool-result limit for ordinary results. |
| `CCM_MAX_MCP_FILE_RESULT_BYTES` | 24 MiB | Serialized MCP result limit when returning an embedded file resource. |
| `CCM_MAX_VIEW_IMAGE_BYTES` | 1 MiB | Maximum raw image size returned by `view_image`. |
| `CCM_MAX_SEND_FILE_BYTES` | 12 MiB | Maximum raw file size returned by `ccm-extra.send_file`. |
| `CCM_FILE_TRANSFER_TTL_MS` | 900000 ms | Lifetime of temporary `send_file` resource links. |
| `CCM_FILE_TRANSFER_CACHE_BYTES` | 64 MiB | Maximum total raw bytes retained for temporary file-resource reads. |
| `CCM_WORKER_RECONNECT_MS` | 1000 ms | Worker reconnect delay. |

## Sandbox and platform support

Windows is the current fully supported restricted-execution platform.

`read-only` and `workspace-write` command execution use the CCM Windows native sandbox helper. For `exec_command`, `workspace-write` means **host-permitted filesystem reads plus workspace-only writes**: `workspace_roots` are project/write boundaries, not read boundaries. The Worker can read outside the selected workspace wherever its Windows host account already has read permission, while writes outside the workspace require explicit one-shot escalation. Other CCM tools may intentionally have narrower workspace-only access; for example, `apply_patch` keeps its own workspace boundary. PTY sessions use a Rust ConPTY backend aligned with the useful parts of Codex's current Windows PTY implementation. `full-access` runs with the Worker's normal host permissions.

Restricted command execution on Linux/macOS is not implemented yet and **fails closed** rather than silently running unsandboxed. A Linux/macOS Worker therefore currently needs `CCM_PERMISSION_PROFILE=full-access` for shell execution.

`apply_patch` enforces its own workspace-write boundary on the Worker, including real-path checks that reject symlink/junction escapes. `exec_command` can cross the command sandbox only through the one-shot approval flow below.

### One-shot sandbox escalation

Restricted Workers support an explicit one-shot escalation flow for `exec_command`.

When `sandbox_permissions=require_escalated` is requested on a `read-only` or `workspace-write` environment, CCM does not execute the command immediately. It returns an `approval_required` result containing the selected environment, exact command, execution context, justification, a short-lived approval id, and a SHA-256 hash of the frozen execution intent.

The host should show that request to the user and wait. After the user explicitly approves it, the host calls `respond_to_escalation` with `decision=approve`, then retries the exact same `exec_command` with the returned `approval_id`. The grant:

- is valid for five minutes,
- can be consumed only once,
- is bound to the environment, command, working directory, shell, and TTY mode,
- runs that one command with `full-access`,
- cannot be reused after execution,
- does not create a persistent allow rule.

Changing the command or execution context requires a new approval. Denied and expired requests cannot execute.

This approval mechanism controls CCM's sandbox boundary; it does **not** grant Windows Administrator/UAC privileges. Also, MCP currently provides no cryptographic proof that an approval tool call originated from a human message. CCM enforces the frozen one-shot grant, while the ChatGPT/host interaction layer is responsible for calling `respond_to_escalation` only after an explicit user decision. A separately authenticated consent UI would be required for CCM itself to independently verify human presence.

## Output and transport protection

CCM treats oversized output as a reliability and context-safety problem.

Command capture is bounded, model-facing command output has a token budget, live process reads are incremental, Worker protocol messages have a hard serialized-size ceiling, final MCP tool results have an absolute byte limit, and `view_image` checks file size before reading/encoding it.

If a hard transport limit would be exceeded, CCM returns or triggers a compact failure instead of attempting to send an oversized response.

## MCP result compatibility

CCM returns standard MCP tool results directly. It does not add a custom result envelope such as `resultType`.

Text tools return normal `content: [{ type: "text", ... }]` results. `view_image`
returns normal MCP image content and keeps its file metadata in result `_meta`,
so multimodal clients can preserve the image block instead of reducing the
result to structured-only output. Other tools may use `structuredContent` as
the standard optional structured companion to `content`.

`view_image` is a deferred Code Mode capability invoked through the stable
top-level `exec` dispatcher. `exec` passes nested MCP `image` content through
directly while compacting the duplicate structured result, so the model can
receive the image without attaching an MCP Apps output template or creating a
widget card for every image. Later `view_image` schema and implementation
changes therefore do not require refreshing the top-level MCP tool list.

## Security notes

Both the MCP HTTP server and WorkerHub bind to loopback by default. v0.1 does not provide authentication or TLS for the WorkerHub. Do not expose it directly to an untrusted network.

The Controller routes execution but does not execute repository commands itself. Shell, PTY, sandbox, patch, and image filesystem operations happen inside the selected Remote Worker.

Generated native binaries, Cargo build output, dependency directories, runtime state, logs, and local environment files are excluded from Git.

## Development

```powershell
npm ci
npm run build:native
npm test
```

The regression suite covers process exit semantics, PTY interaction, sandbox behavior, long-running sessions, oversized MCP results, multi-Worker routing, disconnect cleanup, patch preflight verification, workspace and symlink/junction boundaries, image validation, and MCP end-to-end calls.

See [PROJECT.md](PROJECT.md) for architecture decisions, Codex source-alignment notes, and the performance-first roadmap.

## License

Original CCM code is licensed under the MIT License. See [LICENSE](LICENSE).

Some native PTY source files are copied or derived from OpenAI Codex (Apache-2.0) and WezTerm (MIT). Their notices and applicable license text are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES](LICENSES/).
