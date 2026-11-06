# CCM — Codex-Compatible MCP

CCM is an MCP execution harness targeting source-level behavioral parity with upstream Codex outside GPT Host integration. It provides persistent process sessions, Remote Workers, native sandboxing, bounded tool output, patching, and image reads. Full parity has not yet been verified.

CCM does **not** attempt to reproduce Codex's model loop or own the host application's conversation history. The MCP client remains the orchestrator; CCM owns the execution world.

Before modifying this repository, read and follow [AGENTS.md](AGENTS.md) for repository-specific agent instructions.

## Codex upstream conformance

OpenAI Codex is the normative upstream for every CCM behavior except the ChatGPT/GPT Host integration layer (MCP transport, OAuth, host-specific cards and UI). The architecture rule in `AGENTS.md` requires an exact upstream commit and source-level behavior mapping **before** changing execution, approval, rules, sandboxing, environment, configuration or tool semantics. CCM-specific transport between Controller and Workers may adapt implementation language and process boundaries, but may not silently change upstream behavior. Any unsupported behavior or intentional departure requires the user's prior decision.

**Audit baseline (2026-11-05):** `openai/codex` commit `ed8eac40832e6a79f30eaeb3c521912f231d43eb`. Relevant upstream entry points verified at this revision include `codex-rs/execpolicy/src/{parser,rule,policy,decision,execpolicycheck}.rs`, `codex-rs/shell-command/src/{powershell,parse_command}.rs`, `codex-rs/core/src/{exec_policy,exec_env}.rs`, and `codex-rs/protocol/src/{approvals,shell_environment,sandbox}.rs`. For future work, pin and inspect the actual upstream revision used rather than assuming this baseline is still current.

**Alignment is not complete.** CCM still has a separate JavaScript command parser/policy store, Controller approval flow, native Windows sandbox, and independent proxy, CA and registry-environment refresh mechanisms. The current environment-policy port below matches the documented Codex policy transformation but **does not** establish parity for the whole launch pipeline or configuration layering. Sandbox selection, escalation, persistence, error and session semantics still require source-by-source comparison. Do not silently preserve behavior merely because CCM had it before.

The continuing source-to-implementation audit matrix, evidence and remaining gates live in [docs/codex-parity.md](docs/codex-parity.md). Keep it current whenever a Codex-derived behavior is modified.

### Native upstream Codex execution-policy engine

The complete Rust engine in `codex-rs/execpolicy/src` at upstream commit `ed8eac40832e6a79f30eaeb3c521912f231d43eb` is now tracked **without rewriting the core policy code** under `native/codex-execpolicy/src`. Its upstream `codex-rs/utils/absolute-path/src` dependency is tracked under `native/codex-utils-absolute-path/src`. Both retain OpenAI Codex's Apache-2.0 attribution. The standalone package manifests, native build integration and JSON-lines `src/bin/ccm-bridge.rs` are CCM transport/build adapters, not replacement rule engines. The native build produces the upstream-compatible `ccm-codex-execpolicy` CLI and a `ccm-codex-execpolicy-bridge` that calls Codex's parser, decision model, and file-locked `blocking_append_allow_prefix_rule`.

An actual Codex `.rules` file supports `prefix_rule(pattern=[...], decision="allow"|"prompt"|"forbidden", match=..., not_match=...)`, token alternatives, `canonical_matching`, `host_executable` restrictions and the upstream rule severity ordering. The native engine's parser validates embedded match examples before accepting a file. The standalone native and IPC tests verify these behaviors, invalid syntax rejection, and idempotent persisted Allow.

**Deployment boundary:** This native engine is built and independently tested, but it is **not yet the live Controller policy authority**. The Controller currently still reads its own `exec-allowlist.json` and performs its existing approval routing. No live approval decisions or saved grants have been changed in this stage. Connecting the upstream `.rules` evaluation, Codex approval decisions, sandbox fallback and exact rule persistence is the next migration slice; do not claim full policy parity before that integration and its adversarial tests pass. The current implementation deliberately does not introduce an extra CCM-specific Starlark parser or silently import/alter previously approved rules.

### Codex PowerShell literal command parser and persistent prefix rules

CCM now compiles and calls the **unchanged Codex Tree-sitter PowerShell lowerer** from `codex-rs/shell-command/src/command_safety/powershell_tree_sitter.rs`, pinned to upstream `ed8eac40832e6a79f30eaeb3c521912f231d43eb`. Its original upstream tests and fixture JSON are bundled in `native/codex-powershell-parser/src/`; see [docs/codex-parity.md](docs/codex-parity.md) for exact upstream blob hashes. Build the native helper with `npm run build:native` on **each Worker and Controller installation**. Only successfully lowered PowerShell commands participate in existing persistent prefix decisions; failed or unsupported parsing never enables auto-elevation. This is a native Rust source port with a narrow JavaScript IPC adapter, not a replacement regular-expression parser. The CMD command parser and CCM built-in executable rewrite remain outside this upstream port.

Saved `Always allow` prefix tokens now compare **exactly** like Codex's non-canonical `PrefixPattern`: `wsl.exe` and `wsl`, or differently cased paths, are not interchangeable. A PowerShell pipeline can reuse persistent Always allow only when every lowered executable segment is explicitly covered by rules. This does **not** imply CCM's built-in pinned commands can rewrite a pipeline. PowerShell invocation operators, including `& 'C:\\texlive\\2026\\bin\\windows\\xdvipdfmx.exe'`, and expressions such as `$env:TEXMFHOME='...'; & ...` remain opaque for reusable Allow and do not inherit a prior executable-only grant. Use Codex's existing `[shell_environment_policy.set]` for process-session environment configuration; it does not grant one-shot execution permissions.

**Alignment limitation:** Codex's Starlark `.rules` policy engine, full approval decisions, sandbox fallback, and rule persistence are **not yet migrated**; CCM still uses its own Controller approval and allowlist storage for these parts. Do not interpret this source-level parser port as completion of the entire Codex execution authorization design.

### Codex shell environment policy: first integrated subsystem

**Upstream pinned source:** `ed8eac40832e6a79f30eaeb3c521912f231d43eb`: `codex-rs/protocol/src/{shell_environment.rs,config_types.rs}`, `codex-rs/config/src/shell_environment_policy.rs`, `codex-rs/core/src/exec_env.rs`, and upstream `shell_environment_tests.rs`.

The upstream-derived shell environment implementation is attributed to OpenAI Codex (Apache License 2.0); its license is included at `third_party/openai-codex/LICENSE`.

CCM now reads the standard Codex `config.toml` under `CODEX_HOME`, or under the current Worker's `~/.codex` if `CODEX_HOME` is absent, when constructing its Worker executor. This shares the existing Codex `[shell_environment_policy]` configuration on each Worker rather than creating a conflicting CCM-only policy format. Supported TOML keys are `inherit = "all" | "core" | "none"`, `ignore_default_excludes` (Codex defaults to **true**), `exclude`, `include_only`, `set`, `filters` and `experimental_use_profile`. The canonical `filters` table cannot be mixed with legacy `exclude`/`include_only`; filter patterns are case-insensitive and have `*`/`?` wildcards. The policy applies inheritance, default excludes (when enabled), custom excludes, explicit overrides, include-only filtering, runtime thread ID (if provided), and final Codex non-inheritable identity-variable removal in that order. Windows overrides compare keys without case, and missing `PATHEXT` receives the Codex fallback. Pipe, PTY, restricted and Full Access launch paths share this environment calculation; the experimental profile setting reaches the PowerShell launch arguments in both native and direct paths. Restart the relevant Worker after updating Codex config to load a new policy.

To configure a TeX user tree using Codex's actual configuration format, place `TEXMFHOME = "C:\\\\texmf"` under `[shell_environment_policy.set]` in that Worker's `~/.codex/config.toml`; it applies to all new shell commands in that Worker session, **not** just one `xdvipdfmx.exe` invocation. This implementation does not introduce a per-command `env` argument because that is not the Codex tool's contract.

**Known launch-path mismatch still to resolve:** CCM currently refreshes Windows Machine/User registry environment variables for each command and applies its independent Worker child-proxy and local CA settings before the Codex policy; upstream Codex starts from the process environment managed by its own config/session layers. Explicit Codex `set` overrides the CCM command-layer values, so the effective result may differ from CCM's proxy/direct toggle when the same keys are explicitly configured. These retained facilities are **not** claimed Codex-parity features; no migration/removal has been made yet.

## Status

CCM is currently targeting **v0.1** as its first public release.

- Milestone 1 — Execution Core: implemented and regression-tested.
- Milestone 2 — Environment + Remote Worker: implemented and regression-tested.
- Milestone 3 — Editing (`apply_patch`, `view_image`): implemented and regression-tested.
- Milestone 4 — Tool Architecture / Code Mode: implemented and regression-tested.

The v0.1 release gate is defined in [PROJECT.md](PROJECT.md). v0.1 is intended to be directly publishable rather than a private prototype.

## Architecture

### MCP server icon

CCM includes `assets/ccm-icon.png`, its square 512×512 PNG brand icon. The
tracked PNG is optimized to 9,617 bytes, below the 10,000-byte upload limit
observed in ChatGPT's plugin creation UI. **When creating the CCM plugin in
ChatGPT, manually upload `assets/ccm-icon.png` as its icon.** ChatGPT does not
currently use the MCP URL metadata to fill that icon field automatically.

The MCP `initialize` response advertises `serverInfo.icons` with a
same-origin, permanent HTTPS URL: `<CCM_RESOURCE origin>/ccm/preview/icon.png`. The public
OAuth sidecar serves that path as `image/png` without credentials, so MCP clients
that support the standard icon metadata can retrieve the same image by URL.

