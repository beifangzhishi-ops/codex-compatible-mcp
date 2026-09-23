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

Registered workspaces are owned by each Worker, not by the Controller. Entering or hot-registering a real project requires one-shot user approval and returns an opaque `workspace_context`. Direct `select_workspace` / `register_workspace` calls freeze the exact workspace action and render the CCM approval app; when the user approves, CCM performs the frozen action itself and returns the resulting context without a model-generated retry. `register_workspace` combines registration and entry; with `create_if_missing=true`, the same approval may also create the exact missing project directory before registration, so a new project does not need a separate shell mkdir approval followed by workspace approval. Normal development tools carry only the resulting context. Workspace contexts are persisted by the Controller and remain valid across Controller or Worker restarts. Worker-local projectless mappings are persisted as well, so a surviving projectless directory can be resumed after a Worker restart.

An environment does not expose a default workspace or default working directory to the MCP client. Worker bootstrap cwd is an internal/legacy runtime seed only; it is not a project-location hint, a default project, or the parent directory for newly created projects. CCM deliberately has no "Projects Root" policy: project placement comes from the user or the upper-layer orchestrator.

When no real project is selected, create an explicit projectless context with the deferred `ccm.create_projectless_context` capability through `tool_search` + `exec`. Pass `environment_id` to create it on a specific Worker, or omit `environment_id` to use the primary environment. Projectless workspaces are created under `CCM_PROJECTLESS_ROOT` (default: the user's `Documents\\CCM` directory) and do not require workspace approval. Do not register temporary directories, `Documents`, drive roots, or other arbitrary paths merely to obtain an execution context.

### Identity and lifecycle terminology

CCM deliberately keeps transport identity, execution identity, process identity, and higher-level task state separate. Do not use the word "session" interchangeably for these concepts.

- **Host conversation / ChatGPT conversation**: conversation state owned by the MCP client. CCM does not own it and must not assume a one-to-one mapping between a host conversation and an MCP session.
- **MCP session**: the current CCM HTTP implementation's stateful Streamable HTTP protocol/transport session. It is created during MCP initialization, identified by the `Mcp-Session-Id` header, and used by the Controller to find the corresponding transport and protocol server. It may span multiple user turns, and a single host conversation may create more than one MCP session because of reconnects, fresh initialization, Controller restart, or other client lifecycle events. **An MCP session is not a durable task, plan, workspace, or conversation identifier.**
- **Process session (`session_id`)**: a live command/process continuation handle returned by `exec_command` and consumed by `write_stdin`. It identifies one running process session and is unrelated to `Mcp-Session-Id`. Continuation is scoped by the pair `(workspace_context, session_id)`; callers must pass the same `workspace_context` that created the process.
- **Workspace context (`workspace_context`)**: an opaque logical execution-context identifier that binds a Worker and workspace/projectless root. Workspace contexts are persisted independently of MCP transport sessions and may remain valid across Controller or Worker restarts.
- **Approval (`approval_id`)**: a one-shot authorization record for one exact escalated operation or workspace entry attempt. It is neither an MCP session nor a workspace context.
- **Plan**: a logical planning cycle, if/when Plan Mode is used. One MCP session may contain zero, one, or multiple plans. A persisted plan may outlive the MCP session that created it. A session-scoped "active plan" pointer is only a convenience for multi-turn continuity and must never redefine the MCP session itself as the plan identity.

Useful cardinality rules:

```text
host conversation  -> 0..N MCP sessions
MCP session        -> 0..N process sessions
MCP session        -> 0..N logical plans
workspace_context  -> independent of MCP session lifetime
persisted plan     -> may outlive MCP session lifetime
```

When adding stateful features, choose an identity according to the feature's real lifecycle. Do not key durable intent solely by `Mcp-Session-Id` merely because it is convenient at the transport layer.

## Direct MCP tools

| Tool | Purpose |
| --- | --- |
| `list_environments` | Show connected execution environments, capabilities, and coarse effective filesystem read/write scope. |
| `exec_command` | Run a native shell command inside an existing `workspace_context`. |
| `request_escalated_exec` | Freeze one full-access command and render the CCM approval app; this tool does not execute the command. |
| `select_workspace` | Freeze entry into one registered workspace and render the CCM approval app; approval completes the entry and returns `workspace_context`. |
| `register_workspace` | Freeze registration/entry of one exact project path and render the CCM approval app; `create_if_missing=true` can create that exact path after approval. |
| `resolve_pending_action` | App-only resolver used by the CCM approval app to approve/deny and resume a frozen execution or workspace action. It is hidden from normal model use through MCP Apps visibility metadata. |
| `respond_to_escalation` | Legacy explicit-decision endpoint retained only for already-issued legacy approvals and Code Mode compatibility. New direct approval-card requests cannot be resolved here. |
| `write_stdin` | Write to or poll a live process session returned by `exec_command`; requires both `session_id` and the owning `workspace_context`. |
| `apply_patch` | Apply a Codex-style patch inside an existing `workspace_context`. |
| `view_image` | Read and validate a bounded image inside an existing `workspace_context`. |
| `send_file` | Transfer a file from the Worker selected by `workspace_context` to the client. |
| `receive_file` | Receive one ChatGPT file and save it inside the Worker context selected by `workspace_context`. |
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
| `ccm.select_workspace` | Code Mode compatibility surface for workspace entry. Direct model use should call `select_workspace` so the approval app can render. |
| `ccm.register_workspace` | Code Mode compatibility surface for registration/entry. Direct model use should call `register_workspace` so the approval app can render. |
| `ccm.plan_patch` | Create or update one durable Plan using Codex-style patch syntax and an explicit opaque `plan_id`. |
| `ccm.plan_read` | Read, range-read, or search only the Plan identified by `plan_id`; reading does not change planning/implementation workflow. |

### Durable Plans

CCM provides durable Plan storage without implementing a Controller-side "Plan Mode" state machine. When a user explicitly asks to plan/discuss before implementation and persistence is useful, discover `ccm.plan_patch` / `ccm.plan_read` through `tool_search` and invoke them through `exec`.

`ccm.plan_patch` omits `plan_id` only for the first write. That call creates a Plan and returns an opaque UUID; later reads/patches carry that id explicitly, so Plan identity is independent of MCP transport sessions. Managed Plans are stored centrally under ignored Controller state at `.state/plans/<plan_id>.md`; no public list/delete/search-other-Plans capability is exposed and v0.1 does not automatically expire or garbage-collect Plan files.

Plan patches reuse the normal Codex-style patch grammar but target one virtual file only: creation uses `*** Add File: plan.md`, and updates use `*** Update File: plan.md`. The real `.state` path is never accepted as a tool argument. Keep the logical Plan current rather than append-only: rewrite or remove completed, invalidated, obsolete, or superseded items while preserving active constraints and unresolved decisions. Unless the user explicitly instructs execution/implementation, Plan work remains planning; imperative wording, completed inspection, workspace approval, registration approval, or sandbox escalation approval does not itself authorize implementation. `ccm.plan_read` is intentionally lifecycle-neutral so implementation can consult a Plan repeatedly without re-entering planning behavior.

## ToolRegistry and Code Mode

CCM stores capability exposure as three independent surfaces:

- **Direct** — included in MCP `tools/list`.
- **Deferred** — omitted from the initial schema and discoverable through `tool_search`.
- **Code Mode** — callable as a nested capability through `exec`.

Convenience states such as Direct, Deferred, CodeModeOnly, DirectModelOnly, DeferredModelOnly, and Hidden are derived from those surfaces rather than stored as one rigid enum.

The direct MCP surface is intentionally kept small and stable. New ordinary capabilities should default to the **Deferred + Code Mode** surfaces and be invoked through `tool_search` + `exec`. Add a new top-level Direct tool only when the capability is a common operational primitive or is fundamental to environment discovery, explicit approval, process continuation, or nested-tool discovery/dispatch. `create_projectless_context` and `list_workspaces` remain Deferred; `select_workspace` and `register_workspace` are Direct because their user approval must render an MCP App.

Keeping ordinary additions off the Direct surface prevents routine feature work from changing the client's top-level MCP schema. In particular, adding a deferred capability should **not require deleting and recreating the CCM integration in ChatGPT or another MCP client**. Updating CCM server code may still require restarting the Controller and/or Worker processes so the new implementation is loaded; that is separate from recreating the client integration.

Do not promote a capability to Direct merely for convenience. Keep non-interactive workspace discovery/context helpers deferred, and prefer deferred `ccm-extra.*` or other namespaced capabilities for specialized workflows. Approval-gated `select_workspace` / `register_workspace` and the common operational file tools `apply_patch`, `view_image`, `send_file`, and `receive_file` are intentionally Direct.

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

### Bundled specialized capabilities

CCM ships optional Windows workflows ported from WCM. Specialized workflows remain deferred; file handoff is exposed through the direct `ccm-extra.send_file` and `ccm-extra.receive_file` tools:

- `ccm-extra.send_file` is strictly single-file: one call transfers one exact file from a selected CCM environment to the GPT client. If multiple files are needed, invoke `send_file` sequentially once per file and wait for each call to return before starting the next; do not issue concurrent/parallel `send_file` calls. Use it only when a user-facing handoff is actually needed (preview/download/upload to another tool). It returns an MCP `resource_link`; `resources/read` serves the exact file bytes from a bounded Controller-side bridge cache that is persisted under ignored `.state/file-transfers` and survives Controller restarts. By default the bridge has no time-based expiry and is bounded by `CCM_FILE_TRANSFER_CACHE_BYTES`; an optional positive `CCM_FILE_TRANSFER_TTL_MS` can impose a TTL. In ChatGPT, the associated MCP App materializes that resource into a conversation-scoped ChatGPT file with `library:false`, persists both the ChatGPT `fileId` and the CCM recovery resource URI in widget state, and requests a fresh temporary download URL on each click. If the ChatGPT file later expires after the card is reloaded, the widget can re-read the persisted CCM resource and materialize a replacement conversation file without rerunning `send_file`. Recovery remains subject to the Controller bridge entry still existing: configured TTL expiry or bounded-cache eviction makes that original resource unavailable. Do not use `send_file` merely for model-side inspection when the file can be read or viewed locally in CCM; prefer local reading, `view_image`, command-line inspection, or temporary local previews to avoid unnecessary materialization/approval prompts. The transfer does not use BMG.
- `ccm-extra.receive_file` is the inverse Direct-only handoff. ChatGPT supplies exactly one native file parameter (`download_url`, `file_id`, and optional MIME/name), and the selected Worker streams that temporary HTTPS URL directly into its current context root. `destination` is workspace-relative only, overwrite is opt-in, redirects and resolved targets are SSRF-checked, and the completed file is published from a same-directory temporary file with SHA-256 metadata. Multiple files must be received sequentially. ChatGPT Files owns Library discovery; CCM only receives the specific file already selected/authorized by ChatGPT and does not enumerate the user's Library, route bytes through BMG, or use the Controller `FileTransferStore`.
- `ccm-extra.quark_upload` submits one or more files through that local Quark desktop session and can wait for verified completion.
- `ccm-extra.bilibili_download_dash` downloads signed DASH video/audio URLs obtained from an authenticated browser session and remuxes them with `ffmpeg -c copy`.

Discover deferred specialized workflows with `tool_search` (for example, `quark upload` or `bilibili`) and invoke them through `exec`. `send_file` is available directly and is also callable through `exec`; `receive_file` is Direct-only because ChatGPT native file-parameter injection occurs on the top-level tool call. Long uploads/downloads may return a live process session; continue that session with the top-level `write_stdin` tool.

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

Set at least `CCM_WORKER_HUB_CONNECT_HOST`; normally also give the Worker a stable `CCM_ENVIRONMENT_ID`. `CCM_WORKSPACE` is optional legacy/bootstrap configuration and is not a GPT-visible default project. Then install and inspect the Worker task:

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

### ChatGPT rebuild handoff rule

ChatGPT-side CCM/plugin/connector rebuilds are **user-operated**. The assistant must not rename, delete, recreate, reconnect, or otherwise rebuild the ChatGPT CCM registration on the user's behalf unless the user explicitly overrides this rule for that rebuild.

When a Direct-tool schema change means the ChatGPT registration needs to be rebuilt, the assistant should stop at the handoff boundary and provide only the information the user needs to rebuild it:

1. Resolve the current public MCP resource from `CCM_RESOURCE` (normally from ignored `config/ccm.env`) and give that MCP address to the user.
2. Do **not** print or copy the local approval secret or its complete path into chat. For the local approval-secret file (normally ignored `.state/ccm-approval-secret.txt`), first create one temporary text descriptor containing only its directory. In a separate command/tool call, create a second temporary text descriptor containing only its leaf filename. In a third, separate call, discover and invoke `ccm-extra.one_time_link` with only the two descriptor-file paths. Give the resulting one-time key URL to the user. After the URL is returned, remove each descriptor file in subsequent standalone cleanup calls.
3. Do not use BMG to operate ChatGPT settings, rename the existing connector, create a replacement connector/plugin, or complete OAuth/consent for the user.
4. Do not run the legacy `tools/chatgpt-schema-refresh/refresh.ps1` rebuild workflow by default. It may remain as a manual/debugging utility, but normal assistant behavior is the two-item handoff above: **one-time key URL + MCP address**.
5. If the current ChatGPT UI requires an archive upload, do not proactively build or upload a plugin archive as part of rebuild. Only build/provide one when the user explicitly asks for the archive.

The one-time-key helper accepts **two descriptor-file paths**, never the secret text or complete target path. One descriptor contains only the target directory; the other contains only the target leaf filename. Create the directory descriptor, filename descriptor, one-time-link invocation, and cleanup as separate operations. Do not collapse those phases into one shell command, script, pipeline, or wrapper. The Windows worker reads the two descriptors and reconstructs the target path locally. The reveal page is short-lived and is consumed when the user reveals it.

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
| `CCM_WORKSPACE` | current directory | Legacy/internal Worker bootstrap seed. It may seed Worker-local registry state for compatibility, but it is not a GPT-visible default workspace/project or a new-project parent. |
| `CCM_PROJECTLESS_ROOT` | `~/Documents/CCM` | Root used for automatically created projectless workspaces. |
| `CCM_WORKSPACE_REGISTRY_FILE` | `<install>/.state/workspaces.json` for the packaged Worker | Worker-local registered and projectless workspace registry. |
| `CCM_WORKSPACE_CONTEXT_FILE` | `<install>/.state/workspace-contexts.json` for the packaged Controller | Persistent Controller workspace-context registry. |
| `CCM_CONTROLLER_STATE_DIR` | Windows: `%LOCALAPPDATA%\CCM`; XDG: `$XDG_STATE_HOME/ccm`; fallback: `~/.ccm` | Protected Controller security state, including execution policies and trusted package-script rules. Keep this outside workspace-write roots. |
| `CCM_APPROVAL_TTL_MS` | 900000 ms (15 minutes) | Lifetime of pending execution and workspace approvals before they expire. Invalid or non-positive values fall back to the default. |
| `CCM_PERMISSION_PROFILE` | `workspace-write` | `read-only`, `workspace-write`, or `full-access`. |
| `CCM_MAX_MCP_TOOL_RESULT_BYTES` | 2 MiB | Serialized MCP tool-result limit for ordinary results. |
| `CCM_MAX_MCP_FILE_RESULT_BYTES` | 24 MiB | Serialized MCP result limit when returning an embedded file resource. |
| `CCM_MAX_VIEW_IMAGE_BYTES` | 1 MiB | Maximum raw image size returned by `view_image`. |
| `CCM_MAX_SEND_FILE_BYTES` | 12 MiB | Maximum raw file size returned by `ccm-extra.send_file`. |
| `CCM_MAX_RECEIVE_FILE_BYTES` | 512 MiB | Maximum raw file size accepted by `ccm-extra.receive_file`; the default matches ChatGPT's current per-file hard upload limit. |
| `CCM_FILE_TRANSFER_TTL_MS` | 0 (disabled) | Optional positive TTL for persisted `send_file` bridge resources. |
| `CCM_FILE_TRANSFER_CACHE_BYTES` | 64 MiB | Maximum total raw bytes retained in the persisted file-transfer bridge cache; oldest entries are evicted first. |
| `CCM_WORKER_RECONNECT_MS` | 1000 ms | Worker reconnect delay. |

## Sandbox and platform support

Windows is the current fully supported restricted-execution platform.

`read-only` and `workspace-write` command execution use the CCM Windows native sandbox helper. The public environment-discovery surface intentionally does not expose internal bootstrap directories, raw permission profiles, or filesystem permission topology, but `list_environments` does expose two independent coarse fields derived from the current effective profile: `sandbox_read_scope` and `sandbox_write_scope`. In the current Windows restricted sandbox, `read-only` reports `host` / `none`, `workspace-write` reports `host` / `context_root`, and `full-access` reports `host` / `host`. `context_root` means the active registered-workspace or projectless root. A `workspace_context` selects the Worker, cwd/session ownership, and that restricted-write root; it does not narrow command reads below `sandbox_read_scope`. Therefore, when `sandbox_read_scope=host`, an absolute-path read outside the active context root should be attempted normally using the existing context (or a projectless context when no project is selected), without selecting/registering the target path or requesting escalation merely because it is outside the root. Individual direct file tools may impose narrower path contracts than `exec_command`. PTY sessions use a Rust ConPTY backend aligned with the useful parts of Codex's current Windows PTY implementation. `full-access` runs with the Worker's normal host permissions.

Restricted command execution on Linux/macOS is not implemented yet and **fails closed** rather than silently running unsandboxed. A Linux/macOS Worker therefore currently needs `CCM_PERMISSION_PROFILE=full-access` for shell execution.

`apply_patch` enforces its own workspace-write boundary on the Worker, including real-path checks that reject symlink/junction escapes. Ordinary `exec_command` remains inside the selected environment's normal sandbox except for narrowly recognized trusted classes. Remote Git already has a syntax-restricted trusted path. Controller-managed trusted package-script rules provide a second explicit trusted path for selected workspace scripts such as `npm test`; all other commands cross the sandbox only through the approval flow below.

### Trusted package scripts

For repetitive development commands that cannot run under the Windows restricted token, CCM can trust one simple package-manager script in one exact workspace. A trusted rule is bound to the environment, workspace id/root, exact command, workdir, shell/TTY settings, package manager/script name, and the SHA-256 of the current `package.json` script text. A matching rule lets ordinary `exec_command` run that invocation with full host permissions without rendering an approval card. If the script text changes, the rule immediately stops matching and CCM falls back to the normal sandbox/escalation path.

Trusted package-script state is stored under the protected Controller state directory rather than inside the workspace. The target repository therefore cannot grant itself trust through ordinary `workspace-write` access.

Manage rules from the Controller host with the explicit local CLI:

```powershell
node scripts/manage-trusted-package-script.mjs trust `
  --environment-id DESKTOP-KFL6V1F `
  --workspace-id codex-compatible-mcp `
  --workspace-root C:\path\to\codex-compatible-mcp `
  --command "npm test"

node scripts/manage-trusted-package-script.mjs list

node scripts/manage-trusted-package-script.mjs revoke `
  --environment-id DESKTOP-KFL6V1F `
  --workspace-id codex-compatible-mcp `
  --workspace-root C:\path\to\codex-compatible-mcp `
  --command "npm test"
```

Only structurally simple package-script commands qualify. Shell chaining, pipes/redirection, and extra script arguments do not enter this trusted class. Adding or refreshing trust is an explicit Controller-host management action; the model-visible `exec_command` tool cannot write trust rules.

### Sandbox escalation and workspace allow rules

Restricted Workers support an explicit one-shot escalation flow through the direct `request_escalated_exec` tool. The model supplies the exact command, `workspace_context`, optional working directory/shell/TTY settings, output/yield settings, and user-facing justification once. CCM freezes those fields into a `PendingAction`, assigns an `approval_id` and `operation_id`, and returns an MCP App approval card. **The command is not executed by `request_escalated_exec`.**

The approval card receives a high-entropy approval capability only through tool-result `_meta`; that secret is not placed in `content` or `structuredContent`. For execution approvals the card displays the frozen workspace/environment/command/justification and offers **Approve once**, **Always allow in workspace**, or **Deny**. For workspace entry/registration it displays the frozen environment/workspace/root/action and offers only **Approve** or **Deny**. The app-only `resolve_pending_action` resolver accepts only `approval_id`, the card capability, and the user's decision; it does not accept a replacement command, workspace target, workdir, shell, or TTY value.

On Approve, CCM resumes the already-frozen action directly. There is no second model decision and no model-generated retry of the command. The grant:

- is valid for five minutes,
- is atomically dispatchable only while the frozen approval is in an allowed state,
- is bound to the environment, workspace context/root, command, working directory, shell, TTY mode, and execution output/yield settings,
- runs that one command with `full-access`,
- cannot be reused after execution.

**Always allow in workspace** still executes the current frozen action through the same approval state machine, but after successful Worker dispatch CCM stores a constrained `allow` rule under the protected Controller state directory. Future escalations skip the approval prompt only when the environment, workspace identity/root, exact command, working directory, shell, and TTY mode all still match.

Simple package-manager scripts such as `npm test`, `npm run test`, `pnpm test`, and `yarn lint` receive an additional content binding. Before the persistent rule is created, CCM reads the current `package.json` script through the restricted Worker and stores a SHA-256 of that script text. Future automatic approval re-reads the script; changing the script invalidates the rule and restores the approval prompt. Shell chaining, redirection, extra script arguments, or other compound command forms are not treated as package-script rules.

The persistent policy affects approval only. It does not weaken `workspace-write`, change ordinary `exec_command` behavior, or turn package-manager commands into a general unsandboxed trust class. A matching rule authorizes only the exact escalation that the user previously chose to persist.

If CCM can prove a failure occurred before Worker dispatch, the same frozen action may be presented for retry. If a timeout/disconnect makes it uncertain whether the Worker started the command, the approval enters `execution_unknown` and CCM will not retry automatically. Denied, consumed, unknown-outcome, and expired requests cannot start another execution.

Workspace entry/registration uses the same card capability and one-shot state model, but it never grants `full-access` and never creates an execution allow rule. On approval CCM re-reads the registered workspace or re-inspects the registration path, verifies that the frozen environment/workspace/root still match, then creates the registered `workspace_context`. If the target has drifted, the frozen action fails closed and is consumed so a new approval is required. Approval of a workspace action is only permission to select/register/create-and-enter that workspace; it is not authorization to begin implementation.

The old `exec_command(sandbox_permissions=require_escalated) -> respond_to_escalation -> retry exec_command(approval_id)` path is retained only as migration compatibility for already-issued legacy execution approvals. Likewise, Code Mode `select_workspace` / `register_workspace` calls retain the legacy `approval_id -> respond_to_escalation -> retry` sequence because a nested tool result cannot render an MCP App. New direct execution and workspace requests use the approval app and must not be retried by the model after the card is shown.

This approval mechanism controls CCM's sandbox boundary; it does **not** grant Windows Administrator/UAC privileges. The approval app is the interaction mechanism, while the server-side frozen action, approval capability, state machine, and workspace revalidation remain the security boundary. If ChatGPT supplies its anonymous `openai/session` metadata on both calls, CCM also binds the request and app resolver to that host session as defense in depth.

## Output and transport protection

CCM treats oversized output as a reliability and context-safety problem.

The OAuth/public sidecar also isolates MCP request identity. Legacy downstream clients that initialize separate MCP sessions receive separate upstream sessions, and downstream POST calls that omit `Mcp-Session-Id` use request-scoped transient upstream sessions instead of sharing one persistent request-id namespace. This prevents concurrent clients that reuse the same JSON-RPC id (for example `id=0`) from overwriting each other's upstream response routing.

Command capture is bounded, model-facing command output has a token budget, live process reads are incremental, Worker protocol messages have a hard serialized-size ceiling, final MCP tool results have an absolute byte limit, and `view_image` checks file size before reading/encoding it.

If a hard transport limit would be exceeded, CCM returns or triggers a compact failure instead of attempting to send an oversized response.

## MCP result compatibility

CCM returns standard MCP tool results directly. It does not add a custom result envelope such as `resultType`.

Text tools return normal `content: [{ type: "text", ... }]` results. `view_image`
returns normal MCP image content and keeps its file metadata in result `_meta`,
so multimodal clients can preserve the image block instead of reducing the
result to structured-only output. Other tools may use `structuredContent` as
the standard optional structured companion to `content`.

`view_image` is a common Direct operational tool and is also available through
Code Mode for nested/batched dispatch. `exec` passes nested MCP `image` content
through directly while compacting the duplicate structured result, so the
model can receive the image without attaching an MCP Apps output template or
creating a widget card for every image.

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
