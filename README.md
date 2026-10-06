# CCM — Codex-Compatible MCP

CCM is a Codex-inspired execution harness for MCP clients. It focuses on a small, stable coding/execution surface, persistent process sessions, Remote Workers, native sandboxing, bounded tool output, patching, and image reads.

CCM does **not** attempt to reproduce Codex's model loop or own the host application's conversation history. The MCP client remains the orchestrator; CCM owns the execution world.

Before modifying this repository, read and follow [AGENTS.md](AGENTS.md) for repository-specific agent instructions.

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

Worker feature churn does not require monotonically bumping the transport protocol version. A Worker that proves incompatible with the running Controller at RPC time is quarantined in memory rather than disconnected: all environments owned by that Worker remain visible as `state=abnormal`, later RPC dispatch to them fails fast, and healthy Workers continue normally. A fresh connection using the same `worker_id` may replace an already-quarantined connection without a takeover token and clears the quarantine. When a normal connection still occupies that identity, the Controller first gives it a short `ping` probe: a responsive Worker remains authoritative and the duplicate is rejected, while an unresponsive stale connection is replaced by the fresh Worker. Ordinary command/tool failures do not quarantine a Worker.

The contract-error codes that trigger quarantine are configured in the tracked, non-secret `config/worker-quarantine-errors.json` file. CCM hot-reloads valid edits to this file with no Controller restart. Invalid live edits are logged and ignored while the last known-good policy remains active; invalid configuration at Controller startup is fatal.

Registered workspaces are owned by each Worker, not by the Controller. Deferred `select_workspace` / `register_workspace` calls always validate the exact workspace identity or registration target. In a `full-access` environment, CCM performs that validated workspace action directly and returns an opaque `workspace_context` without user approval. Restricted environments freeze the exact workspace action and return an opaque `approval_id`; the top-level Direct `request_approval` tool renders that frozen action in the CCM approval app, and approval resumes the same validated action without a model-generated retry. `register_workspace` combines registration and entry; with `create_if_missing=true`, the action may also create the exact missing project directory before registration. Normal development tools carry only the resulting context. Workspace contexts are persisted by the Controller and remain valid across Controller or Worker restarts. Worker-local projectless mappings are persisted as well, so a surviving projectless directory can be resumed after a Worker restart.

An environment does not expose a default workspace or default working directory to the MCP client. Worker bootstrap cwd is a runtime seed only; it is not a project-location hint, a default project, or the parent directory for newly created projects. CCM deliberately has no "Projects Root" policy: project placement comes from the user or the upper-layer orchestrator.