The public Tailscale Funnel routes the existing `/ccm/preview/*` prefix, but not
arbitrary new `/ccm/*` paths. Serving the static icon under that existing prefix
therefore works without a Funnel configuration change. The reserved filename
`icon.png` is not a temporary file token and has no file-transfer expiry.

The current artwork was generated with the independent CPA ImgGen Skill using
`gpt-image-2.5` and the authoritative full prompt in
`assets/ccm-icon-prompt.txt`, reviewed visually, and converted to a clean 512×512
PNG for use at icon sizes, then palette-optimized below 10,000 bytes for manual
ChatGPT upload. Update the prompt before any new CPA generation and
visually review the result before replacing this asset. CPA API credentials are
never stored in this repository. The static icon URL is stable and is independent
of the temporary published-file download system.

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

Registered workspaces are owned by each Worker, not by the Controller. **Workspace handle** (`workspace_handle`) is a reusable UUID-shaped reference to one workspace on one Worker; it is not an `environment_id`, `workspace_id`, conversation context, or MCP session. A registered workspace may have multiple valid handles. If the user, project instructions, or CCM already supplies a handle for the intended project, pass it directly to operational tools; do not call `select_workspace`, `register_workspace`, or `create_projectless_handle` and do not request entry approval merely to obtain a new handle. Only call deferred `select_workspace` when no usable handle exists **and** the user explicitly requests workspace entry/switching. Only call deferred `register_workspace` when the user explicitly requests registration and no usable handle exists. Discover them through `tool_search` and invoke them through `exec`. Reading, inspecting, editing, or working on a project (including saying "read the workspace") never authorizes entry, registration, or an entry approval; a missing or rejected handle does not authorize automatic entry. Deferred + Code Mode `select_workspace` / `register_workspace` calls always validate the exact workspace identity or registration target. In a `full-access` environment, entry returns the real `workspace_handle` without binding a UI; the model then calls the separate read-only Direct `show_workspace_handle` tool with that exact handle to display a copyable card. Restricted environments freeze the exact workspace action and return an opaque `approval_id`; the top-level Direct `request_approval` tool renders that frozen action in the CCM approval app, and on successful approval the same card displays the workspace handle. Restricted entry tools do not create a handle-card iframe while approval is pending. Approval resumes the same validated action without a model-generated retry. `register_workspace` combines registration and entry; with `create_if_missing=true`, the action may also create the exact missing project directory before registration. Denied/failed/pending actions do not show a new handle, and `create_projectless_handle` never shows one. Normal development tools carry only the resulting handle. Workspace handles are persisted by the Controller and remain valid across Controller or Worker restarts; entering a project again generates a new valid handle without invalidating the old one. Worker-local projectless mappings are persisted as well, so a surviving projectless directory can be resumed after a Worker restart.

An environment does not expose a default workspace or default working directory to the MCP client. Worker bootstrap cwd is a runtime seed only; it is not a project-location hint, a default project, or the parent directory for newly created projects. CCM deliberately has no "Projects Root" policy: project placement comes from the user or the upper-layer orchestrator.

