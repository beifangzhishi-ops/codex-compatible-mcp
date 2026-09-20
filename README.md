# CCM — Codex-Compatible MCP

CCM is a Codex-inspired execution harness for MCP clients. It focuses on a small, stable coding/execution surface, persistent process sessions, Remote Workers, native sandboxing, bounded tool output, patching, and image reads.

CCM does **not** attempt to reproduce Codex's model loop or own the host application's conversation history. The MCP client remains the orchestrator; CCM owns the execution world.

## Status

CCM is currently targeting **v0.1** as its first public release.

- Milestone 1 — Execution Core: implemented and regression-tested.
- Milestone 2 — Environment + Remote Worker: implemented and regression-tested.
- Milestone 3 — Editing (`apply_patch`, `view_image`): implemented and regression-tested.
- Milestone 4 — Tool Architecture / Code Mode: next.

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
   |- RemoteProcessManager / RemoteFileService
   '- WorkerHub
          |
          v
      Remote Worker
         |- native shell / filesystem semantics
         |- ProcessManager
         |- PTY
         |- native sandbox
         |- apply_patch
         '- view_image
```

Every execution environment uses the same Remote Worker protocol. The machine hosting the Controller is not a special execution backend: by default, `npm start` launches a normal Remote Worker locally and connects it through loopback.

Environment selection is per operation. A session may use a default environment, while individual calls can specify `environment_id`.

## Direct MCP tools

| Tool | Purpose |
| --- | --- |
| `list_environments` | Show connected execution environments and capabilities. |
| `exec_command` | Run a native shell command. Uses pipes by default; `tty=true` allocates a PTY. |
| `write_stdin` | Write to or poll a live process session returned by `exec_command`. |
| `apply_patch` | Apply Codex-style `*** Begin Patch` / `*** End Patch` edits on the selected Worker. |
| `view_image` | Read and validate a bounded PNG/JPEG/GIF/WebP image from the selected Worker. |

Normal repository inspection, search, Git, builds, tests, and diagnostics should usually go through `exec_command`.

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
| `CCM_WORKSPACE` | current directory | Worker cwd and default workspace root. |
| `CCM_PERMISSION_PROFILE` | `workspace-write` | `read-only`, `workspace-write`, or `full-access`. |
| `CCM_MAX_MCP_TOOL_RESULT_BYTES` | 2 MiB | Absolute serialized MCP tool-result limit. |
| `CCM_MAX_VIEW_IMAGE_BYTES` | 1 MiB | Maximum raw image size returned by `view_image`. |
| `CCM_WORKER_RECONNECT_MS` | 1000 ms | Worker reconnect delay. |

## Sandbox and platform support

Windows is the current fully supported restricted-execution platform.

`read-only` and `workspace-write` command execution use the CCM Windows native sandbox helper. PTY sessions use a Rust ConPTY backend aligned with the useful parts of Codex's current Windows PTY implementation. `full-access` runs with the Worker's normal host permissions.

Restricted command execution on Linux/macOS is not implemented yet and **fails closed** rather than silently running unsandboxed. A Linux/macOS Worker therefore currently needs `CCM_PERMISSION_PROFILE=full-access` for shell execution.

`apply_patch` enforces its own workspace-write boundary on the Worker, including real-path checks that reject symlink/junction escapes. `require_escalated` execution is rejected until a real approval/reviewer path exists.

## Output and transport protection

CCM treats oversized output as a reliability and context-safety problem.

Command capture is bounded, model-facing command output has a token budget, live process reads are incremental, Worker protocol messages have a hard serialized-size ceiling, final MCP tool results have an absolute byte limit, and `view_image` checks file size before reading/encoding it.

If a hard transport limit would be exceeded, CCM returns or triggers a compact failure instead of attempting to send an oversized response.

## MCP result compatibility

CCM returns standard MCP tool results directly. It does not add a custom result envelope such as `resultType`.

Text tools return normal `content: [{ type: "text", ... }]` results. `view_image` returns normal MCP image content. `structuredContent` is used only as the standard optional structured companion to `content`.

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