When the task is genuinely projectless and the user has not selected, requested, or otherwise indicated a real registered project, create an explicit projectless context with the deferred `ccm.create_projectless_context` capability through `tool_search` + `exec`. Pass `environment_id` to create it on a specific Worker, or omit `environment_id` to use the primary environment. Projectless workspaces are created under `CCM_PROJECTLESS_ROOT` (default: the user's `Documents\\CCM` directory) and provide a temporary execution context without selecting or registering a real project. If `select_workspace` or `register_workspace` has already returned `approval_required=true` for the user's current intended real project, the model calls `request_approval` and waits for that frozen workspace action rather than using projectless context to bypass it. If the user explicitly corrects or changes the target to another real project, the older pending approval does not block a new `select_workspace` / `register_workspace` call for the new target and does not need to be denied or resolved first.

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
| `exec_command` | Run a native shell command inside an existing `workspace_context`. |
| `request_approval` | Render the CCM approval app for one already-frozen pending action. It accepts only the returned `approval_id`. |
| `resolve_pending_action` | App-only resolver used by the CCM approval app to approve/deny and resume a frozen execution or workspace action. It is hidden from normal model use through MCP Apps visibility metadata. |
| `write_stdin` | Write to or poll a live process session returned by `exec_command`; requires both `session_id` and the owning `workspace_context`. |
| `apply_patch` | Apply a Codex-style patch inside an existing `workspace_context`. |
| `view_image` | Read and validate a bounded image inside an existing `workspace_context`. |
| `tool_search` | Discover deferred ToolRegistry capabilities without expanding the top-level MCP schema. |
| `exec` | Dispatch one or more nested registered capabilities, sequentially or safely in parallel. |
| `wait` | Resume a nested `exec` cell that yielded before completion. |

Normal repository inspection, search, Git, builds, tests, and diagnostics should usually go through `exec_command`.

### Core deferred capabilities

These are core CCM operations but intentionally stay off the top-level MCP schema. Discover them with `tool_search` and invoke them through `exec`.

| Capability | Purpose |
| --- | --- |
| `ccm.list_projects` | Show connected execution environments, their registered projects, capabilities, and coarse effective filesystem read/write scope. Omit `environment_id` to inspect all connected Workers; use `all=true` only to include projectless contexts separately. |
| `ccm.create_projectless_context` | Create a temporary projectless context on a chosen Worker, or on the primary Worker when no environment is specified. |
| `ccm.select_workspace` | Validate and enter one registered workspace. Full-access returns a `workspace_context` directly; restricted profiles may return an opaque `approval_id` for `request_approval`. |
| `ccm.register_workspace` | Validate and register/enter one exact project path. Full-access completes directly; restricted profiles may return an opaque `approval_id` for `request_approval`. |
| `ccm.plan_patch` | Create or update one durable Plan using Codex-style patch syntax and an explicit opaque `plan_id`. |
| `ccm.plan_read` | Read, range-read, or search only the Plan identified by `plan_id`; reading does not change planning/implementation workflow. |

### Durable Plans

CCM provides durable Plan storage without implementing a Controller-side "Plan Mode" state machine. When a user explicitly asks to plan/discuss before implementation and persistence is useful, discover `ccm.plan_patch` / `ccm.plan_read` through `tool_search` and invoke them through `exec`.

`ccm.plan_patch` omits `plan_id` only for the first write. That call creates a Plan and returns an opaque UUID; later reads/patches carry that id explicitly, so Plan identity is independent of MCP transport sessions. Managed Plans are stored centrally under ignored Controller state at `.state/plans/<plan_id>.md`; no public list/delete/search-other-Plans capability is exposed and v0.1 does not automatically expire or garbage-collect Plan files.

Plan patches reuse the normal Codex-style patch grammar but target one virtual file only: creation uses `*** Add File: plan.md`, and updates use `*** Update File: plan.md`. The real `.state` path is never accepted as a tool argument. Planning follows an explore-first, ask-second discipline: discoverable repository/environment/documentation/tool facts should be established through targeted non-mutating inspection rather than questions. If a high-impact ambiguity instead depends on a non-discoverable user preference, product/scope/compatibility choice, or meaningful tradeoff, ask rather than guess. For those decisions, explicitly present 2-4 mutually exclusive choices in the user-visible question, preferably with concise labels, and identify a recommended/default choice there when useful; the user may still give another answer outside the listed choices. Generating options only in model reasoning without showing them to the user does not satisfy this planning contract.

While Plan work remains planning, normal read/search/status/history/diff inspection, diagnostics, dry-run/non-mutating validation, and tests/builds whose only side effects are ignored/cache/temp outputs are allowed. Tracked implementation edits, implementation patches, migrations, rewriting code generation or formatting, dependency/configuration changes, deploy/release actions, commits, pushes, and similar intentional mutations require an explicit user instruction to execute/implement. Imperative task wording, completed inspection, workspace approval, registration approval, or sandbox escalation approval does not itself authorize implementation. CCM intentionally does not add a Controller-side Plan-Mode state machine or clone Codex Host-specific `request_user_input`, `<proposed_plan>`, or PlanDelta UI/protocol behavior; a clear user instruction to execute/implement is the transition into implementation.

Keep the logical Plan current rather than append-only: rewrite or remove completed, invalidated, obsolete, or superseded items while preserving active constraints and unresolved decisions. A decision-complete Plan should capture the goal/success criteria and scope, implementation approach and affected components/files, relevant interface/schema/data-flow changes, edge cases/failure modes, compatibility/migration/cleanup decisions, tests/validation, and acceptance criteria, with genuinely blocked assumptions or unresolved items labeled explicitly. The handoff should be concise but detailed enough that another executor does not need to invent new product or design decisions. `ccm.plan_read` is intentionally lifecycle-neutral so implementation can consult a Plan repeatedly without re-entering planning behavior.

## ToolRegistry and Code Mode

CCM stores capability exposure as three independent surfaces:

- **Direct** — included in MCP `tools/list`.
- **Deferred** — omitted from the initial schema and discoverable through `tool_search`.
- **Code Mode** — callable as a nested capability through `exec`.

Convenience states such as Direct, Deferred, CodeModeOnly, DirectModelOnly, DeferredModelOnly, and Hidden are derived from those surfaces rather than stored as one rigid enum.

The direct MCP surface is intentionally kept small and stable. The normal Direct model-visible primitives are the Codex-like execution/editing tools (`exec_command`, `write_stdin`, `apply_patch`, and `view_image`) plus the bootstrap/Host bridges that cannot usefully be deferred (`tool_search`, `exec`, `wait`, and the approval bridge). `exec` remains Direct because it is the nested dispatcher and also carries the optional top-level native ChatGPT file binding used by deferred file consumers. Ordinary CCM-specific discovery, lifecycle, and specialized workflows default to **Deferred + Code Mode** and are invoked through `tool_search` + `exec`; this includes `list_projects`, `create_projectless_context`, `select_workspace`, `register_workspace`, `chatgpt_share_export`, and `quark_upload`. `ccm-extra.send_file` is also Deferred + Code Mode, but intentionally uses exact-only discovery so broad file/attachment/download searches do not surface it. Approval rendering remains centralized in the Direct-only `request_approval` bridge, while `resolve_pending_action` is registered only for the approval App and remains hidden from normal model use.

Keeping ordinary additions off the Direct surface prevents routine feature work from changing the client's top-level MCP schema. In particular, adding a deferred capability should **not require deleting and recreating the CCM integration in ChatGPT or another MCP client**. Updating CCM server code may still require restarting the Controller and/or Worker processes so the new implementation is loaded; that is separate from recreating the client integration.

Do not promote a capability to Direct merely for convenience or frequency. Keep environment/project discovery, workspace lifecycle helpers, and ordinary specialized workflows Deferred + Code Mode. `apply_patch` and `view_image` remain common Direct operational tools. `ccm-extra.receive_file` remains Deferred + Code Mode because native ChatGPT input-file binding is centralized on the optional top-level `exec.file` parameter; this avoids reintroducing the observed Direct native-file wrapper incompatibility.

### Compatibility contracts

CCM treats confirmed client/Host/model/Worker compatibility findings as repository behavior, not conversation-only notes. When a compatibility issue is confirmed, record the affected surface and required routing/workaround here; remove the wording when the constraint no longer applies.

- **Model routing / Direct surface:** observed ChatGPT model behavior can follow a strong Codex-style tool-use prior and fail to route reliably to extra CCM-specific top-level Direct workflows. Keep non-core CCM workflows Deferred + Code Mode and make them explicit through `tool_search` + `exec` instead of growing the Direct surface for convenience or frequency.
- **Direct definition caching:** ChatGPT may cache a top-level Direct tool's full model-visible definition, including description text, across conversations. Deferred capability definitions can be observed live through `tool_search`; if a restarted CCM serves new definitions but a fresh ChatGPT conversation still exposes stale Direct definitions, the user may need to refresh/rebuild the ChatGPT-side registration.
- **Native input-file binding:** `ccm-extra.receive_file` stays deferred and receives its native file object through Direct `exec.file`. Ordinary conversation attachments bind directly to `exec.file`; Library files are first materialized as `raw_file` with ChatGPT Files, then the materialized file is bound to `exec.file`.
- **Approval UI:** `request_approval` stays top-level Direct because it carries the Host/App output template and widget metadata. `resolve_pending_action` is App-only and resumes the frozen action; neither belongs in ordinary deferred nested dispatch. After a terminal approval decision, the App updates model context and prefers the standard MCP Apps `ui/message` bridge when the Host advertises text-message support. The ChatGPT `window.openai.sendFollowUpMessage` compatibility alias is used only when standard messaging is unavailable or explicitly fails. Continuation failure is reported in the card and never changes or retries the already-resolved action.
- **Outbound file handoff:** `ccm-extra.send_file` stays single-file and non-parallel, but uses exact-only discovery. Search for exactly `send_file` or `ccm-extra.send_file` only when the user explicitly asks for a known Worker file as a native ChatGPT attachment, and invoke it through `exec` only after all analysis, verification, editing, testing, and other tool work is complete. Its MCP `resource_link` must pass through nested dispatch unchanged so the Host can present the native attachment. The Host may require user interaction to materialize that attachment; this is Host-owned confirmation, not CCM approval, and CCM does not bypass it. Multiple files are transferred sequentially.
- **Long process polling / Direct `write_stdin`:** ChatGPT long-turn testing found that repeated top-level Direct empty `write_stdin` polls can leave the Host tool-event/turn flow stalled after extended polling, while the same 40-minute workload completed normally when every empty poll used nested `ccm.write_stdin` through `exec`. Keep `write_stdin` on the Direct + Code Mode surfaces for compatibility and real interactive stdin writes, but route empty polling through `exec -> ccm.write_stdin` from the first poll. CCM now hard-rejects top-level Direct empty polls before calling the process manager or Worker, so an accidental Direct poll cannot continue the session; the same `session_id` must be retried through nested `ccm.write_stdin`. Reuse the original `(workspace_context, session_id)`; on a Host/tool-call failure with no CCM structured result, retry that same nested route at most twice and do not fall back to Direct empty polling or create a replacement session.

CCM deliberately does not embed a second JavaScript interpreter for Code Mode. The host application remains responsible for loops, branching, and data processing. CCM's `exec/wait` pair is a bounded structured dispatcher over ToolRegistry capabilities. `state=completed` is terminal. If nested dispatch has finished but an `exec_command` leaves a live process session, CCM returns `state=awaiting_io` with `next_operation=write_stdin`; empty polling must continue through `exec -> ccm.write_stdin`. Top-level `write_stdin` remains available for real non-empty interactive stdin writes and client compatibility, but empty Direct calls are rejected without touching the session.

### ChatGPT Share conversation export

`ccm-extra.chatgpt_share_export` is Deferred + Code Mode and exports public ChatGPT Share conversations without BMG or browser automation. Discover it through `tool_search` and invoke it through `exec`.

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

CCM ships optional specialized workflows as Deferred + Code Mode capabilities invoked through `exec`. Most are discovered through ordinary `tool_search`; exact-only capabilities are returned only for an exact tool-name query:

- `ccm-extra.send_file` is a strictly single-file Deferred + Code Mode terminal handoff with `discoverability=exact`: broad `file`, `attachment`, `download`, tag, description, partial-name, and empty searches do not return it; search exactly `send_file` or `ccm-extra.send_file`. Use it only when the user explicitly asks for a known local Worker file as a native ChatGPT attachment, and only after every required analysis, verification, edit, test, and other tool action has finished. Do not use it for model-side inspection, verification, stage previews, or intermediate cross-tool transfer. One nested call transfers one exact file from a selected CCM environment as a standard MCP `resource_link`, and `exec` passes that resource link through unchanged. If multiple files are needed, invoke `send_file` sequentially once per file and wait for each call to return before starting the next; do not issue concurrent/parallel `send_file` calls. CCM stores the exact bytes in the bounded Controller-side `ccm-file:///...` bridge under ignored `.state/file-transfers`; the returned resource link points to that bridge, which persists across Controller restarts, has no time-based expiry by default, and remains subject to configured TTL or cache eviction. The ChatGPT Host may require user interaction to materialize the native attachment; that confirmation is Host-owned and independent from CCM's approval state machine. After a successful call, the final assistant response should include the host-generated native ChatGPT file attachment object, not its file ID as text. For host download reliability, CCM documents **1 KiB (1024 bytes)** as the operational minimum: smaller files are still transferred byte-for-byte, but some ChatGPT clients may remain stuck connecting when downloading them. CCM never pads, rewrites, or otherwise changes a file to reach 1 KiB; callers should warn the user instead. `send_file` has no CCM file-card App and does not upload the file to ChatGPT Library. The transfer does not use BMG.
- `ccm-extra.receive_file` is the inverse Deferred + Code Mode handoff. For an ordinary conversation attachment, bind it through the **top-level `exec.file` parameter** and make one nested `receive_file` call. For a Library file, first materialize the exact Library object as `raw_file` with ChatGPT Files, then bind that materialized file through `exec.file` and make one nested `receive_file` call. CCM injects the resolved native object into the nested call. The selected Worker streams the temporary HTTPS URL directly into its current context root. `destination` is workspace-relative only, overwrite is opt-in, and multiple files must be received sequentially.
- `ccm-extra.quark_upload` is Deferred + Code Mode, submits one or more files through that local Quark desktop session, and can wait for verified completion.
- `ccm-extra.bilibili_download_dash` downloads signed DASH video/audio URLs obtained from an authenticated browser session and remuxes them with `ffmpeg -c copy`.

Discover ordinary specialized workflows with `tool_search` (for example, `receive_file`, `chatgpt_share_export`, `quark_upload`, or `bilibili_download_dash`) and invoke them through `exec`. `send_file` is the exception: discover it only by its exact name and use it only as the final native-attachment handoff requested by the user. For `receive_file`, bind exactly one file through `exec.file` and make exactly one nested call; materialize Library files as `raw_file` first. Long uploads/downloads may return a live process session; poll that session through `exec -> ccm.write_stdin` with the returned `workspace_context` and `session_id`.

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

For an assistant-operated restart of the Controller service group, prefer the existing supervisor recovery path rather than reinstalling or modifying the scheduled task: read the current gateway PID from `.state/ccm-public.pid`, terminate that gateway process tree from the normal CCM sandbox when permitted, and let `scripts/ccm-supervisor.ps1` rebuild and relaunch the Controller, local Worker, and OAuth sidecar. A restart does **not** require user approval merely because it is a restart; request `require_escalated` only when the concrete restart operation is actually blocked by the current sandbox. After the supervisor relaunches the group, verify Controller health, local/remote Worker state, and sidecar health before reporting success. Do not change Task Scheduler configuration just to perform an ordinary restart.

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

Set at least `CCM_WORKER_HUB_CONNECT_HOST`; normally also give the Worker a stable `CCM_ENVIRONMENT_ID`. `CCM_WORKSPACE` is a Worker bootstrap workspace seed and is not a GPT-visible default project. Then install and inspect the Worker task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-ccm-worker-autostart.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\ccm-worker-status.ps1
```

Remove it with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-ccm-worker-autostart.ps1
```

The Remote Worker supervisor reads `config/worker.env` itself, builds the native helpers on startup, and launches `src/worker/agent.mjs`. The Worker agent owns connection retry/reconnect behavior, so temporary Controller/network loss does not cause a process restart. `config/worker.env`, PID files, and supervisor logs are local runtime state and are not committed.

`list_projects` performs per-environment discovery. When called without `environment_id`, a stale or failing Worker cannot make healthy Worker results fail: the affected environment is returned as abnormal with its discovery error while healthy environments still return their projects. When `environment_id` explicitly targets a failing environment, the call remains strict and returns an error.

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

Funnel is CCM's public **ingress/control path** only. It lets a remote MCP client continue reaching the OAuth sidecar and Controller even when a Worker's ordinary outbound proxy is unhealthy, but it is not a SOCKS proxy, HTTP CONNECT proxy, NAT gateway, or general egress service. A Worker child process such as `git`, `curl`, `npm`, or `pip` creates its own outbound connection and cannot route that new connection "back through" Funnel. Child-process egress is controlled independently by the proxy/direct mode described below.

### ChatGPT rebuild handoff rule

ChatGPT-side CCM/plugin/connector rebuilds are **user-operated**. The assistant must not rename, delete, recreate, reconnect, or otherwise rebuild the ChatGPT CCM registration on the user's behalf unless the user explicitly overrides this rule for that rebuild.

Changes to a Direct tool's model-visible definition include not only parameter/input/output schema changes but also its `description` text. ChatGPT may cache that full top-level Direct tool definition across conversations. After CCM has restarted, first check a fresh ChatGPT conversation. If that fresh conversation still exposes the old Direct tool description/schema while live CCM `tool_search` already exposes the new deferred definitions, treat the ChatGPT-side registration as stale and refresh/rebuild it. Do not assume that opening a new conversation alone will refresh a cached Direct tool definition.

When a Direct-tool definition change means the ChatGPT registration needs to be rebuilt, **restart CCM first, then rebuild/refresh the ChatGPT-side registration**. Rebuilding ChatGPT before the Controller/Worker has restarted can cache the old running tool definition or implementation even when the repository already contains newer code. The required order is:

1. Restart the CCM Controller/Worker service group so the current checkout is the code actually serving MCP requests. Confirm the Controller is healthy/listening again before proceeding.
2. Only after that restart, resolve the current public MCP resource from `CCM_RESOURCE` (normally from ignored `config/ccm.env`) and give that MCP address to the user.
3. If the host cache needs to be refreshed or the tools need to be rebuilt, give the user the following absolute-path PowerShell command so they can print the current CCM key and URL in their own terminal. Do not copy the printed key into chat:

   ```powershell
   $ccmKey = (Get-Content -LiteralPath 'C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\.state\ccm-approval-secret.txt' -Raw).Trim()
   $ccmUrl = ((Get-Content -LiteralPath 'C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\config\ccm.env' | Where-Object { $_ -match '^CCM_RESOURCE=' } | Select-Object -First 1) -replace '^CCM_RESOURCE=', '').Trim().Trim('"')
   Write-Output ("CCM key: " + $ccmKey)
   Write-Output ("CCM URL: " + $ccmUrl)
   ```
4. Do not use BMG to operate ChatGPT settings, rename the existing connector, create a replacement connector/plugin, or complete OAuth/consent for the user.
5. Do not run `tools/chatgpt-schema-refresh/refresh.ps1` by default. It is a manual/debugging utility; normal assistant behavior is to provide the current MCP address and leave local approval-secret entry to the user.
6. If the current ChatGPT UI requires an archive upload, do not proactively build or upload a plugin archive as part of rebuild. Only build/provide one when the user explicitly asks for the archive.

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
| `CCM_WORKSPACE` | current directory | Worker bootstrap workspace seed. It may seed Worker-local registry state, but it is not a GPT-visible default workspace/project or a new-project parent. |
| `CCM_PROJECTLESS_ROOT` | `~/Documents/CCM` | Root used for automatically created projectless workspaces. |
| `CCM_WORKSPACE_REGISTRY_FILE` | `<install>/.state/workspaces.json` for the packaged Worker | Worker-local registered and projectless workspace registry. |
| `CCM_WORKSPACE_CONTEXT_FILE` | `<install>/.state/workspace-contexts.json` for the packaged Controller | Persistent Controller workspace-context registry. |
| `CCM_CONTROLLER_STATE_DIR` | Windows: `%LOCALAPPDATA%\CCM`; XDG: `$XDG_STATE_HOME/ccm`; fallback: `~/.ccm` | Protected Controller security state, including execution policies and trusted package-script rules. Keep this outside workspace-write roots. |
| `CCM_APPROVAL_TTL_MS` | 259200000 ms (3 days) | Lifetime of pending execution and workspace approvals before they expire. Invalid or non-positive values fall back to the default. |
| `CCM_PROCESS_RESULT_TTL_MS` | 600000 ms (10 minutes) | Worker retention window for the unread final result of a yielded process after it exits. Expired completed records are removed automatically and do not count toward the 64 live-process limit. Invalid or non-positive values fall back to the default. This does not terminate live processes. |
| `CCM_PERMISSION_PROFILE` | `workspace-write` | `read-only`, `workspace-write`, or `full-access`. `full-access` uses normal Worker host permissions and skips CCM user-approval prompts for workspace lifecycle and execution actions. |
| `CCM_PROXY` | unset | Optional explicit HTTP(S) proxy URL used in child-process `proxy` mode before standard proxy environment variables or the enabled Windows user proxy. |
| `CCM_MAX_MCP_TOOL_RESULT_BYTES` | 2 MiB | Serialized MCP tool-result limit for ordinary results. |
| `CCM_MAX_MCP_FILE_RESULT_BYTES` | 24 MiB | Serialized MCP result limit when returning an embedded file resource. |
| `CCM_MAX_VIEW_IMAGE_BYTES` | 1 MiB | Maximum raw image size returned by `view_image`. |
| `CCM_MAX_SEND_FILE_BYTES` | 12 MiB | Maximum raw file size returned by `ccm-extra.send_file`. |
| `CCM_MAX_RECEIVE_FILE_BYTES` | 512 MiB | Maximum raw file size accepted by `ccm-extra.receive_file`; the default matches ChatGPT's current per-file hard upload limit. |
| `CCM_FILE_TRANSFER_TTL_MS` | 0 (disabled) | Optional positive TTL for persisted `send_file` bridge resources. |
| `CCM_FILE_TRANSFER_CACHE_BYTES` | 64 MiB | Maximum total raw bytes retained in the persisted file-transfer bridge cache; oldest entries are evicted first. |
| `CCM_WORKER_RECONNECT_MS` | 1000 ms | Worker reconnect delay. |

### Worker child-process proxy/direct mode

Worker-launched commands have a local hot-switchable network mode. The mode is stored in ignored Worker state at `<install>/.state/child-proxy.json`, persists across Worker restarts, and is re-read for every newly spawned process. Existing shell or PTY sessions keep the environment they were started with.

- `proxy` is the default when the state file does not exist. CCM discovers the child proxy in this order: `CCM_PROXY`, standard uppercase/lowercase HTTP(S)/ALL proxy environment variables, then the enabled Windows user proxy. The discovered URL is injected into the common uppercase and lowercase proxy variables for the new child process.
- `direct` explicitly removes `CCM_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `http_proxy`, `https_proxy`, and `all_proxy` from the new child environment. `NO_PROXY` / `no_proxy` may remain because they do not create a proxy route by themselves.

Manage the mode on a Worker without restarting it:

```powershell
node scripts/manage-child-proxy.mjs status
node scripts/manage-child-proxy.mjs proxy
node scripts/manage-child-proxy.mjs direct
```

`status` reports the current mode and, in `proxy` mode, the proxy URL that would currently be discovered. The state writer uses a same-directory temporary file plus rename, so normal mode changes are atomic. If the state file is manually corrupted, a running Worker keeps the last known-good mode and logs the invalid update until valid state is restored.

This switch applies only to commands spawned by the Worker, including normal pipe, PTY, sandboxed, trusted, and full-access execution paths. It does not change the WorkerHub connection, Controller/OAuth sidecar networking, Tailscale Funnel ingress, or `receive_file`'s own HTTP(S) transfer proxy selection.

## Sandbox and platform support

Windows is the current fully supported restricted-execution platform.

`read-only` and `workspace-write` command execution use the CCM Windows native sandbox helper. The public environment/project-discovery surface intentionally does not expose internal bootstrap directories, raw permission profiles, or filesystem permission topology, but `list_projects` exposes two independent coarse fields for each connected environment derived from the current effective profile: `sandbox_read_scope` and `sandbox_write_scope`. In the current Windows restricted sandbox, `read-only` reports `host` / `none`, `workspace-write` reports `host` / `context_root`, and `full-access` reports `host` / `host`. `context_root` means the active registered-workspace or projectless root. A `workspace_context` selects the Worker, cwd/session ownership, and that context root. Filesystem read scope is determined independently by `sandbox_read_scope`; ordinary write scope is determined by `sandbox_write_scope`. A readable path does not need to become the selected workspace merely because it is outside the current context root. Individual direct file tools may impose narrower path contracts than `exec_command`. PTY sessions use a Rust ConPTY backend aligned with the useful parts of Codex's current Windows PTY implementation. `full-access` runs with the Worker's normal host permissions and does not create CCM user-approval requests for workspace selection/registration or execution escalation. Workspace identity, context routing, cwd/session ownership, and individual tool path contracts remain enforced.

Restricted command execution on Linux/macOS is not implemented yet and **fails closed** rather than silently running unsandboxed. A Linux/macOS Worker therefore currently needs `CCM_PERMISSION_PROFILE=full-access` for shell execution.

`apply_patch` enforces its own workspace-write boundary on the Worker, including real-path checks that reject symlink/junction escapes. Ordinary `exec_command` remains inside the selected environment's normal sandbox except for explicitly trusted full-access classes and saved prefix policies. On Windows `workspace-write`, the built-in trusted classes are narrowly parsed remote Git commands and direct `node --test` invocations; Controller-managed trusted package-script rules provide a separate hash-bound path for selected workspace scripts such as `npm test`. Other full-access execution goes through the approval flow below.

These trusted classes are intentionally **unsandboxed execution**, not merely network/filesystem exceptions. Trusted Git may invoke Git hooks/helpers/configured transports under the Worker's normal host identity. Trusted `node --test` executes the selected test files/modules and code they import under normal host permissions. Use these classes only for workspaces whose Git/test execution you intend to trust at that level.

The automatic Git recognizer accepts only direct Windows Git segments for `clone`, `fetch`, `pull`, `push`, and `ls-remote`. Every executable segment in a compound command must independently qualify. Execution-altering global options and broader command families such as `submodule`, `remote`, and `lfs` are not automatically trusted. Unsupported Linux/macOS restricted Workers remain fail-closed.

Direct `node --test` is a built-in Windows PowerShell/pwsh trust path because Node's test runner needs child-process creation that the restricted Windows token blocks. `node --test ...` may carry normal test-runner suffix arguments; `node script.js --test`, `node --inspect --test`, and explicit unsupported shell overrides do not enter this trusted class. The normal JavaScript test suite therefore does not require a native-helper rebuild before every run.

### Trusted package scripts

For repetitive development commands that cannot run under the Windows restricted token, CCM can trust one simple package-manager script in one exact workspace. A trusted rule is bound to the environment, workspace id/root, exact package-script command, workdir, shell/TTY settings, package manager/script name, and the SHA-256 of the current `package.json` script text. A matching rule lets ordinary `exec_command` run that invocation with full host permissions without rendering an approval card. If the script text changes, the rule immediately stops matching and CCM falls back to the normal sandbox/escalation path.

The script hash protects the `package.json` script text only; it does not hash every source file, dependency, or test module transitively executed by that script. Matching a trusted package script therefore intentionally trusts the code that script loads at execution time.

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

Only structurally simple package-script commands qualify. CCM preserves the `npm test` shorthand and accepts explicit `npm run <script>`, `pnpm run <script>`, and `yarn run <script>` forms. Bare package-manager operations such as `npm install`, `npm ci`, and `yarn add` are not misclassified as package scripts. Shell chaining, pipes/redirection, and extra script arguments do not enter this trusted class. Rules may be managed explicitly through the Controller-host CLI above, or created through an execution approval when the frozen command is an eligible package script and the user chooses **Always allow in workspace**.

### Sandbox escalation and workspace allow rules

The approval flow below applies to restricted permission profiles. Restricted Workers support an explicit one-shot escalation flow through `exec_command(sandbox_permissions=require_escalated)`. The model supplies the exact command, `workspace_context`, optional working directory/shell/TTY settings, output/yield settings, user-facing justification, and optionally a reusable ordered-token `prefix_rule`. If no trusted class or saved workspace prefix applies, CCM parses the command conservatively, validates/freezes the proposed persistent scope, freezes the exact execution into a `PendingAction`, assigns an `approval_id` and `operation_id`, and returns without executing the command. The model then calls the Direct-only `request_approval` tool with only that opaque `approval_id`; `request_approval` binds the pending action to the approval card but cannot change the frozen command, prefix scope, or execution context. A `full-access` environment executes the requested command directly under normal Worker host permissions and does not create an execution approval.

The approval card receives a high-entropy approval capability only through tool-result `_meta`; that secret is not placed in `content` or `structuredContent`. For execution approvals the card displays the frozen workspace/environment/command/justification. **Always allow in workspace** is shown only when the Controller has frozen one valid persistable policy scope, and the card shows that exact token prefix (or hash-bound package-script scope) before the user clicks it. **Approve once** and **Deny** remain available independently. For workspace entry/registration the card displays the frozen environment/workspace/root/action and offers only **Approve** or **Deny**. The app-only `resolve_pending_action` resolver accepts only `approval_id`, the card capability, and the user's decision; it does not accept a replacement command, prefix, workspace target, workdir, shell, or TTY value.

On Approve, CCM resumes the already-frozen action directly. There is no second model decision and no model-generated retry of the command. The grant:

- is valid for the configured approval lifetime (3 days by default),
- is atomically dispatchable only while the frozen approval is in an allowed state,
- is bound to the environment, workspace context/root, command, working directory, shell, TTY mode, and execution output/yield settings,
- runs that one command with `full-access`,
- cannot be reused after execution.

After a terminal approve or deny result, the approval App separately hands that result back to the conversation. It first writes the bounded final result into model context, then triggers exactly one follow-up turn. Standard MCP Apps `ui/message` is preferred when the initialized Host advertises text-message support; the ChatGPT `sendFollowUpMessage` compatibility alias is only a fallback for missing or explicitly failed standard messaging. A successful standard message response is treated as authoritative and is never followed by the alias, preventing duplicate turns. If context handoff or both continuation routes fail, the server-side approval result remains final and the card reports that the user must send a message to continue; CCM never reruns the frozen action merely to recover conversation continuation.

**Always allow in workspace** still executes the current frozen action through the same approval state machine, but after successful Worker dispatch CCM stores the already-frozen policy scope under the protected Controller state directory. Generic execution policy is stored in `exec-policy.json` schema version 2 as ordered-token prefixes, bound to environment, workspace identity/root, working directory, effective shell, and TTY mode. Future `require_escalated` calls skip the approval prompt when every parsed executable segment is covered by a matching saved prefix under the same execution scope.

Prefix matching is token-based, not raw-string `startsWith`. A rule such as `["git","config","--get"]` matches `git config --get user.name` but not `git config --global --get user.name`. Additional suffix tokens after a matching prefix are intentionally authorized. Compound shell commands are segmented conservatively and the whole shell is automatically elevated only when every executable segment is independently trusted/allowed; unsupported or ambiguous shell syntax falls back to the normal sandbox/approval path.

For WSL this can intentionally be broad. A user-approved `["wsl.exe"]` prefix authorizes later escalated WSL invocations with arbitrary suffix arguments in that same workspace/shell context, including Linux-side writes, package management, networking, services, or root commands reachable through WSL. A narrower `["wsl.exe","-d","PhD-CFD"]` prefix scopes that authority to invocations beginning with that distro selector. The Linux command inside `bash -lc '...'` is opaque suffix data to the outer Windows prefix matcher.

Eligible package-manager scripts do not become generic token-prefix rules. Before package-script trust is created, CCM reads the current `package.json` script through the restricted Worker and stores a SHA-256 of that script text in the separate trusted-package-script store. Future automatic execution re-reads the script; changing the script invalidates the rule and restores the normal path.

Generic saved prefix policy is consulted only for calls that request escalation; it does not silently convert an unrelated `use_default` command into full-access. This is relevant to WSL: a normal sandboxed WSL call may first fail with a WSL-service `E_ACCESSDENIED`, after which the caller retries the operation with `require_escalated`; a matching saved WSL prefix then authorizes that escalated retry.

If CCM can prove a failure occurred before Worker dispatch, the same frozen action may be presented for retry with the same frozen prefix scope. If a timeout/disconnect makes it uncertain whether the Worker started the command, the approval enters `execution_unknown`; CCM will not retry automatically and saves no policy. If execution succeeds/starts but persisting **Always allow** fails afterward, the action remains consumed: CCM reports the policy-save failure and does not rerun the command merely to retry persistence. Denied, consumed, unknown-outcome, and expired requests cannot start another execution.

For restricted profiles, workspace entry/registration uses the same card capability and one-shot state model, but it never grants `full-access` and never creates an execution allow rule. On approval CCM re-reads the registered workspace or re-inspects the registration path, verifies that the frozen environment/workspace/root still match, then creates the registered `workspace_context`. If the target has drifted, the frozen action fails closed and is consumed so a new approval is required. A pending workspace action blocks only continuation that depends on that same current intended target: after calling `request_approval`, the model waits rather than continuing that project through a projectless context or retrying the same target. If the user explicitly corrects or changes the intended project, the old approval becomes superseded orchestration state but remains an independent valid pending action until resolved or expired; the model may immediately request entry/registration for the new real project without requiring the user to Deny the old card. Multiple workspace approvals can therefore coexist with distinct `approval_id` values, and approving an older card creates only that older target's own `workspace_context`; it does not change which project the model should treat as current. In a `full-access` environment, `select_workspace` and `register_workspace` perform the same identity/path revalidation and context creation directly without creating an approval request.

There is no model-driven approval retry path and no public text-decision approval endpoint. When a restricted-profile business action requires approval, CCM freezes that action and returns an opaque `approval_id`; `request_approval` renders the card, and the app-only `resolve_pending_action` consumes the frozen action after the user's decision. Full-access workspace and execution actions do not enter this approval state machine.

This approval mechanism controls CCM's sandbox boundary; it does **not** grant Windows Administrator/UAC privileges. The approval app is the interaction mechanism, while the server-side frozen action, approval capability, state machine, and workspace revalidation remain the security boundary. If ChatGPT supplies its anonymous `openai/session` metadata on both calls, CCM also binds the request and app resolver to that host session as defense in depth.

## Output and transport protection

CCM treats oversized output as a reliability and context-safety problem.

The OAuth/public sidecar also isolates MCP request identity. Downstream clients that initialize separate MCP sessions receive separate upstream sessions, and downstream POST calls that omit `Mcp-Session-Id` use request-scoped transient upstream sessions instead of sharing one persistent request-id namespace. This prevents concurrent clients that reuse the same JSON-RPC id (for example `id=0`) from overwriting each other's upstream response routing.

Command capture is bounded, model-facing command output has a token budget, live process reads are incremental, Worker protocol messages have a hard serialized-size ceiling, final MCP tool results have an absolute byte limit, and `view_image` checks file size before reading/encoding it.

If a hard transport limit would be exceeded, CCM returns or triggers a compact failure instead of attempting to send an oversized response.

## MCP result format

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