When no suitable handle exists, a genuinely projectless task or a permitted absolute-path read can use a projectless workspace via Direct `create_projectless_handle`. For writing to a registered project, ask for its handle or an explicit entry request; do not select or register implicitly. Pass `environment_id` to create it on a specific Worker, or omit `environment_id` to use the primary environment. Projectless workspaces are created under `CCM_PROJECTLESS_ROOT` (default: the user's `Documents\\CCM` directory) and provide a temporary execution context without selecting or registering a real project. If `select_workspace` or `register_workspace` has already returned `approval_required=true` for the user's current intended real project, the model calls `request_approval` and waits for that frozen workspace action rather than using projectless workspace to bypass it. Changing the target project alone does not authorize a new entry. A separately explicitly requested workspace entry/registration may proceed without denying the older pending approval.

`ccm.unregister_workspace(environment_id, workspace_id)` removes one registered project from its Worker's registry without deleting the directory or any files. Discover it via `tool_search`, invoke it through `exec`, and display its mandatory one-shot `request_approval` card, **including on full-access Workers**. It has no Always-allow option. The tool reads the Worker-local registration metadata even when the original project directory has already been deleted; regular workspace selection and execution still require an existing directory. Approval freezes the Worker, workspace id, root and creation time, then rechecks that exact registration before revoking its previously issued workspace handles and removing the registration. Old handles cannot be reused after re-registration. Existing running OS processes are not forcibly terminated, although their old handle can no longer continue a CCM process session. Rejection, expiration, or a changed registration do not remove the registry entry. Projectless workspaces cannot be unregistered. A bootstrap project is seeded only on first registry creation, so approved unregister does not silently re-register it on Worker restart.

### Owner web unlock: timed global Full Access

CCM keeps its original per-Worker `CCM_PERMISSION_PROFILE` (normally `workspace-write`). The Controller additionally accepts **owner-issued, time-limited Full Access grants**. One claimed grant can be used on any existing or newly connected Worker, regardless of its original sandbox setting; neither Worker settings nor the workspace handle are changed. Authorization is checked for each new operation. Already-started Full Access processes are allowed to finish naturally after expiry. Workspace deregistration continues to require its own one-shot approval, including during a timed grant.

**One-time local phone authenticator enrollment (6v only):** In a *local terminal*, run the absolute-path PowerShell script `C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\scripts\manage-ccm-totp.ps1` with `-Action Init`. Add the displayed secret or OTP URI to a phone TOTP app (SHA1, six digits, 30-second period), then run the same script with `-Action Confirm -Code <six-digit-code>`. Use `-Action Status` to inspect setup. Never execute `Init`, `Confirm` or `ReadForSidecar` through CCM or pass enrollment secrets/verification codes through a model or chat. The seed is stored via Windows DPAPI CurrentUser outside Git under `%LOCALAPPDATA%\CCM\secrets`, and the supervisor/sidecar must run under that same Windows account. `-Action Reset` clears enrollment and browser pairings, and invalidates active grants by changing the confirmed-enrollment marker; enroll again before reuse.

After enrollment, visit the CCM HTTPS origin's **`/ccm/unlock`** page. The browser pairs once with a phone TOTP code (replay-protected, rate-limited); subsequent visits use its secure HttpOnly pairing cookie. The owner selects 1 minute, 5 minutes, 30 minutes, 1 hour, 6 hours, 1 day, or 7 days and clicks **临时解锁 CCM**. The Controller keeps one pending grant for at most five minutes. Repeated clicks while pending **never create a new grant, overwrite the old one, or extend the claim deadline**, and the webpage shows the remaining claim window. If the grant is unclaimed after five minutes it expires; another click then issues a new pending grant.

Once the owner reports an unlock, the model discovers Deferred `ccm.claim_full_access` through `tool_search` and invokes it through `exec` with no arguments exactly once. The reply contains the `full_access_grant_id` and expiration timestamp. Supply that ID explicitly on `exec_command`, `apply_patch`, and explicitly requested deferred `select_workspace` / `register_workspace` calls to use the granted permission. The claim removes the webpage's pending state **without revoking the claimed grant**. Unrecognized/expired IDs fail closed. Other sessions and calls without the ID continue under their original policies; a model must not infer authorization just because another caller has unlocked CCM. The grant lives only in Controller memory and is revoked on Controller restart. The model must not send any TOTP seed or one-time verification code to an ordinary CCM tool.

The public `/ccm/unlock` path is forwarded through Tailscale Funnel to the existing HTTPS OAuth sidecar; the internal sidecar-to-Controller `/ccm/internal/web-unlock` bridge stays loopback-only, uses the existing ignored CCM approval secret, and must never be added to public Funnel rules. The browser has a one-time CSRF cookie and form token on every page load and uses `Secure; HttpOnly; SameSite=Lax` pairing cookies. Local browser tokens are saved as hashes under ignored `.state/`. Access to the Windows account, the sidecar credentials, and the Controller's local bridge remains a trusted administrative boundary; timed Full Access is an owner-controlled convenience guard, not a separate OS administrator login.

### Identity and lifecycle terminology

CCM deliberately keeps transport identity, execution identity, process identity, and higher-level task state separate. Do not use the word "session" interchangeably for these concepts.

- **Host conversation / ChatGPT conversation**: conversation state owned by the MCP client. CCM does not own it and must not assume a one-to-one mapping between a host conversation and an MCP session.
- **MCP session**: the current CCM HTTP implementation's stateful Streamable HTTP protocol/transport session. It is created during MCP initialization, identified by the `Mcp-Session-Id` header, and used by the Controller to find the corresponding transport and protocol server. It may span multiple user turns, and a single host conversation may create more than one MCP session because of reconnects, fresh initialization, Controller restart, or other client lifecycle events. **An MCP session is not a durable task, plan, workspace, or conversation identifier.**
- **Process session (`session_id`)**: a live command/process continuation handle returned by `exec_command` and consumed by `write_stdin`. It identifies one running process session and is unrelated to `Mcp-Session-Id`. Continuation is scoped by the pair `(workspace_handle, session_id)`; callers must pass the same `workspace_handle` that created the process.
- **Workspace handle (`workspace_handle`)**: an opaque logical execution-context identifier that binds a Worker and workspace/projectless root. Workspace handles are persisted independently of MCP transport sessions and may remain valid across Controller or Worker restarts.
- **Approval (`approval_id`)**: a one-shot authorization record for one exact escalated operation or workspace entry attempt. It is neither an MCP session nor a workspace handle.
- **Plan**: a logical planning cycle, if/when Plan Mode is used. One MCP session may contain zero, one, or multiple plans. A persisted plan may outlive the MCP session that created it. A session-scoped "active plan" pointer is only a convenience for multi-turn continuity and must never redefine the MCP session itself as the plan identity.

Useful cardinality rules:

```text
host conversation  -> 0..N MCP sessions
MCP session        -> 0..N process sessions
MCP session        -> 0..N logical plans
workspace_handle  -> independent of MCP session lifetime
persisted plan     -> may outlive MCP session lifetime
```

When adding stateful features, choose an identity according to the feature's real lifecycle. Do not key durable intent solely by `Mcp-Session-Id` merely because it is convenient at the transport layer.

## Direct MCP tools

| Tool | Purpose |
| --- | --- |
| `exec_command` | Run a native shell command inside an existing `workspace_handle`. |
| `create_projectless_handle` | Create a projectless execution handle for temporary tasks without a suitable existing handle; no UI attached. |
| `show_workspace_handle` | Display a validated registered handle in a copyable card after full-access entry; read-only, Direct only. |
| `request_approval` | Render the CCM approval app for one already-frozen pending action. It accepts only the returned `approval_id`. |
| `resolve_pending_action` | App-only resolver used by the CCM approval app to approve/deny and resume a frozen execution or workspace action. It is hidden from normal model use through MCP Apps visibility metadata. |
| `request_verification_input` | Open a verification-code MCP App for a live process using its exact `(workspace_handle, session_id)`; no code is passed through model arguments. |
| `submit_verification_input` | App-only tool: send the typed code and Enter to the bound process; return only the delivery state. |
| `get_verification_input_status` | App-only read of the input-card state, including after reopening. |
| `write_stdin` | Write to or poll a live process session returned by `exec_command`; requires both `session_id` and the owning `workspace_handle`. |
| `apply_patch` | Apply a Codex-style patch inside an existing `workspace_handle`. |
| `view_image` | Read and validate a bounded image inside an existing `workspace_handle`. |
| `tool_search` | Discover deferred ToolRegistry capabilities without expanding the top-level MCP schema. |
| `exec` | Dispatch one or more nested registered capabilities, sequentially or safely in parallel. |
| `wait` | Resume a nested `exec` cell that yielded before completion. |

Normal repository inspection, search, Git, builds, tests, and diagnostics should usually go through `exec_command`.

### Verification input card

When a running interactive command pauses for a verification code, call Direct `request_verification_input({workspace_handle, session_id, label?})`. The user enters the code **in its MCP App card, not in chat**. The card calls App-only `submit_verification_input({request_id, value})` through `tools/call`. Controller sends the input plus Enter to the already running Worker process session (CR for PTY, LF for pipes), then the card returns only delivery state and a code-free conversation continuation. The model can poll the original session through nested `ccm.write_stdin`.

The submit/status tools have `ui.visibility=['app']` and are not ordinary model-facing tools. Each card sends input at most once, including after remounts and duplicate clicks. Controller retains only routing metadata in memory for up to four hours, never the entered value. CCM does not write the value into its own persisted logs, approval receipts, widgetState, model context, or follow-up messages; the target program's own logging behavior remains outside this contract. A two-minute transient in-memory echo mask also scrubs the exact entered value from later ordinary process output; the mask expires even without further polling. An uncertain delivery is not retried automatically.

This is a **live process stdin** feature, not a general-purpose website form filler or a model-readable code mailbox. An exited session cannot receive input. MCP App calls still traverse the ChatGPT Host and may be filtered there: App-only routing avoids model-generated code arguments but cannot guarantee Host acceptance. No new public endpoint, long-term secret store, or external service is required. Refresh CCM tools in ChatGPT after deploying the new Direct tool.

### Core deferred capabilities

These are core CCM operations but intentionally stay off the top-level MCP schema. Discover them with `tool_search` and invoke them through `exec`.

| Capability | Purpose |
| --- | --- |
| `ccm.claim_full_access` | Claim one owner-issued pending global Full Access grant within five minutes of the webpage unlock; pass the returned `full_access_grant_id` explicitly to privileged operations. |
| `ccm.list_projects` | Show connected execution environments, their registered projects, capabilities, and coarse effective filesystem read/write scope. Omit `environment_id` to inspect all connected Workers; use `all=true` only to include projectless workspaces separately. |
| `ccm.select_workspace` | Enter an existing registered workspace only on explicit request and without a usable handle; returns a handle or frozen approval request. |
| `ccm.register_workspace` | Register/enter a project path (optionally create it) only on explicit request; returns a handle or frozen approval request. |
| `ccm.unregister_workspace` | Request mandatory one-shot approval to remove one registered workspace while preserving its files; success revokes its existing workspace handles. |
| `ccm.plan_patch` | Create or update one durable Plan using Codex-style patch syntax and an explicit opaque `plan_id`. |
| `ccm.plan_read` | Read, range-read, or search only the Plan identified by `plan_id`; reading does not change planning/implementation workflow. |

### Durable Plans

CCM provides durable Plan storage without implementing a Controller-side "Plan Mode" state machine. When a user explicitly asks to plan/discuss before implementation and persistence is useful, discover `ccm.plan_patch` / `ccm.plan_read` through `tool_search` and invoke them through `exec`.

`ccm.plan_patch` omits `plan_id` only for the first write. That call creates a Plan and returns an opaque UUID; later reads/patches carry that id explicitly, so Plan identity is independent of MCP transport sessions. Managed Plans are stored centrally under ignored Controller state at `.state/plans/<plan_id>.md`; no public list/delete/search-other-Plans capability is exposed and v0.1 does not automatically expire or garbage-collect Plan files.

Plan patches reuse the normal Codex-style patch grammar but target one virtual file only: creation uses `*** Add File: plan.md`, and updates use `*** Update File: plan.md`. The real `.state` path is never accepted as a tool argument. Planning follows an explore-first, ask-second discipline: discoverable repository/environment/documentation/tool facts should be established through targeted non-mutating inspection rather than questions. If a high-impact ambiguity instead depends on a non-discoverable user preference, product/scope/compatibility choice, or meaningful tradeoff, ask rather than guess. For those decisions, explicitly present 2-4 mutually exclusive choices in the user-visible question, preferably with concise labels, and identify a recommended/default choice there when useful; the user may still give another answer outside the listed choices. Generating options only in model reasoning without showing them to the user does not satisfy this planning contract.

While Plan work remains planning, normal read/search/status/history/diff inspection, diagnostics, dry-run/non-mutating validation, and tests/builds whose only side effects are ignored/cache/temp outputs are allowed. Tracked implementation edits, implementation patches, migrations, rewriting code generation or formatting, dependency/configuration changes, deploy/release actions, commits, pushes, and similar intentional mutations require an explicit user instruction to execute/implement. Imperative task wording, completed inspection, workspace approval, registration approval, or sandbox escalation approval does not itself authorize implementation. CCM intentionally does not add a Controller-side Plan-Mode state machine or clone Codex Host-specific `request_user_input`, `<proposed_plan>`, or PlanDelta UI/protocol behavior; a clear user instruction to execute/implement is the transition into implementation.

Keep the logical Plan current rather than append-only: rewrite or remove completed, invalidated, obsolete, or superseded items while preserving active constraints and unresolved decisions. A decision-complete Plan should capture the goal/success criteria and scope, implementation approach and affected components/files, relevant interface/schema/data-flow changes, edge cases/failure modes, compatibility/migration/cleanup decisions, tests/validation, and acceptance criteria, with genuinely blocked assumptions or unresolved items labeled explicitly. The handoff should be concise but detailed enough that another executor does not need to invent new product or design decisions.

When planning reaches a decision-complete stopping point, the model calls Direct `ccm-extra.publish` with `plan_id` only. Controller reads the **entire latest persisted Plan** directly and publishes an immutable Markdown snapshot without the bounded `plan_read` path or a Worker handle. The model summarizes key decisions in the reply and refers to the publication card/link instead of repeating the full Plan text. If publication fails, the model reports the failure without claiming delivery or automatically dumping the Plan into chat. This handoff is specific to finishing the planning phase; it does not authorize implementation. `ccm.plan_read` remains lifecycle-neutral during implementation, so implementation can consult a Plan repeatedly without re-entering planning or automatically republishing.

## ToolRegistry and Code Mode

CCM stores capability exposure as three independent surfaces:

- **Direct** — included in MCP `tools/list`.
- **Deferred** — omitted from the initial schema and discoverable through `tool_search`.
- **Code Mode** — callable as a nested capability through `exec`.

Convenience states such as Direct, Deferred, CodeModeOnly, DirectModelOnly, DeferredModelOnly, and Hidden are derived from those surfaces rather than stored as one rigid enum.

The direct MCP surface is intentionally small. Common Direct primitives include exec_command, write_stdin, apply_patch and view_image plus dispatch/approval bridges. The user-facing publisher `ccm-extra.publish` is Direct + Code Mode, creates temporary HTTPS links and one MCP App file card, and does not create native ChatGPT attachments. `exec` stays Direct for nested tools and native ChatGPT input binding. Other workflows including `ccm-extra.import_chatgpt_file` remain Deferred + Code Mode.

Keeping ordinary additions off the Direct surface prevents routine feature work from changing the client's top-level MCP schema. In particular, adding a deferred capability should **not require deleting and recreating the CCM integration in ChatGPT or another MCP client**. Updating CCM server code may still require restarting the Controller and/or Worker processes so the new implementation is loaded; that is separate from recreating the client integration.

Keep ordinary CCM capabilities Deferred + Code Mode, including registered-project entry/registration (`select_workspace` / `register_workspace`) and removal (`unregister_workspace`). `create_projectless_handle` is Direct + Code Mode to make temporary work available without discovery when no suitable handle exists; it does not show a handle card. The read-only `show_workspace_handle` stays Direct + model-only because its MCP App displays the registered handle after full-access entry; restricted entry displays the handle in the approval card instead. `ccm-extra.publish` is another Direct + Code Mode user-delivery workflow; `ccm-extra.import_chatgpt_file` remains Deferred + Code Mode because native ChatGPT input-file binding is performed by the Direct `exec.file` wrapper.

### Compatibility contracts

CCM treats confirmed client/Host/model/Worker compatibility findings as repository behavior, not conversation-only notes. When a compatibility issue is confirmed, record the affected surface and required routing/workaround here; remove the wording when the constraint no longer applies.

- **Published-file MCP App client compatibility:** The current `published-file-v9` card uses a bounded 260px rendered Markdown excerpt, a 220px source snippet for other text types, and external full-preview links (image previews allow zoom/drag). Some ChatGPT Android and mobile-web versions may scroll the chat instead of the preview or fail to mount a revised UI URI, even when `resources/read` and tests succeed. Verify card opening and links on actual clients before claiming Host compatibility.
- **Model routing / Direct surface:** prior generic observations suggest some extra top-level workflows may be routed less reliably by models. This does not establish a specific `publish` Direct failure. Validate real usage; the user chose Direct visibility for this output-only HTTPS publisher.
- **Direct definition caching:** ChatGPT may cache a top-level Direct tool's full model-visible definition, including description text, across conversations. After a CCM restart, use the ChatGPT CCM plugin's **Refresh tools (刷新工具)** control to reload Direct tools; opening a new conversation or reconnecting alone may leave a stale tool list. The mobile/web UI refresh was confirmed to expose a new Direct tool without deleting/recreating the connector or printing a handle. Deferred definitions remain discoverable through `tool_search`.
- **6v/noha release synchronization (maintainer procedure, not model-facing tool guidance):** A completed CCM update includes matching Git commits on the 6v Controller checkout and noha Worker checkout. Push tested changes from 6v, fast-forward noha without discarding local edits, restart the respective supervisors/Workers, and verify both commit hashes and Controller health / noha reconnection. Report blocked deployment or version skew as incomplete; only intentionally stage versions when the user requests it.
- **Native input-file binding:** `ccm-extra.import_chatgpt_file` is Deferred + Code Mode and receives the native file object via Direct `exec.file`; Library objects are first materialized with ChatGPT Files.
- **Approval UI:** `request_approval` stays top-level Direct because it carries the Host/App output template and widget metadata. `resolve_pending_action` is App-only and resumes the frozen action; neither belongs in ordinary deferred nested dispatch. After a terminal approval decision, the App updates model context and prefers the standard MCP Apps `ui/message` bridge when the Host advertises text-message support. The ChatGPT `window.openai.sendFollowUpMessage` compatibility alias is used only when standard messaging is unavailable or explicitly fails. Continuation failure is reported in the card and never changes or retries the already-resolved action.
- **Approval card reopening (ChatGPT web/Android):** The Host may remount MCP App cards with the original pending tool result. The approval-v3 app preserves terminal UI state and the successful registered-workspace handle using the optional ChatGPT `widgetState` API and the App-only `get_approval_status` read. Old pending results must never override verified terminal state. On web, `openai:set_globals` may precede the `ui/initialize` response; after the handshake, start one read-only status query even when the same approval was already loaded. The read requires the original card nonce (and bound Host session when present), never executes an action, and cannot be used by the model. The Controller atomically stores bounded terminal receipts under its private state dir (90 days, at most 4096 records), separate from the existing in-memory 5-minute terminal cleanup and 3-day pending approval TTL. Execution receipts retain up to 12,000 characters of the initial command output, truncation indication, and an exit code or session ID; the approval card reveals saved output in a collapsed, selectable panel. Continuing-session output from later `write_stdin` calls is not part of that initial receipt. Output may contain sensitive data and remains in the private Controller state file for its retention period. Command text and card nonces are never persisted in receipts. Controller restarts discard pending actions but retain eligible terminal receipts. If the Host doesn't provide prior card metadata, verification fails closed (no second Approve/Deny). Old approval-v1/v2 URIs remain aliases for new UI HTML, but cached historical old HTML cannot be repaired remotely. UI snapshots never store nonce, command output, or new permissions. Host restart/reopen validation on Android is required before calling the client rendering fully verified.
- **Workspace-handle cards (ChatGPT web/Android):** MCP Apps are attached to tools by static UI metadata, not to individual success results. Attaching the handle widget to `select_workspace` / `register_workspace` created an empty iframe on restricted pending approvals; hiding the HTML content cannot remove the Host-owned outer frame. These action tools now have no UI metadata. On full-access success, call the separate read-only Direct `show_workspace_handle(workspace_handle)` tool to render the validated registered handle with a copy button. On restricted success, the existing `request_approval` card itself shows the handle. Failed, denied, pending and projectless actions must never invoke the standalone handle-card tool. Refresh ChatGPT tools after rollout to load the changed descriptors.
- **Outbound file publishing with one file card:** `ccm-extra.publish` is Direct + Code Mode, one resource per call, serial for multiple files. Original bytes are retained in a bounded 1 GiB Controller cache for up to 72 hours. The MCP App shows fitted PNG/JPEG/WebP/GIF/AVIF/BMP images; a scrollable 260px rendered Markdown excerpt from at most 8 KiB of source (32 KiB rendered limit) and a full formatted HTML preview link; a 220px source excerpt for other UTF-8 text/JSON/code with a full-text link; or a browser preview link for PDF, audio (MP3/WAV/M4A/OGG/FLAC/AAC), video (MP4/WebM/OGV/MOV), and HTML/SVG/XHTML. Every card retains an original-file download link. Markdown rendering escapes embedded HTML, blocks script URLs and remote image loads, and is isolated by the same restrictive CSP sandbox used for HTML/SVG. Plain text remains `text/plain; charset=utf-8` with `nosniff`. Browser rendering and codec support depend on the client; unsupported types such as Office files remain download-only without conversion. Media and PDF previews support single HTTP byte ranges; generated Markdown HTML always returns the full rendered page. The existing `/ccm/preview/<token>` and `/ccm/download/<token>` routes need no extra Funnel route, intermediate HTML file, MCP resource, or ChatGPT Library storage. Invalid UTF-8 Markdown cannot be rendered, but its original bytes remain downloadable. Publish proactively for requested artifacts; verify clickable links in each ChatGPT client after deployment.
- **ChatGPT link tracking on file URLs:** ChatGPT's mobile link opener may append `?utm_source=chatgpt.com`. Both Controller and the HTTPS sidecar must resolve `/ccm/download/<token>` and `/ccm/preview/<token>` by pathname and ignore query parameters rather than rejecting them with 404. The sidecar forwards only the validated pathname to the Controller; file token validation, GET-only handling, size checks, and existing cache expiry remain in force. This fixes opening CCM preview/download links; it does not by itself guarantee Markdown images render inline in every ChatGPT client.
- **Long process polling / Direct `write_stdin`:** ChatGPT long-turn testing found that repeated top-level Direct empty `write_stdin` polls can leave the Host tool-event/turn flow stalled after extended polling, while the same 40-minute workload completed normally when every empty poll used nested `ccm.write_stdin` through `exec`. Keep `write_stdin` on the Direct + Code Mode surfaces for compatibility and real interactive stdin writes, but route empty polling through `exec -> ccm.write_stdin` from the first poll. CCM now hard-rejects top-level Direct empty polls before calling the process manager or Worker, so an accidental Direct poll cannot continue the session; the same `session_id` must be retried through nested `ccm.write_stdin`. Reuse the original `(workspace_handle, session_id)`; on a Host/tool-call failure with no CCM structured result, retry that same nested route at most twice and do not fall back to Direct empty polling or create a replacement session.

CCM deliberately does not embed a second JavaScript interpreter for Code Mode. The host application remains responsible for loops, branching, and data processing. CCM's `exec/wait` pair is a bounded structured dispatcher over ToolRegistry capabilities. `state=completed` is terminal. If nested dispatch has finished but an `exec_command` leaves a live process session, CCM returns `state=awaiting_io` with `next_operation=write_stdin`; empty polling must continue through `exec -> ccm.write_stdin`. Top-level `write_stdin` remains available for real non-empty interactive stdin writes and client compatibility, but empty Direct calls are rejected without touching the session.

### ChatGPT Share conversation export

**Model routing:** For public ChatGPT Share (`https://chatgpt.com/share/...`) and Codex shared-conversation (`https://chatgpt.com/s/cx_...`) links, inspect, compare, or export the conversation with `ccm-extra.chatgpt_share_export` via `tool_search` -> `exec`. Do not substitute web search, web browsing, BMG, or browser automation to retrieve shared-conversation content; report CCM retrieval failures. This rule is provided to models in the MCP Server instructions and the deferred tool description, rather than requiring a global user instruction.

ChatGPT Share HTML is fetched directly with desktop browser-like `User-Agent`, `Accept`, and `Accept-Language` headers. A generic non-browser client receives an HTTP 200 metadata-only page, not the serialized conversation; the desktop request exposes the indexed payload for the built-in parser. Both ordinary `/share/...` links and URLs with `?ogimg=plain` work without browser automation. Codex shared-thread snapshots continue to use the JSON endpoint.

`ccm-extra.chatgpt_share_export` 使用 Deferred + Code Mode，可读取并导出公开 ChatGPT 与 Codex 共享会话，无需 BMG 或浏览器自动化。通过 `tool_search` 发现工具，再通过 `exec` 调用。

Supported features:

- `mode=text`: readable user/assistant conversation export.
- `mode=full`: preserves all message records exposed by the Share payload, including system/tool records and message metadata.
- ranch=active: follows the current Share branch when available.
- ranch=all: exports all mapping nodes for debugging or archival.
- Markdown and JSON output formats.
- `output_path` is optional. Omitted or relative paths are written under the Git-ignored `.cache/chatgpt-share-export/` directory; absolute paths are honored directly.
- Non-text messages such as image-only messages are retained rather than silently dropped.

The exporter only recovers information present in the public Share payload. Information removed upstream by ChatGPT is not recoverable.

Codex 共享兼容（2026-10-08）：接受 `https://chatgpt.com/s/cx_<32位小写十六进制>`，直接读取公开接口 `/backend-api/wham/shared_threads/<共享ID>` 的 `version=1` JSON 快照，不改写成 ChatGPT `/share/` 链接，也不依赖页面 JavaScript。`mode=text` 保留用户消息、助手进度及最终回复，纯图片用户消息以图片地址占位；`mode=full` 额外保留推理摘要、文件修改、图片查看与生成项，JSON 输出中的 `snapshot` 保留全部原始轮次、消息项、耗时、资源元数据及上游省略计数。快照是线性 `turns/items`，`branch=active` 和 `branch=all` 均按原始顺序导出。Codex 的 `total_nodes` 表示快照消息项总数；`snapshot_turns` 是快照轮次数，`user_turns` 仍表示用户消息数。未知消息项仅在 full 模式保留；不支持的快照版本或错误结构明确报错。

兼容边界：只能读取公开共享快照实际提供的数据，不能恢复上游未公开的完整推理、工具调用或被省略的文件修改，也不自动下载图片。快照接口属于查看器当前使用的接口，可能随上游版本变化；403/404/410 表示当前请求无法访问，工具会明确报错。运行环境需要 Python、有效 TLS 证书链及能访问 ChatGPT 的网络；必要时使用 `proxy` 参数或 Worker 的代理模式。该工具在 Codex 和 ChatGPT Host 中均通过 `tool_search` → `exec` 使用。

部署与验证：Controller 重启后更新工具发现说明；各 Worker 执行自己 `CCM_INSTALL_ROOT` 下的 `tools/chatgpt-share-export/export.py`，远程 Worker 需同步该脚本，单独重启 Controller 不会更新另一台机器的工具文件。本次已通过本机 `DESKTOP-KFL6V1F` 的 CCM 实际调用验证，共享快照的 8 个轮次、41 个消息项成功完整导出，且逐项顺序及原始数据一致。

### Bundled specialized capabilities

CCM ships optional specialized workflows. `ccm-extra.publish` is exposed Direct + Code Mode for user-facing artifact delivery; other specialized workflows are mostly Deferred + Code Mode through `tool_search` and `exec`.

- `ccm-extra.publish` publishes one Controller Plan (`{plan_id}`) or Worker file (`{workspace_handle, path}`) at a time. The modes are mutually exclusive: a Plan never requires a Worker connection or local intermediate file. Each call returns `structuredContent.download_url` for an immutable snapshot; a later Plan change requires a new publication. For Markdown (including Plans), `preview_kind: markdown`, `preview_url`, and a bounded `markdown_preview`/`markdown_truncated` render the card and full isolated HTML page while `download_url` retains the original `.md`. Other verified UTF-8 text has `text_url`, `text_preview` (up to 8 KiB) and `text_truncated`; raster images, PDF, audio, video and isolated markup have their own `preview_kind` and `preview_url`. Every file has a download link. Non-Markdown full text returns plain text; Markdown/HTML/SVG previews run under a restrictive CSP. There is no Office conversion or extra preview call. Host bridge links use `window.openai.openExternal`, with `ui/open-link` fallback. Keep the HTTPS download URL available when the client cannot open a card link. Published links expire within 72 hours (potentially sooner if the 1 GiB cache fills), and possession of the link grants access. `view_image` remains model-side only. No ChatGPT Library storage is involved.
- `ccm-extra.import_chatgpt_file` is Deferred + Code Mode. Bind one conversation attachment through top-level `exec.file` and invoke the nested import. For Library files first materialize an authorized `raw_file`. The selected Worker streams the ChatGPT temporary HTTPS URL into a relative destination inside the context, with opt-in overwrite. Multiple file imports must be sequential.
- `ccm-extra.transfer_path` is Deferred + Code Mode for copying a regular file or a recursive directory between two existing CCM workspace handles. Supply `source_handle`, `source_path`, `target_handle`, and `target_path`. The source can be any path readable by its Worker (including an absolute path); the target must be relative to its own selected workspace. It never replaces an existing destination (even an empty directory), never deletes source data, and preserves empty directories. Existing destination collisions are rejected before file bytes are transferred. The destination is reserved first and may be visible/incomplete during transfer. Symbolic links/junctions and workspace escapes are refused.
- `ccm-extra.transfer_status({transfer_id})` reports file/byte progress and terminal state; `ccm-extra.transfer_cancel({transfer_id})` requests cancellation and safe cleanup. Transfers run in a Controller-owned task independent of the 15-minute Code Mode result lifetime; terminal status is retained for up to 24 hours. On a failure, cancellation, or restart, cleanup removes only objects that can still be proven to belong to this transfer; unsafe or externally modified leftovers are preserved and reported. Initial version does not resume interrupted copies.
- File contents take the Worker A → Controller/WorkerHub → Worker B route as bounded, ordered 4 MiB Base64 chunks over the existing JSON-RPC WorkerHub connection (24 MiB message ceiling). Each chunk is acknowledged before the next, with socket backpressure, bounded task concurrency, source change checks, and full-file SHA-256 verification. File contents are neither exposed in ChatGPT tool results nor placed into the Controller's public download cache. WorkerHub's underlying TCP protocol is not itself TLS; remote link encryption depends on the deployment (for example Tailscale/WireGuard). No extra HTTP listener, certificate, port forwarding, or Tailscale-specific address is required by this tool. Both Workers must be connected to the same Controller.
- `ccm-extra.quark_upload` is Deferred + Code Mode, submits one or more files through that local Quark desktop session, and can wait for verified completion.
- `ccm-extra.bilibili_download_dash` uses BMGCTL in the logged-in Bilibili browser on 6v to select real account-authorized DASH representations, then a one-shot localhost `tools/bilibili-download/bridge.py` to hand signed URLs and selected video height into an ignored local file. BMGCTL redacts signed URLs in tool results: do not pass these through the model. The browser currently rejects loopback CORS requests: POST a JSON body using `mode: 'no-cors'` and `Content-Type: text/plain`, then **require `BRIDGE_RECEIVED`** from the local Bridge (an opaque browser response cannot confirm success). Invoke the deferred tool with **required `browser_tab_id`** from `get_windows_and_tabs` and `output_path` as a filename (e.g. `video.mp4`, not an absolute path), plus optional timeout. **Before downloading**, `pause_video.py` verifies the exact Bilibili tab and automatically pauses/acknowledges its video elements via BMGCTL; missing tab, browser outage, or unverifiable pause **fails closed before transfer**, and the one-shot handoff is deleted. BMGCTL subprocess output must be decoded as UTF-8 on Windows. The 6v projectless Worker writes the MP4 inside the returned `workspace_root`; use the returned `workspace_handle` to access or publish it subject to the Controller file-size limit. Python downloads with curl.exe, remuxes via `ffmpeg -c copy`, checks resolution and audio with ffprobe. Verified a 1920x1080 HEVC + AAC MP4 with automatic pause in a real logged-in 6v browser on 2026-11-05. See `tools/bilibili-download/README.md`.

Discover Deferred tools through `tool_search` and invoke through `exec`. `publish` is directly visible and can also be called through `exec`. `import_chatgpt_file` uses exactly one top-level `exec.file` binding per nested import. Continue live process sessions via `exec -> ccm.write_stdin`.

The Quark helper reuses only the login state of the local Quark desktop client and does not export account credentials. Bilibili downloading requires the logged-in BMGCTL browser and its localhost Bridge on 6v; if either is unavailable, stop rather than falling back to anonymous-quality extraction. An existing 6v projectless handle may be reused across BMGCTL, Bridge (`--projectless-handoff`) and the download tool (`workspace_handle`), keeping the signed-URL handoff in that projectless root. The original shared Bridge mode remains available when no handle is provided. Neither Bilibili cookies nor short-lived signed media URLs appear in CCM tool arguments or results. Video quality remains limited by the account's permissions and available streams. The Python downloader uses files in an existing writable directory, avoiding observed Windows restricted-token PowerShell script and private temporary-directory ACL failures.



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

### Upstream Codex Elevated Sandbox alignment (staging only)

The merged sandbox implementation records the **entire** reviewed upstream
`openai/codex` source tree as a Git submodule at commit
`f79b26ccbb3116b052544666a181012fb45dc49b`
(`rust-v0.166.0-alpha.5.1`). This is a **source-audit baseline, not a required
Codex CLI runtime version**. See
`docs/codex-upstream-windows-parity.md` for the exact native source,
configuration decision chain, host findings, and required acceptance matrix.
The Codex-schema `config/codex/config.toml` is a *non-secret staged
configuration*: the trusted runtime helper copies its exact bytes to
`%LOCALAPPDATA%\\CCM\\CodexSandbox\\config.toml`, without modifying the
interactive user's `%USERPROFILE%\\.codex\\config.toml`. This native config
is exercised by the isolated execution tests; it is not yet the production
Worker default.

**Not deployed:** CCM still uses its existing Windows native sandbox and approval
logic. Neither Worker has been switched to the upstream Codex runtime. Until
the entire decision chain is integrated and tested, do not call the CCM sandbox
Codex-equivalent or assume experimental `run_as_admin` is safe.

The native Codex CLI adapter has unit tests and opt-in privileged Windows
integration tests. Its merged implementation is covered by the CCM Node test
suite; real host-level sandbox testing is tracked separately. On 6v,
an existing NTFS hardlink from the selected writable root to a disposable
outside file caused Codex ACL setup to grant its sandbox account write rights
to the outside file. **The owner explicitly accepts this upstream limitation**:
the purpose is to prevent accidental modifications of important files, not to
enforce a malicious-actor-proof or absolute outside-workspace security boundary.
Do not fork Codex to patch hardlinks or claim guaranteed confinement.
Continue testing ordinary outside-file write denial and functional compatibility
before enabling the new backend. CCM no longer pins the installed Codex CLI
to a particular release: it chooses the newest complete installation with
the native command runner and sandbox setup helper in the same directory.
Different CLI versions are allowed on different Workers; incompatible command
or config behavior must be fixed and verified rather than dismissed solely
because of a version number. Host-level probes used disposable files and left
running Workers unchanged.

The 6v trusted-host `ProcessManager → NativeEnvironmentExecutor → codex sandbox`
integration test **passed**, including the staged
`createWorkerRuntime({codexSandbox:true})` selection and dedicated Codex home.
The selection checks the installed CLI and its two adjacent native helpers, then
provisions the native config before accepting commands. It captured the normal
exit code and `CodexSandboxOnline` identity, permitted an inside write, and
denied an accidental outside write. The first run provisioned native sandbox
users, ACLs and offline networking and may take noticeably longer; reusing the
same dedicated home avoids re-creating its initial configuration. Permanent
native tests are `test/codex-elevated-execution.test.mjs` and
`test/codex-elevated-containment.test.mjs` (both opt-in on trusted Windows).
Neither test requires patching upstream Codex.
The actual Worker Agent has not selected this staged backend yet: the
interactive/TTY, cancellation and cross-machine functional gates remain open.
The opt-in native PTY integration suite is `test/codex-elevated-terminal.test.mjs`
(trusted elevated Windows host only, `CCM_RUN_CODEX_ELEVATED_TERMINAL=1`).
It covers repeated stdin, incremental output, Ctrl+C and cancellation of the
full process tree. Ordinary runs deliberately skip these three privileged
cases; mock transport tests verify argv and stdin forwarding but do not
replace native acceptance. See `docs/codex-upstream-windows-parity.md` for
the remaining two-machine acceptance requirements.
At the 2026-11-06 staging checkpoint, the 6v full Node suite completed
using `node --test --test-isolation=none` with **340 passed, 0 failed,
5 intentionally skipped**. Plain `npm test` could not spawn isolated test
files inside that Worker's current sandbox (`spawn EPERM`).

### User-command environment refresh

CCM keeps Supervisor, Controller, and Worker runtime environments stable. On Windows,
each new user command reads the current Machine and User environment registry keys,
merges their variables (User overrides Machine), and constructs PATH in the Windows
order (Machine entries followed by User entries). The command-only environment is
applied consistently to pipe, PTY, restricted-sandbox, and approved execution. This
lets commands discover newly installed tools and DLL directories without restarting
the Supervisor or Worker. Existing running commands are unaffected.

Worker-specific `CCM_*` settings remain owned by the Worker and cannot be overwritten
by registry values. Existing command proxy-mode selection and the validated
`CURL_CA_BUNDLE` override from `config/worker.env` are applied afterward. Other
platforms continue using the Worker's inherited environment. The Windows registry
must be readable when starting a new command; errors are reported rather than
silently executing with an outdated environment.

CCM includes public Task Scheduler helpers for both Controller hosts and standalone Remote Workers. They run hidden under the current Windows user, start at logon, use `IgnoreNew` to avoid duplicate instances, and configure Task Scheduler restart-on-failure behavior. Each supervisor also restarts its own child process if that child exits unexpectedly. Both installers register their tasks with `RunLevel Highest` (elevated administrator token for an administrator account). Run the installers once from an **elevated PowerShell** to create or update the existing tasks; changing the installer source does not update an already registered task or elevate an already running Supervisor. Restart the task through Task Scheduler after updating it. Normal `ccm.restart` only restarts Supervisor-owned child processes and preserves the existing Supervisor token; it does not perform UAC elevation.

Keep `CCM_PERMISSION_PROFILE=workspace-write` when using an elevated Supervisor to retain the normal restricted-token execution path. The Controller host's task elevates the Controller, local Worker, and OAuth sidecar together; the standalone Remote Worker task elevates its Worker. A successfully elevated parent is not itself proof that the Windows restricted sandbox still denies writes outside the selected workspace: validate the boundary on the actual host before relying on it. Approved/escalated and separately trusted full-access commands inherit the Worker's administrator token.

**Experimental per-command administrator restriction:** On a Windows Worker launched with an elevated administrator token and `CCM_PERMISSION_PROFILE=workspace-write`, `exec_command` accepts `run_as_admin: true` to construct an `admin-workspace-write` restricted token without a CCM approval card. Omitting the parameter uses the unchanged default sandbox. This is an invocation option, not a Worker permission profile or a per-conversation grant: other calls or conversations can also request it if they have tool access. It cannot be combined with `sandbox_permissions=require_escalated`, `prefix_rule`, or `full_access_grant_id`, and does not apply to `apply_patch`. The native helper retains the Administrators SID, applies the original workspace write-restricting SIDs, and drops selected filesystem-bypass privileges (backup, restore, take ownership, security and manage-volume). Other administrator capabilities can bypass access checks or fail on service/process objects; do not treat this experiment as a robust boundary without host-specific tests. Tested separately from ordinary Full Access approvals.

6v experimental findings (2026-11-05): the helper retained the Administrators SID and `SeDebugPrivilege`, allowed a file write in the workspace, and denied overwriting a test file under a separate temporary directory. A non-mutating `OpenSCManager(SC_MANAGER_CREATE_SERVICE)` probe succeeded with the unrestricted parent token but returned no handle (Win32 error 2) under the experimental token. Therefore administrator group membership does **not** establish usable service administration for this profile; do not use it in place of Full Access for service control or claim general isolation from privileged Windows bypasses. The helper explicitly refuses this mode if its parent Worker does not have an enabled administrator role.

**Full-privilege follow-up (2026-11-05):** Temporarily retaining all administrator privileges in the experimental token did **not** preserve the outside-workspace write boundary. Ordinary `Set-Content` and `icacls /grant` against a standalone temporary file outside the workspace were denied, but a Win32 test program enabled `SeRestorePrivilege`, opened the same file with `FILE_FLAG_BACKUP_SEMANTICS`, and successfully overwrote it. `OpenSCManager(SC_MANAGER_CREATE_SERVICE)` was still denied by the restricting SID, while even an in-workspace `icacls /grant` failed because the capability SID currently lacks `WRITE_DAC`. The test changed only temporary test files. This full-privilege variant was rolled back and the 6v native helper rebuilt; the original privilege-limited experimental mode remains. `WRITE_RESTRICTED` alone cannot guarantee both unrestricted administrator actions and strict outside-workspace write confinement. Achieving that combination requires enforcement independent of the administrator token, not merely changing CreateRestrictedToken flags.

At Windows Worker startup, `ccm-worker-token-owner.exe` sets the Worker's **default file owner** (`TokenOwner`) to the actual user SID from its Windows token, instead of the Administrators group that an elevated token can use as its default owner. This leaves the Worker elevated and keeps the restricted-token sandbox unchanged, but newly created folders and child-process Git clones normally belong to the signed-in user (avoiding Git `dubious ownership` on later restricted commands). The helper only changes the immediate parent Worker's token and verifies the same token user; no Windows username or SID is hardcoded. Both launchers build this native helper with `npm run build:native` before Worker startup; when deploying only a Worker restart, build it on each updated host **before** requesting `ccm.restart`. A missing or failing helper stops that Worker from starting, rather than silently recreating Administrators-owned project folders. Existing folder owners are not modified; repair those separately if needed. This change does not fix Git Bash/MSYS `sh.exe` signal-pipe failures inside the Windows restricted sandbox; a Git invocation matched by `config/trusted-commands.json` uses the Controller-authorized unsandboxed route.

For an assistant-operated restart use the Deferred `ccm.restart` capability rather than `exec_command`/`taskkill` or any command-prefix authorization. Its input is restricted to `{ "component": "controller_service_group" | "worker", "environment_id": "<registered id>" }`. The Controller checks `config/restart-allowlist.json` on **every request**, requiring exact environment IDs in `controller_service_groups` or `workers` (no wildcard). The Controller group may only target the locally supervised Controller identity; a Worker request may only target an actively connected, healthy registered Worker. Neither action accepts an executable, shell, script, PID, path, nor arbitrary arguments; no `exec_command` or approval-policy permissions are created. Add new Worker identities by updating the allowlist, without changing code or restarting the Controller. Invalid/missing configuration fails closed.

The dedicated restart RPC makes the supervised target exit after acknowledging the request. `ccm-supervisor.ps1` restarts the Controller, local Worker and OAuth sidecar as a group; `ccm-worker-supervisor.ps1` or `LocalWorkerSupervisor` restores an individual Worker. Controller service-group restart checks the existing Supervisor-owned gateway parent PID; remote-Worker restart checks the Supervisor-owned Worker PID; the local Worker uses its Supervisor launch marker. Processes without verified supervision reject restart. An accepted response means **requested, not recovered**: after the relevant reconnect, independently verify Controller health, Worker normal state, and OAuth sidecar health. The Controller connection will be interrupted when restarting its service group. The installer scripts manage startup, not routine restart; do not alter Task Scheduler configuration just to issue a restart.

主动重启现已增加停止期限：Worker 在停止清理完成后明确退出，清理超过 10 秒则以失败状态退出，避免残留句柄使旧进程永久存活。本地 Supervisor 只在白名单重启请求成功受理后设置 15 秒停止期限；届时只终止其仍拥有的旧子进程，收到退出事件后才启动替代进程。普通网络断线仍由 Worker 自行重连，不触发此强制终止。远端 Worker 同样使用上述 10 秒退出兜底，其现有 Supervisor 负责重新启动。

`ccm.restart` 的 Worker 请求返回 `operation_id`，通过只读 `ccm.restart_status({operation_id})` 查询 `requested`、`reconnecting`、`recovered` 或 `failed`。仅观察到目标断开后重新注册健康连接才标为恢复；60 秒未恢复则记录失败。重复的进行中请求返回同一操作，不再次发送重启。Controller 内存最多保存 128 条操作，优先淘汰终态；Controller 重启后记录失效，未知记录不能当作成功。服务组重启仍需独立检查 Controller、OAuth 和各 Worker 健康。旧版本本地 Supervisor 只等待进程退出，无法自行恢复停止后仍存活的 Worker；遇到旧版本这一情况，使用专用 `ccm.restart` 的 `controller_service_group` 路由恢复，随后升级。

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

仅在 Controller `/ccm/health`、OAuth 网关 `/health`、本地 MCP 调用及 Worker 状态均正常，但 Host 调用 CCM 持续报连接失败或 `-32603 Internal error`，且 OAuth 网关没有对应请求日志时，可尝试在 CCM 入口所在的 Windows 机器上以管理员身份打开 PowerShell，执行 `Restart-Service -Name Tailscale` 重启 Tailscale 系统服务；仅退出并重开任务栏程序不足以重启该服务，恢复以真实 Host 工具调用成功且网关出现对应成功请求日志为准。

### ChatGPT Direct-tool refresh

ChatGPT-side CCM plugin/connector settings are **user-operated**. The assistant must not rename, delete, recreate, reconnect, or otherwise rebuild the ChatGPT CCM registration on the user's behalf unless the user explicitly authorizes that action. Tool refreshing does not require deleting the published personal plugin or the connector.

Changes to a Direct tool's model-visible definition include not only parameter/input/output schema changes but also its `description` text. ChatGPT may cache the full definition across conversations. Simply opening a new conversation or reconnecting the account does not necessarily refresh it.

For changes to Direct tool definitions, use this verified workflow:

1. Finish the CCM code update, restart the appropriate CCM service group, and verify the Controller is healthy and serving the new Direct tool definition.
2. In ChatGPT **Settings → Plugins → CCM**, use **Refresh tools (刷新工具)**. This updates the available Direct tool list without reconnecting, deleting, or rebuilding the connector; the 2026-10-17 test successfully revealed a previously missing Direct tool after reconnect alone had not.
3. Check the current conversation's loaded Direct tools, and start a new conversation if necessary. Do not declare success based solely on the server's `tools/list` or the refresh-button click.

The previous handle/URL-printing PowerShell command and BMG-based connector rebuild utility were retired because they are unnecessary for routine Direct schema updates. Do not print or transfer the OAuth approval secret to refresh tools. Initial connector installation/OAuth setup is a **different** operation and still uses the protected configuration and consent flow described above.

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
| `CCM_WORKSPACE_HANDLE_FILE` | `<install>/.state/workspace-handles.json` for the packaged Controller | Persistent Controller workspace-handle registry. |
| `CCM_CONTROLLER_STATE_DIR` | Windows: `%LOCALAPPDATA%\CCM`; XDG: `$XDG_STATE_HOME/ccm`; fallback: `~/.ccm` | Protected Controller security state, including execution policies and trusted package-script rules. Keep this outside workspace-write roots. |
| `CCM_APPROVAL_TTL_MS` | 259200000 ms (3 days) | Lifetime of pending execution and workspace approvals before they expire. Invalid or non-positive values fall back to the default. |
| `CCM_PROCESS_RESULT_TTL_MS` | 600000 ms (10 minutes) | Worker retention window for the unread final result of a yielded process after it exits. Expired completed records are removed automatically and do not count toward the 64 live-process limit. Invalid or non-positive values fall back to the default. This does not terminate live processes. |
| `CCM_PERMISSION_PROFILE` | `workspace-write` | `read-only`, `workspace-write`, or `full-access`. `full-access` uses normal Worker host permissions and skips CCM user-approval prompts for workspace lifecycle and execution actions. |
| `CCM_PROXY` | unset | Optional explicit HTTP(S) proxy URL used in child-process `proxy` mode before standard proxy environment variables or the enabled Windows user proxy. |
| `CCM_MAX_MCP_TOOL_RESULT_BYTES` | 2 MiB | Serialized MCP tool-result limit for ordinary results. |
| `CCM_MAX_MCP_FILE_RESULT_BYTES` | 24 MiB | Serialized MCP result limit when returning an embedded file resource. |
| `CCM_MAX_VIEW_IMAGE_BYTES` | 1 MiB | Maximum encoded image size returned by `view_image`. Oversized images are automatically compressed on the Worker. |
| `CCM_MAX_SEND_FILE_BYTES` | 12 MiB | Maximum original resource size published by `ccm-extra.publish`. |
| `CCM_MAX_RECEIVE_FILE_BYTES` | 512 MiB | Maximum raw file size accepted by `ccm-extra.import_chatgpt_file`. |
| Download link TTL | 72 hours (fixed) | Links expire from creation time; retries do not extend lifetime. |
| `CCM_FILE_TRANSFER_CACHE_BYTES` | 1 GiB | Maximum on-disk file body bytes in the Controller HTTPS download cache; oldest files are evicted first. |
| `CCM_WORKER_RECONNECT_MS` | 1000 ms | Worker reconnect delay. |

### Worker child-process CA configuration

Use each machine's Git-ignored `config/worker.env` for Worker bootstrap settings (`CCM_*`) and the optional local child-process `CURL_CA_BUNDLE=<absolute path to an existing CA bundle>`. The Worker supervisor loads `CCM_*` at startup; the native executor reads the optional CA bundle on new pipe/PTY commands. That value feeds the environment **before** Codex `shell_environment_policy` is applied, so `inherit`, `exclude`, `include_only` or `set` can remove or supersede it. This legacy CCM configuration remains a recorded upstream mismatch, not a substitute for Codex `shell_environment_policy.set`. Controller/WorkerHub/OAuth secrets are not sourced from the file. Invalid entries or missing CA files fail the new command.

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

`read-only` and `workspace-write` command execution use the CCM Windows native sandbox helper. The public environment/project-discovery surface intentionally does not expose internal bootstrap directories, raw permission profiles, or filesystem permission topology, but `list_projects` exposes two independent coarse fields for each connected environment derived from the current effective profile: `sandbox_read_scope` and `sandbox_write_scope`. In the current Windows restricted sandbox, `read-only` reports `host` / `none`, `workspace-write` reports `host` / `context_root`, and `full-access` reports `host` / `host`. `context_root` means the active registered-workspace or projectless root. A `workspace_handle` selects the Worker, cwd/session ownership, and that context root. Filesystem read scope is determined independently by `sandbox_read_scope`; ordinary write scope is determined by `sandbox_write_scope`. A readable path does not need to become the selected workspace merely because it is outside the current context root. Individual direct file tools may impose narrower path contracts than `exec_command`. PTY sessions use a Rust ConPTY backend aligned with the useful parts of Codex's current Windows PTY implementation. `full-access` runs with the Worker's normal host permissions and does not create CCM user-approval requests for workspace selection/registration or execution escalation. Workspace identity, context routing, cwd/session ownership, and individual tool path contracts remain enforced.

Restricted command execution on Linux/macOS is not implemented yet and **fails closed** rather than silently running unsandboxed. A Linux/macOS Worker therefore currently needs `CCM_PERMISSION_PROFILE=full-access` for shell execution.

`apply_patch` enforces its own workspace-write boundary on the Worker, including real-path checks that reject symlink/junction escapes. Ordinary `exec_command` remains inside the selected environment's normal sandbox except for built-in command rules in `config/trusted-commands.json`, Controller-managed trusted package scripts, or saved prefix policies. The Controller reads and validates the built-in file **on every new exec request**, including calls routed to remote Workers. Adding or removing built-in rules in the Controller's working tree takes effect on the next request without restarting CCM. The model may edit this file directly. Missing or invalid configuration disables built-in trust for the request, returns a configuration diagnostic and leaves the normal sandbox/approval route available.

Matched command rules grant **unsandboxed execution**, not merely network/filesystem exceptions. Git hooks/helpers/configured transports and test modules run with the Worker's normal host permissions, not within its workspace-write sandbox.

The initial configuration trusts Windows Git `clone`, `fetch`, `pull`, `push`, and `ls-remote`, direct PowerShell/pwsh `node --test`, `npm run build:native` and the Tailscale CLI. The npm native-build rule permits the named script (and suffix arguments) for Windows workspace-write Workers; it does **not** grant blanket trust to unrelated npm scripts or `npm install`. Its versioned rules declare `id`, `platform`, `permission_profile`, `shells`, `executables`, an argument matcher (`any`, `subcommand` values, or token `prefix`), and an execution target (`original` or a pinned Windows executable path). Duplicate rule IDs, unsupported schema fields and malformed rules invalidate the entire built-in snapshot. Adding supported executables or subcommands is configuration-only; adding new matcher types requires code changes.

The Controller uses the upstream native Codex PowerShell literal parser for saved-prefix matching, while the existing CMD parser and source-bound built-in matcher have separate limitations. Every lowered command segment must match a saved Allow rule to bypass the sandbox, including pipelines. For built-in trusted commands (Git/Node/Tailscale), rewriting pinned targets requires an independently verified literal source span: safe sequential segments may mix, but pipelines, redirection, untrusted segments and unrecognized or ambiguous source forms revert to the ordinary sandbox/approval path. The Codex parser rejects PowerShell call operators such as `& 'C:\\Program Files\\Tailscale\\tailscale.exe'` for automatic command lowering; use a supported simple literal alias such as `tailscale.exe status` for the configured pinned Tailscale rule. Workers do not independently auto-trust Git or any other built-in command.

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

Only structurally simple package-script commands qualify for this separate hash-bound trust mechanism. CCM preserves the `npm test` shorthand and accepts explicit `npm run <script>`, `pnpm run <script>`, and `yarn run <script>` forms. Bare package-manager operations such as `npm install`, `npm ci`, and `yarn add` are not misclassified as package scripts. Shell chaining, pipes/redirection, and extra script arguments do not enter this hash-bound class. These rules are managed explicitly through the Controller-host CLI above. The execution approval card's **Always allow** saves a global command-prefix rule instead, even when the approved command happens to invoke a package script.

### Sandbox escalation and global Allow rules

The approval flow below applies to restricted permission profiles. Restricted Workers support an explicit one-shot escalation flow through `exec_command(sandbox_permissions=require_escalated)`. The model supplies the exact command, `workspace_handle`, optional working directory/shell/TTY settings, output/yield settings, user-facing justification, and optionally a reusable ordered-token `prefix_rule`. If no built-in, trusted package script, or saved global Allow rule matches, CCM parses the command conservatively, validates/freezes the proposed persistent prefix, freezes the exact execution into a `PendingAction`, assigns an `approval_id` and `operation_id`, and returns without executing the command. The model then calls the Direct-only `request_approval` tool with only that opaque `approval_id`; `request_approval` binds the pending action to the approval card but cannot change the frozen command, prefix or execution context. A `full-access` environment executes the requested command directly under normal Worker host permissions and does not create an execution approval.

The approval card receives a high-entropy approval capability only through tool-result `_meta`; that secret is not placed in `content` or `structuredContent`. For execution approvals the card displays the frozen workspace/environment/command/justification. **Always allow** is shown only when the Controller has frozen a valid persistable command prefix, and the card explicitly indicates its global scope across Workers and workspaces. **Approve once** and **Deny** remain available independently. For workspace entry/registration the card displays the frozen environment/workspace/root/action and offers only **Approve** or **Deny**. The app-only `resolve_pending_action` resolver accepts only `approval_id`, the card capability, and the user's decision; it does not accept a replacement command, prefix, workspace target, workdir, shell, or TTY value.

On Approve, CCM resumes the already-frozen action directly. There is no second model decision and no model-generated retry of the command. The grant:

- is valid for the configured approval lifetime (3 days by default),
- is atomically dispatchable only while the frozen approval is in an allowed state,
- is bound to the environment, workspace handle/root, command, working directory, shell, TTY mode, and execution output/yield settings,
- runs that one command with `full-access`,
- cannot be reused after execution.

After a terminal approve or deny result, the approval App separately hands that result back to the conversation. It first writes the bounded final result into model context, then triggers exactly one follow-up turn. Standard MCP Apps `ui/message` is preferred when the initialized Host advertises text-message support; the ChatGPT `sendFollowUpMessage` compatibility alias is only a fallback for missing or explicitly failed standard messaging. A successful standard message response is treated as authoritative and is never followed by the alias, preventing duplicate turns. If context handoff or both continuation routes fail, the server-side approval result remains final and the card reports that the user must send a message to continue; CCM never reruns the frozen action merely to recover conversation continuation.

**Always allow** executes the current frozen action through the same approval state machine, then saves a global ordered-token command-prefix Allow rule in the Controller's `exec-allowlist.json` (schema version 3). The saved rule has no environment, Worker, workspace, workdir, Shell or TTY binding. On later ordinary `exec_command` calls, the Controller matches the saved rule before the first execution and dispatches matching commands with Full Access; the model does not need `require_escalated`. The explicit escalation path also recognizes these saved rules. The one-shot approval action itself remains frozen to its original Worker, workspace, command and settings.

Controller model instructions and the `exec_command` description encourage a reusable `prefix_rule` whenever a repeated build, test, or development command genuinely needs escalation. A useful prefix keeps stable executable/subcommand/script path/invariant options and leaves varying suffix arguments outside the prefix: e.g. `npm run build:native` proposes `["npm","run","build:native"]`. The model must not offer a bare general-purpose interpreter such as `powershell`, `cmd`, `pwsh`, or `node` as a persistent prefix. A `prefix_rule` is valid only with `require_escalated`; the user sees the exact proposed global prefix before choosing **Always allow**.

Prefix matching is token-based, not raw-string `startsWith`. A rule such as `["git","config","--get"]` matches `git config --get user.name` but not `git config --global --get user.name`. Additional suffix tokens after a matching prefix are intentionally authorized. Compound shell commands are segmented conservatively and the whole shell is automatically elevated only when every executable segment is independently trusted/allowed; unsupported or ambiguous shell syntax falls back to the normal sandbox/approval path.

The initial Tailscale rule pins the executable to `C:\Program Files\Tailscale\tailscale.exe`. The Controller recognizes the simple `tailscale` alias or literal installed path and rewrites each trusted invocation to the configured absolute executable. Thus `tailscale status; tailscale funnel status` or a mixed Git/Tailscale PowerShell command can use the built-in trust without manually splitting requests. Single-command CMD Tailscale calls still dispatch through PowerShell to preserve quoting for paths with spaces. **Compound CMD scripts requiring pinned-path rewriting** remain restricted until semantically equivalent execution can be guaranteed. Other supported CMD combinations preserve their original Shell. Tailscale rule arguments cover all CLI subcommands, including configuration changes; untrusted shell commands are not granted access.

For WSL this can intentionally be broad. A user-approved `["wsl.exe"]` prefix automatically authorizes subsequent WSL invocations in any workspace on any Worker, with arbitrary suffix arguments, including Linux-side writes, package management, networking, services, or root commands reachable through WSL. A narrower `["wsl.exe","-d","PhD-CFD"]` prefix restricts matching to that distro selector. The Linux command inside `bash -lc '...'` is opaque suffix data to the outer Windows prefix matcher.

The independent trusted-package-script store remains hash-bound to an exact workspace/script, using the current `package.json` script SHA-256. This separate mechanism does not change the scope of user-saved global command Allow rules.

Saved global Allow prefixes are checked for ordinary `use_default` commands as well as explicit escalation requests. Once a rule is saved, matching WSL or build invocations therefore run with Full Access on their first attempt, without a preliminary sandboxed failure.

If CCM can prove a failure occurred before Worker dispatch, the same frozen action may be presented for retry with the same frozen prefix scope. If a timeout/disconnect makes it uncertain whether the Worker started the command, the approval enters `execution_unknown`; CCM will not retry automatically and saves no policy. If execution succeeds/starts but persisting **Always allow** fails afterward, the action remains consumed: CCM reports the policy-save failure and does not rerun the command merely to retry persistence. Denied, consumed, unknown-outcome, and expired requests cannot start another execution.

For restricted profiles, workspace entry/registration uses the same card capability and one-shot state model, but it never grants `full-access` and never creates an execution allow rule. On approval CCM re-reads the registered workspace or re-inspects the registration path, verifies that the frozen environment/workspace/root still match, then creates the registered `workspace_handle`. If the target has drifted, the frozen action fails closed and is consumed so a new approval is required. A pending workspace action blocks only continuation that depends on that same current intended target: after calling `request_approval`, the model waits rather than continuing that project through a projectless workspace or retrying the same target. If the user explicitly corrects or changes the intended project, the old approval becomes superseded orchestration state but remains an independent valid pending action until resolved or expired; the model may request entry/registration for the new project only when explicitly authorized by the user and no usable handle exists, without requiring the user to Deny the old card. Multiple workspace approvals can therefore coexist with distinct `approval_id` values, and approving an older card creates only that older target's own `workspace_handle`; it does not change which project the model should treat as current. In a `full-access` environment, `select_workspace` and `register_workspace` perform the same identity/path revalidation and context creation directly without creating an approval request.

There is no model-driven approval retry path and no public text-decision approval endpoint. When an action requires approval, CCM freezes that action and returns an opaque `approval_id`; `request_approval` renders the card, and the app-only `resolve_pending_action` consumes the frozen action after the user's decision. Full-access workspace selection/registration and execution do not enter this approval state machine, but deregistration always does.

This approval mechanism controls CCM's sandbox boundary; it does **not** grant Windows Administrator/UAC privileges. The approval app is the interaction mechanism, while the server-side frozen action, approval capability, state machine, and workspace revalidation remain the security boundary. If ChatGPT supplies its anonymous `openai/session` metadata on both calls, CCM also binds the request and app resolver to that host session as defense in depth.

When an untrusted, restricted Tailscale command reports local-service pipe denial (`failed to connect to local tailscaled ... Access is denied`), CCM points to `config/trusted-commands.json` and the requirement that every command segment match a rule. This diagnostic appears in both initial results and `write_stdin` polls, even if a compound script exits with code 0. Success, DNS health warnings, unrelated errors and escalated calls do not receive it.

## Output and transport protection

CCM treats oversized output as a reliability and context-safety problem.

The OAuth/public sidecar also isolates MCP request identity. Downstream clients that initialize separate MCP sessions receive separate upstream sessions, and downstream POST calls that omit `Mcp-Session-Id` use request-scoped transient upstream sessions instead of sharing one persistent request-id namespace. This prevents concurrent clients that reuse the same JSON-RPC id (for example `id=0`) from overwriting each other's upstream response routing.

Command capture is bounded, model-facing command output has a token budget, live process reads are incremental, Worker protocol messages have a hard serialized-size ceiling, and final MCP tool results have an absolute byte limit. `view_image` reads local PNG/JPEG/GIF/WebP still images up to 64 MiB and 64 megapixels. Images exceeding the configured 1 MiB output budget are recompressed on the Worker as full-resolution WebP at quality 95, 90, or 85; only if the full-resolution result still exceeds the budget does the Worker progressively scale down dimensions (85% per step, WebP quality 90/85) until it fits. This preserves transparency and prioritizes detail. Files already within the byte budget are returned unchanged, regardless of their dimensions. The source file is never modified; for animated images the compressed preview represents the first frame.

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
creating a widget card for every image. Result `_meta` includes whether the
image was compressed and its original dimensions and byte length.

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
