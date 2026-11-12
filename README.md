# CCM — Codex-Compatible MCP

CCM is an MCP execution harness targeting source-level behavioral parity with upstream Codex outside GPT Host integration. It provides persistent process sessions, Remote Workers, native sandboxing, bounded tool output, patching, and image reads. Full parity has not yet been verified.

CCM does **not** reproduce the Codex *main-agent* model loop or own the host application's conversation history. The MCP client remains the main orchestrator; CCM owns tool execution and an optional separate Guardian reviewer loop.

Before modifying this repository, read and follow [AGENTS.md](AGENTS.md) for repository-specific agent instructions.

## Codex upstream conformance

OpenAI Codex is the normative upstream for every CCM behavior except the ChatGPT/GPT Host integration layer (MCP transport, OAuth, host-specific cards and UI). The architecture rule in `AGENTS.md` requires an exact upstream commit and source-level behavior mapping **before** changing execution, approval, rules, sandboxing, environment, configuration or tool semantics. CCM-specific transport between Controller and Workers may adapt implementation language and process boundaries, but may not silently change upstream behavior. Any unsupported behavior or intentional departure requires the user's prior decision.

**Audit baseline (2026-11-05):** `openai/codex` commit `ed8eac40832e6a79f30eaeb3c521912f231d43eb`. Relevant upstream entry points verified at this revision include `codex-rs/execpolicy/src/{parser,rule,policy,decision,execpolicycheck}.rs`, `codex-rs/shell-command/src/{powershell,parse_command}.rs`, `codex-rs/core/src/{exec_policy,exec_env}.rs`, and `codex-rs/protocol/src/{approvals,shell_environment,sandbox}.rs`. For future work, pin and inspect the actual upstream revision used rather than assuming this baseline is still current.

**Alignment is not complete.** CCM uses the upstream Rust Starlark policy engine for rule decisions and persistence, with a separate conservative CMD command tokenizer and an explicitly approved PowerShell literal-wrapper extension. The Controller still provides its GPT Host approval flow and Worker routing, while the native Windows sandbox, proxy, CA and registry-environment refresh mechanisms require further upstream comparison. The documented policy integration does not establish parity for the entire Codex execution loop or configuration layering.

The continuing source-to-implementation audit matrix, evidence and remaining gates live in [docs/codex-parity.md](docs/codex-parity.md). Keep it current whenever a Codex-derived behavior is modified.

### Native upstream Codex execution-policy engine

The complete Rust engine in `codex-rs/execpolicy/src` at upstream commit `ed8eac40832e6a79f30eaeb3c521912f231d43eb` is now tracked **without rewriting the core policy code** under `native/codex-execpolicy/src`. Its upstream `codex-rs/utils/absolute-path/src` dependency is tracked under `native/codex-utils-absolute-path/src`. Both retain OpenAI Codex's Apache-2.0 attribution. The standalone package manifests, native build integration and JSON-lines `src/bin/ccm-bridge.rs` are CCM transport/build adapters, not replacement rule engines. The native build produces the upstream-compatible `ccm-codex-execpolicy` CLI and a `ccm-codex-execpolicy-bridge` that calls Codex's parser, decision model, and file-locked `blocking_append_allow_prefix_rule`.

An actual Codex `.rules` file supports `prefix_rule(pattern=[...], decision="allow"|"prompt"|"forbidden", match=..., not_match=...)`, token alternatives, `canonical_matching`, `host_executable` restrictions and the upstream rule severity ordering. The native engine's parser validates embedded match examples before accepting a file. The standalone native and IPC tests verify these behaviors, invalid syntax rejection, and idempotent persisted Allow.

**Live Controller integration (2026-11-11):** the Controller loads and evaluates the upstream Starlark `.rules` policy through the native Rust bridge on each command decision. Allow dispatches with Full Access, Prompt uses the existing frozen CCM approval card, Forbidden rejects, and no matching rule keeps the ordinary Worker sandbox path. Always allow appends a prefix rule with Codex upstream file locking into the same policy file. This is a Controller/Worker and GPT Host transport adaptation; the full Codex core heuristic/approval orchestration is not claimed as ported.

**Verification:** both 6v and noha native builds passed; noha needs the explicitly elevated CCM agent for Rust compilation because its restricted process could not discover the installed Visual Studio C++ tools. The serial full Node suite passed on 6v (338 passed, six opt-in skips) and noha (337 passed, seven skips including the 6v-specific policy state test), with zero failures on either host. The normal parallel runner can stall on a TCP transfer integration case that passes separately. Run the full suite with `node --test --test-concurrency=1 --test-timeout=60000` for reproducible results. On noha, the Windows dynamic TCP port range starts at 1024; its OAuth loopback wire test uses the Node HTTP client because Fetch blocks some valid local TCP ports.

### Codex PowerShell literal command parser and persistent prefix rules

CCM compiles and calls the unchanged upstream Codex Tree-sitter PowerShell lowerer, pinned at ed8eac40832e6a79f30eaeb3c521912f231d43eb; original fixtures and hashes are recorded in docs/codex-parity.md. When upstream rejects a script, the owner-approved wrapper recognizer in src/runtime/sandbox/shell-policy-parser.mjs accepts only literal PowerShell environment-assignment prefixes and static & invocation targets. Every ordinary executable segment is independently validated by the unchanged upstream parser; unsupported dynamic expressions never inherit a saved Allow. The extension returns tokens only and never rewrites command text or supplies executable source bindings. CMD parsing remains a separate conservative tokenizer.

Saved Always allow prefixes compare exact tokens as in Codex non-canonical PrefixPattern: executable suffixes and token case are significant. PowerShell &, literal $env:NAME assignments preceding commands, and compound sequences may reuse an existing executable Allow when every executable segment matches. This includes the TeX pattern $env:TEXMFHOME='C:\\texmf'; & 'C:\\texlive\\2026\\bin\\windows\\xdvipdfmx.exe' output.xdv when the saved executable token matches. PowerShell pipes also require authorization for every segment. No executable rewriting is performed. Dynamic environment expressions and computed invocation targets remain outside the extension. Codex shell_environment_policy.set remains available for Worker-session-wide settings but is not required merely to reuse an existing executable Allow.

**Remaining alignment boundary:** the upstream Starlark rule parser, matcher, decision severity and file-locked prefix persistence are live. CCM maps them to its existing sandbox and approval-card lifecycle. The native Codex main-agent heuristic and async reviewer session orchestration are not adopted; CCM's staged synchronous Guardian reviewer uses the same frozen request and Worker executor. Unmatched commands retain normal sandbox behavior.

### Guardian auto-review: deployed on 6v Controller

The Controller now has a configurable synchronous Guardian adapter derived from the pinned Codex Core MCP sources. Source policy and policy-template Markdown are copied intact; Controller Host adapters adjust its evidence rule and reviewer permission ceiling per the owner's approved choices. CPA model `codex-auto-review` judges the frozen `exec_command` action. The Reviewer **trusts the main Host model's description of user intent, authorization and task constraints**, without independent Host transcript retrieval.

The Reviewer uses the **same model-visible CCM ToolRegistry and effective tool permissions as the main model**, not a forced read-only reviewer sandbox. An internal review-origin marker prevents recursive Guardian review but never authorizes nested tool escalation. Existing sandbox, app approval, Workspace and Admin rules still apply. Existing native Codex ExecPolicy stays the sole command policy authority, including its Forbidden and persistent Allow rules.

When a command needs explicit `require_escalated` approval, a native ExecPolicy `prompt`, or `run_as_admin=true`, the Controller creates a frozen ApprovalManager request. If `controller.guardian.enabled=true`, Guardian reviews the same single action using an optional main-model `review_context` and the exact execution permission level. **Allow** claims the exact intent once and executes it through the original Worker; **deny** terminates without executing; CPA/parse/timeout/tool errors do **not** authorize execution and fall back to the original human approval card. Reviewer approval never appends a persistent rule. Administrator commands require one-time approval regardless of saved Allow rules, trusted commands or timed Full Access grants, and execute only through the administrator Agent after approval.

**Administrator approval acceptance (2026-11-12):** both the 6v Controller/local Worker and the noha remote Worker were restarted at commit `93a44cb89b4cec3ab33b4fd8f878a742778697c5` and reconnected normally. Each received a real CPA Guardian `allow` for a read-only administrator-token identity check, then returned `administrator_agent=true`, `state=consumed`, `exit_code=0`, and `CCM_ADMIN_ELEVATED=True`. The 6v serial suite passed 357 tests with six opt-in skips before two additional focused tests were added; the final targeted 83-test approval suite passed on both hosts. A noha full-suite attempt encountered timeouts in unrelated Worker RPC/file transport tests and was stopped; this must not be represented as a green noha full-suite run.

Guardian is **enabled on the deployed 6v Controller** and reviews escalations for its local and remote Workers, including noha. The tracked `ccm.config.example.json` stays **disabled by default** for fresh installations. The active setting is held in the ignored root `ccm.config.json`. Its `api_key_config` references CPA's own ignored `config.yaml` by **absolute path**; alternatively use `CCM_GUARDIAN_API_KEY` in the protected `controller.env` configuration. Do not copy actual keys into tracked files or pass them as MCP tool arguments. The default model is `codex-auto-review`, with a shared review deadline, bounded function-call turns/results, parse-retry rules and human fallback.

**Verification (2026-11-11):** `scripts/probe-cpa-guardian-adapter.mjs` passed a real CPA two-tool/three-response cycle using the actual `CpaReviewClient` and `GuardianToolDispatcher`, including both successful tool handlers and strict structured `allow`. The original `scripts/probe-cpa-auto-review.mjs` also passed stateless full-history replay; `previous_response_id` continuation still returned 400/missing call ID. `test/guardian-reviewer.test.mjs` covers freeze/allow/deny/fallback, shared registry, writable in-memory reviewer tool, parse retry, tool failure and execution-unknown. Current migration source and outstanding acceptance details are in [docs/auto-review.md](docs/auto-review.md).

**Runtime acceptance (2026-11-12):** 6v's running Controller reviewed and automatically executed `Write-Output 'CCM_GUARDIAN_REAL_PROBE_20261111'` on the local Worker. The same Controller reviewed and executed `Write-Output 'CCM_GUARDIAN_NOHA_PROBE_20261112'` on remote noha. Both returned `review_source=guardian`, `review_outcome=allow`, `review_risk_level=low`, `state=consumed`, `exit_code=0` and the exact expected harmless output; no human approval card was needed. The Controller and both Workers reconnected healthy following controlled restarts, and both Git checkouts matched `f168215b23a0eb779db6c45ae6a96ed0e173909d` at release. Deny, malformed response, tool-error, pre-dispatch fallback and in-flight-unknown branches have automated tests but **have not all been triggered as live production CPA failures**.

**Regression verification:** the full serial 6v Node suite, including 13 new Guardian tests, passed on 2026-11-11: 357 tests total, 351 pass, six opt-in skips and zero failures, using `node --test --test-concurrency=1 --test-isolation=none --test-timeout=60000`. All 13 Guardian tests also passed independently on noha after synchronization and restart.

### Codex shell environment policy: first integrated subsystem

**Upstream pinned source:** `ed8eac40832e6a79f30eaeb3c521912f231d43eb`: `codex-rs/protocol/src/{shell_environment.rs,config_types.rs}`, `codex-rs/config/src/shell_environment_policy.rs`, `codex-rs/core/src/exec_env.rs`, and upstream `shell_environment_tests.rs`.

The upstream-derived shell environment implementation is attributed to OpenAI Codex (Apache License 2.0); its license is included at `third_party/openai-codex/LICENSE`.

CCM now reads the standard Codex `config.toml` under `CODEX_HOME`, or under the current Worker's `~/.codex` if `CODEX_HOME` is absent, when constructing its Worker executor. This shares the existing Codex `[shell_environment_policy]` configuration on each Worker rather than creating a conflicting CCM-only policy format. Supported TOML keys are `inherit = "all" | "core" | "none"`, `ignore_default_excludes` (Codex defaults to **true**), `exclude`, `include_only`, `set`, `filters` and `experimental_use_profile`. The canonical `filters` table cannot be mixed with legacy `exclude`/`include_only`; filter patterns are case-insensitive and have `*`/`?` wildcards. The policy applies inheritance, default excludes (when enabled), custom excludes, explicit overrides, include-only filtering, runtime thread ID (if provided), and final Codex non-inheritable identity-variable removal in that order. Windows overrides compare keys without case, and missing `PATHEXT` receives the Codex fallback. Pipe, PTY, restricted and Full Access launch paths share this environment calculation; the experimental profile setting reaches the PowerShell launch arguments in both native and direct paths. Restart the relevant Worker after updating Codex config to load a new policy.

To configure a TeX user tree using Codex's actual configuration format, place `TEXMFHOME = "C:\\\\texmf"` under `[shell_environment_policy.set]` in that Worker's `~/.codex/config.toml`; it applies to all new shell commands in that Worker session, **not** just one `xdvipdfmx.exe` invocation. This implementation does not introduce a per-command `env` argument because that is not the Codex tool's contract.

**Windows workspace-write sandbox and temporary files:** The deployed native helper `native/windows-sandbox/CcmSandboxRunner.cs` resolves the final command environment's `TMP` and `TEMP` into distinct existing local directories and grants each a persistent, per-user/per-directory capability SID with inheritable NTFS Modify rights. Those SIDs are added only to `workspace-write` restricted tokens; `read-only` receives no temporary write permission. It keeps the existing `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED` token and the independent workspace SID. Identical paths are deduplicated, and missing, relative, reparse-point, volume-root, whole-profile, or sensitive system/program directories fail closed without automatic elevation. The helper inherits exactly the environment constructed by the Worker after Codex shell environment policy; it does not change `TMP` or `TEMP` values or create substitute directories. Like other workspace ACEs, the temporary-directory ACL grants persist; a stable SID avoids accumulating a new ACE for every command. This is an owner-approved adaptation of Codex's writable `:tmpdir` policy, not a claim of complete native Windows sandbox parity.

The Windows integration test `test/windows-native-temp-permissions.test.mjs` runs with `CCM_RUN_WINDOWS_TEMP_ACL_TEST=1` on an authorized Windows host. It verifies separate and duplicate `TMP`/`TEMP` values, existing-file modification, continued read-only and non-temp write denial, protected-path rejection, and a real TeX Live `xdvipdfmx` conversion when installed. The previous `xdvipdfmx` failure was caused by a denied write to its user `TMP` directory, not a demonstrated ALPC deadlock; with the directory authorized, no special TeX shell prefix or administrator access is required.

**Known launch-path mismatch still to resolve:** CCM currently refreshes Windows Machine/User registry environment variables for each command and applies its independent Worker child-proxy and local CA settings before the Codex policy; upstream Codex starts from the process environment managed by its own config/session layers. Explicit Codex `set` overrides the CCM command-layer values, so the effective result may differ from CCM's proxy/direct toggle when the same keys are explicitly configured. These retained facilities are **not** claimed Codex-parity features; no migration/removal has been made yet.

## Status

CCM is currently targeting **v0.1** as its first public release.

- Milestone 1 — Execution Core: implemented and regression-tested.
- Milestone 2 — Environment + Remote Worker: implemented and regression-tested.
- Milestone 3 — Editing (`apply_patch`, `view_image`): implemented and regression-tested.
- Milestone 4 — Flat MCP Tool Registry: implemented and regression-tested.

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

Worker quarantine error codes are configured in the `worker_quarantine_errors` section of the root `ccm.config.json` file. CCM hot-reloads valid edits to this file with no Controller restart. Invalid live edits are logged and ignored while the last known-good policy remains active; invalid configuration at Controller startup is fatal.

Registered workspaces are owned by each Worker, not by the Controller. **Workspace handle** (`workspace_handle`) is a reusable UUID-shaped reference to one workspace on one Worker; it is not an `environment_id`, `workspace_id`, conversation context, or MCP session. A registered workspace may have multiple valid handles. If the user, project instructions, or CCM already supplies a handle for the intended project, pass it directly to operational tools; do not call `select_workspace`, `register_workspace`, or `create_projectless_handle` and do not request entry approval merely to obtain a new handle. Only call `select_workspace` when no usable handle exists **and** the user explicitly requests workspace entry/switching. Only call `register_workspace` when the user explicitly requests registration and no usable handle exists. Call them directly. Reading, inspecting, editing, or working on a project (including saying "read the workspace") never authorizes entry, registration, or an entry approval; a missing or rejected handle does not authorize automatic entry. `select_workspace` / `register_workspace` calls always validate the exact workspace identity or registration target. In a `full-access` environment, entry returns the real `workspace_handle` directly in the tool result for the user to copy. Restricted environments freeze the exact workspace action and return an opaque `approval_id`; the `request_approval` tool renders that frozen action in the CCM approval app, and on successful approval the same card displays the workspace handle. Restricted entry tools do not create a handle-card iframe while approval is pending. Approval resumes the same validated action without a model-generated retry. `register_workspace` combines registration and entry; with `create_if_missing=true`, the action may also create the exact missing project directory before registration. Denied/failed/pending actions do not show a new handle, and `create_projectless_handle` never shows one. Normal development tools carry only the resulting handle. Workspace handles are persisted by the Controller and remain valid across Controller or Worker restarts; entering a project again generates a new valid handle without invalidating the old one. Worker-local projectless mappings are persisted as well, so a surviving projectless directory can be resumed after a Worker restart.

An environment does not expose a default workspace or default working directory to the MCP client. Worker bootstrap cwd is a runtime seed only; it is not a project-location hint, a default project, or the parent directory for newly created projects. CCM deliberately has no "Projects Root" policy: project placement comes from the user or the upper-layer orchestrator.

When no suitable handle exists, a genuinely projectless task or a permitted absolute-path read can use a projectless workspace via `create_projectless_handle`. For writing to a registered project, ask for its handle or an explicit entry request; do not select or register implicitly. Pass `environment_id` to create it on a specific Worker, or omit `environment_id` to use the primary environment. Projectless workspaces are created under `CCM_PROJECTLESS_ROOT` (default: the user's `Documents\\CCM` directory) and provide a temporary execution context without selecting or registering a real project. If `select_workspace` or `register_workspace` has already returned `approval_required=true` for the user's current intended real project, the model calls `request_approval` and waits for that frozen workspace action rather than using projectless workspace to bypass it. Changing the target project alone does not authorize a new entry. A separately explicitly requested workspace entry/registration may proceed without denying the older pending approval.

`ccm.unregister_workspace(environment_id, workspace_id)` removes one registered project from its Worker's registry without deleting the directory or any files. Call it directly, and display its mandatory one-shot `request_approval` card, **including on full-access Workers**. It has no Always-allow option. The tool reads the Worker-local registration metadata even when the original project directory has already been deleted; regular workspace selection and execution still require an existing directory. Approval freezes the Worker, workspace id, root and creation time, then rechecks that exact registration before revoking its previously issued workspace handles and removing the registration. Old handles cannot be reused after re-registration. Existing running OS processes are not forcibly terminated, although their old handle can no longer continue a CCM process session. Rejection, expiration, or a changed registration do not remove the registry entry. Projectless workspaces cannot be unregistered. A bootstrap project is seeded only on first registry creation, so approved unregister does not silently re-register it on Worker restart.

### Owner web unlock: timed global Full Access

CCM keeps its original per-Worker `CCM_PERMISSION_PROFILE` (normally `workspace-write`). The Controller additionally accepts **owner-issued, time-limited Full Access grants**. A grant becomes usable after the owner claims it through the webpage's copy button or the model's fallback tool, and can be used on any existing or newly connected Worker, regardless of its original sandbox setting; neither Worker settings nor the workspace handle are changed. Authorization is checked for each new operation. Already-started Full Access processes are allowed to finish naturally after expiry. Workspace deregistration continues to require its own one-shot approval, including during a timed grant.

**One-time local phone authenticator enrollment (6v only):** In a *local terminal*, run the absolute-path PowerShell script `C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\scripts\manage-ccm-totp.ps1` with `-Action Init`. Add the displayed secret or OTP URI to a phone TOTP app (SHA1, six digits, 30-second period), then run the same script with `-Action Confirm -Code <six-digit-code>`. Use `-Action Status` to inspect setup. Never execute `Init`, `Confirm` or `ReadForSidecar` through CCM or pass enrollment secrets/verification codes through a model or chat. The seed is stored via Windows DPAPI CurrentUser outside Git under `%LOCALAPPDATA%\CCM\secrets`, and the supervisor/sidecar must run under that same Windows account. `-Action Reset` clears enrollment and browser pairings, and invalidates active grants by changing the confirmed-enrollment marker; enroll again before reuse.

After enrollment, visit the CCM HTTPS origin's **`/ccm/unlock`** page. The browser pairs once with a phone TOTP code (replay-protected, rate-limited); subsequent visits use its secure HttpOnly pairing cookie. The owner selects 1 minute, 5 minutes, 30 minutes, 1 hour, 6 hours, 1 day, or 7 days and clicks **临时解锁 CCM**. The Controller creates one pending grant, with an expiry counted from the unlock click and a claim window capped at five minutes (or grant expiry, whichever is sooner). The webpage shows its `full_access_grant_id`, expiration, and an **一键复制并领取全权限句柄** button. Only a paired browser may view it. Clicking the button copies the ID-containing message to the clipboard, then sends a CSRF-protected, authenticated one-shot claim to the Controller. **Only after that claim succeeds does the page return to the locked/unlock-form state**; a failed clipboard write leaves the grant unclaimed. Copying the visible ID manually does not claim it. While pending, the duration form is hidden and repeated issue requests do not replace the grant or extend expiry. On claim or expiry it reappears. The display is derived exclusively from Controller status, not stale URL parameters.

When the owner pastes the successfully claimed `full_access_grant_id`, the model uses it **directly** on `exec_command`, `apply_patch`, and explicitly requested `select_workspace` / `register_workspace` calls. If no ID was copied, the owner may tell ChatGPT that CCM is unlocked, and the model can call `ccm.claim_full_access` directly to consume the pending grant. If the owner already copied and claimed it but ChatGPT blocked the ID message, that tool can instead **recover the same ID once** during the original claim window; no second grant is issued. Recovery does not restore the pending webpage, replace the ID, or extend expiration. After claim the web form can immediately issue another grant while earlier claimed IDs remain valid until their individual expirations. Unclaimed grants expire after at most five minutes; one-minute grants expire after one minute. Unrecognized, unclaimed, or expired IDs fail closed. Other sessions and calls without an ID continue under their original policies; a model must not infer authorization just because another caller has unlocked CCM. Grants live only in Controller memory and are revoked on Controller restart. The model must not send any TOTP seed or one-time verification code to an ordinary CCM tool.

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

## MCP tools
All 31 registered tools are equal peers in MCP `tools/list`. The Host controls discovery, selection, ordering, and parallel invocation. The public MCP wire names omit the namespace; the table below uses the qualified names for clarity. All can be invoked directly without a CCM discovery/dispatch wrapper.

| Function | Tools |
| --- | --- |
| Process, edit, image | `ccm.exec_command`, `ccm.write_stdin`, `ccm.apply_patch`, `ccm.view_image` |
| Projects and handles | `ccm.list_projects`, `ccm.create_projectless_handle`, `ccm.select_workspace`, `ccm.register_workspace`, `ccm.unregister_workspace` |
| Approval and grants | `ccm.claim_full_access`, `ccm.request_approval`, `ccm.get_approval_status`, `ccm.resolve_pending_action` |
| Verification | `ccm.request_verification_input`, `ccm.get_verification_input_status`, `ccm.submit_verification_input` |
| Plans and restarts | `ccm.plan_patch`, `ccm.plan_read`, `ccm.restart` |
| File transfer and publishing | `ccm-extra.transfer_path`, `ccm-extra.transfer_status`, `ccm-extra.transfer_cancel`, `ccm-extra.publish`, `ccm-extra.import_chatgpt_file` |
| External workflows | `ccm-extra.conversation`, `ccm-extra.quark_upload`, `ccm-extra.bilibili_download_dash`, `ccm-extra.qq`, `ccm-extra.wechat`, `ccm-extra.transcribe`, `ccm-extra.sjtu_mail` |

The approval-status/resolution and verification-status/submission bridges are registered in the same MCP list but marked `ui.visibility=["app"]`, so only their corresponding MCP Apps should invoke them. `request_approval` and `request_verification_input` are model-callable tools that present those Apps. The tools themselves retain their original authorization, argument validation and file-safety contracts.

Ordinary repository inspection, search, Git, builds, tests, and diagnostics should use `exec_command`.

### Local CLI passthrough (QQ, WeChat, transcription, SJTU email)

Four dedicated top-level tools expose the local application CLIs without asking the model to construct PowerShell:

| MCP tool | Target | Arguments and routing |
| --- | --- | --- |
| `qq` | 6v `C:\\Users\\Songjx\\Documents\\ChatGPT\\QQBridge\\qq.exe` | `args: ["recent", "count=10"]`, or any documented QQBridge CLI tokens |
| `wechat` | 6v `C:\\Users\\Songjx\\Documents\\ChatGPT\\WXBridge\\WXBridge.exe` | `args: ["chats"]` or `["messages", "--chat", "name"]`; read-only Bridge |
| `sjtu_mail` | 6v `C:\\Users\\Songjx\\AppData\\Local\\Programs\\himalaya\\himalaya.exe` | `args: ["envelope", "list"]`; no Gmail proxy/fallback |
| `transcribe` | Windows Worker Python 3.9 Faster Whisper | `args: ["D:\\\\audio.wav", "--language", "ja"]`; 6v default, `environment_id` may select another installed Worker |

`transcribe` uses only a minimal bundled command-line entry (`tools/faster-whisper/transcribe.py`), defaults to the `large-v3-turbo` model, and writes JSON segments with `start`, `end`, and `text` to stdout. The caller provides an existing local audio file; neither the tool nor this shim downloads media. Normal Python/Faster Whisper traceback text remains on stderr.

Each integration pins its executable: the model passes an **array of argument tokens**, not a shell command, executable path or script. The Worker starts that process with `shell=false`, captures its stdout and stderr without parsing, and returns them as separate MCP text blocks plus the original exit code in structured content. Nonzero exits are errors; if the executable (or the transcription entry file) is absent, the result is exactly `不存在`. The Worker does not retry sends or mutate the output. There is a 20 MiB aggregate capture limit and caller-controlled timeout; larger MCP responses are additionally subject to the Controller/Host result-size limits.

These are explicit, owner-authorized application adapters: **they use Worker-side subprocess execution rather than the `exec_command` workspace sandbox and approval flow**. They accept only the fixed programs above, strip `CCM_*` bootstrap environment variables, and do not permit an arbitrary executable. The three messaging/mail adapters are routed to 6v only; the transcription adapter needs Python 3.9 with `faster_whisper` installed on the selected Windows Worker. Refresh ChatGPT's tool list after deploying these new MCP peers. A disconnected Worker cannot be validated or used until it reconnects.

### Verification input card

When a running interactive command pauses for a verification code, call `request_verification_input({workspace_handle, session_id, label?})`. The user enters the code **in its MCP App card, not in chat**. The card calls App-only `submit_verification_input({request_id, value})` through `tools/call`. Controller sends the input plus Enter to the running Worker process session (CR for PTY, LF for pipes). **Only after the user clicks Submit and the card receives a delivered result**, the App automatically sends the model a code-free continuation. The model then assumes the code was submitted and resumes the original task without reading the code, querying input/submission state, or checking process output specifically to confirm input. If subsequent ordinary task execution explicitly reports invalid verification, offer another card for a live session.

The submit/status tools have `ui.visibility=['app']` and are not ordinary model-facing tools. Each card sends input at most once, including after remounts and duplicate clicks. Controller retains only routing metadata in memory for up to four hours, never the entered value. CCM does not write the value into its own persisted logs, approval receipts, widgetState, model context, or follow-up messages; the target program's own logging behavior remains outside this contract. A two-minute transient in-memory echo mask also scrubs the exact entered value from later ordinary process output; the mask expires even without further polling. An uncertain delivery is not retried automatically.

This is a **live process stdin** feature, not a general-purpose website form filler or a model-readable code mailbox. An exited session cannot receive input. MCP App calls still traverse the ChatGPT Host and may be filtered there: App-only routing avoids model-generated code arguments but cannot guarantee Host acceptance. No new public endpoint, long-term secret store, or external service is required. Refresh CCM tools in ChatGPT after deploying any new tool.

### Core project and Plan capabilities
`list_projects` enumerates the connected environments without entering a workspace. `select_workspace` and `register_workspace` require an explicit user instruction and no usable handle; `unregister_workspace` always requires one-shot approval. `claim_full_access` is a direct-call fallback for a missing web unlock ID. `plan_patch` and `plan_read` manage a single durable Plan and carry its `plan_id` explicitly.

### Durable Plans

CCM provides durable Plan storage without implementing a Controller-side "Plan Mode" state machine. When a user explicitly asks to plan/discuss before implementation and persistence is useful, call `ccm.plan_patch` / `ccm.plan_read` directly.

`ccm.plan_patch` omits `plan_id` only for the first write. That call creates a Plan and returns an opaque UUID; later reads/patches carry that id explicitly, so Plan identity is independent of MCP transport sessions. Managed Plans are stored centrally under ignored Controller state at `.state/plans/<plan_id>.md`; no public list/delete/search-other-Plans capability is exposed and v0.1 does not automatically expire or garbage-collect Plan files.

Plan patches reuse the normal Codex-style patch grammar but target one virtual file only: creation uses `*** Add File: plan.md`, and updates use `*** Update File: plan.md`. The real `.state` path is never accepted as a tool argument. Planning follows an explore-first, ask-second discipline: discoverable repository/environment/documentation/tool facts should be established through targeted non-mutating inspection rather than questions. If a high-impact ambiguity instead depends on a non-discoverable user preference, product/scope/compatibility choice, or meaningful tradeoff, ask rather than guess. For those decisions, explicitly present 2-4 mutually exclusive choices in the user-visible question, preferably with concise labels, and identify a recommended/default choice there when useful; the user may still give another answer outside the listed choices. Generating options only in model reasoning without showing them to the user does not satisfy this planning contract.

While Plan work remains planning, normal read/search/status/history/diff inspection, diagnostics, dry-run/non-mutating validation, and tests/builds whose only side effects are ignored/cache/temp outputs are allowed. Tracked implementation edits, implementation patches, migrations, rewriting code generation or formatting, dependency/configuration changes, deploy/release actions, commits, pushes, and similar intentional mutations require an explicit user instruction to execute/implement. Imperative task wording, completed inspection, workspace approval, registration approval, or sandbox escalation approval does not itself authorize implementation. CCM intentionally does not add a Controller-side Plan-Mode state machine or clone Codex Host-specific `request_user_input`, `<proposed_plan>`, or PlanDelta UI/protocol behavior; a clear user instruction to execute/implement is the transition into implementation.

Keep the logical Plan current rather than append-only: rewrite or remove completed, invalidated, obsolete, or superseded items while preserving active constraints and unresolved decisions. A decision-complete Plan should capture the goal/success criteria and scope, implementation approach and affected components/files, relevant interface/schema/data-flow changes, edge cases/failure modes, compatibility/migration/cleanup decisions, tests/validation, and acceptance criteria, with genuinely blocked assumptions or unresolved items labeled explicitly. The handoff should be concise but detailed enough that another executor does not need to invent new product or design decisions.

When planning reaches a decision-complete stopping point, the model calls `ccm-extra.publish` with `plan_id` only. Controller reads the **entire latest persisted Plan** directly and publishes an immutable Markdown snapshot without the bounded `plan_read` path or a Worker handle. The model summarizes key decisions in the reply and refers to the publication card/link instead of repeating the full Plan text. If publication fails, the model reports the failure without claiming delivery or automatically dumping the Plan into chat. This handoff is specific to finishing the planning phase; it does not authorize implementation. `ccm.plan_read` remains lifecycle-neutral during implementation, so implementation can consult a Plan repeatedly without re-entering planning or automatically republishing.

## Tool registry and Host discovery
The Controller registers every tool through one `ToolRegistry`, enforcing unique MCP wire names across all namespaces. The MCP server registers the entire list in `tools/list` with each tool’s own schema, annotations and MCP App metadata. There are no CCM-managed tool-exposure tiers or nested tool dispatch; adding a tool changes the Host-visible list after Controller restart and a client tool refresh.

Native ChatGPT input file objects bind directly to `import_chatgpt_file.file` using its `openai/fileParams` metadata. App-only bridge tools remain individually registered with visibility limited to the App. All workflow sequencing, parallelism, retries and tool selection belong to the Host. CCM owns execution/approval state but not model orchestration.

### Compatibility contracts

CCM treats confirmed client/Host/model/Worker compatibility findings as repository behavior, not conversation-only notes. When a compatibility issue is confirmed, record the affected surface and required routing/workaround here; remove the wording when the constraint no longer applies.

- **Published-file MCP App client compatibility:** The current `published-file-v9` card uses a bounded 260px rendered Markdown excerpt, a 220px source snippet for other text types, and external full-preview links (image previews allow zoom/drag). Some ChatGPT Android and mobile-web versions may scroll the chat instead of the preview or fail to mount a revised UI URI, even when `resources/read` and tests succeed. Verify card opening and links on actual clients before claiming Host compatibility.
- **Stable publish UI resource identity:** Keep the published-file UI URI unchanged for style-only/math-render changes. The ChatGPT mobile Host may cache the tool descriptor independently of Controller deploys; if a descriptor references an unregistered URI, the App cannot be fetched although publish and the browser preview succeed. A prior style-only URI rotation was reverted; the stable URI has a contract test. For future changes that genuinely require URI rotation, validate cached-client migration and real mobile card rendering before release.
- **Host discovery/routing:** Every CCM tool is advertised directly in `tools/list`. A Host may choose which tools to show or invoke; real model routing behavior must be validated in the client.
- **Host tool-list caching:** ChatGPT can cache MCP tool definitions. After a CCM Controller restart, use the ChatGPT CCM plugin’s **Refresh tools (刷新工具)** control to reload names, schemas and descriptions. A fresh conversation alone may still use cached definitions.
- **6v/noha release synchronization (maintainer procedure, not model-facing tool guidance):** A completed CCM update includes matching Git commits on the 6v Controller checkout and noha Worker checkout. Push tested changes from 6v, fast-forward noha without discarding local edits, restart the respective supervisors/Workers, and verify both commit hashes and Controller health / noha reconnection. Report blocked deployment or version skew as incomplete; only intentionally stage versions when the user requests it.
- **Native input-file binding:** `ccm-extra.import_chatgpt_file` receives a native file directly in its `file` parameter with `openai/fileParams` metadata. Library files must first be materialized as raw_file through ChatGPT Files.
- **Approval UI:** `request_approval` is model-callable and retains it carries the Host/App output template and widget metadata. `resolve_pending_action` is App-only and resumes the frozen action; the Host sees their respective visibility metadata. After a terminal approval decision, the App updates model context and prefers the standard MCP Apps `ui/message` bridge when the Host advertises text-message support. The ChatGPT `window.openai.sendFollowUpMessage` compatibility alias is used only when standard messaging is unavailable or explicitly fails. Continuation failure is reported in the card and never changes or retries the already-resolved action.
- **Approval card reopening (ChatGPT web/Android):** The Host may remount MCP App cards with the original pending tool result. The approval-v3 app preserves terminal UI state and the successful registered-workspace handle using the optional ChatGPT `widgetState` API and the App-only `get_approval_status` read. Old pending results must never override verified terminal state. On web, `openai:set_globals` may precede the `ui/initialize` response; after the handshake, start one read-only status query even when the same approval was already loaded. The read requires the original card nonce (and bound Host session when present), never executes an action, and cannot be used by the model. The Controller atomically stores bounded terminal receipts under its private state dir (90 days, at most 4096 records), separate from the existing in-memory 5-minute terminal cleanup and 3-day pending approval TTL. Execution receipts retain up to 12,000 characters of the initial command output, truncation indication, and an exit code or session ID; the approval card reveals saved output in a collapsed, selectable panel. Continuing-session output from later `write_stdin` calls is not part of that initial receipt. Output may contain sensitive data and remains in the private Controller state file for its retention period. Command text and card nonces are never persisted in receipts. Controller restarts discard pending actions but retain eligible terminal receipts. If the Host doesn't provide prior card metadata, verification fails closed (no second Approve/Deny). Old approval-v1/v2 URIs remain aliases for new UI HTML, but cached historical old HTML cannot be repaired remotely. UI snapshots never store nonce, command output, or new permissions. Host restart/reopen validation on Android is required before calling the client rendering fully verified.
- **Workspace handles (ChatGPT web/Android):** `select_workspace` and `register_workspace` return the registered handle directly after successful full-access entry. They do not attach MCP App UI on pending actions, avoiding an empty Host-owned frame. Restricted entry uses the `request_approval` App card, which exposes the handle only after approval. Projectless, pending, failed, and denied operations do not display registered handles.
- **Outbound file publishing with one file card:** `ccm-extra.publish` is a peer tool, one resource per call, serial for multiple files. Original bytes are retained in a bounded 1 GiB Controller cache for up to 72 hours. The MCP App shows fitted PNG/JPEG/WebP/GIF/AVIF/BMP images; a scrollable 260px rendered Markdown excerpt from at most 8 KiB of source (32 KiB rendered limit) and a full formatted HTML preview link; a 220px source excerpt for other UTF-8 text/JSON/code with a full-text link; or a browser preview link for PDF, audio (MP3/WAV/M4A/OGG/FLAC/AAC), video (MP4/WebM/OGV/MOV), and HTML/SVG/XHTML. Every card retains an original-file download link. Markdown rendering escapes embedded HTML, blocks script URLs and remote image loads, and is isolated by the same restrictive CSP sandbox used for HTML/SVG. Plain text remains `text/plain; charset=utf-8` with `nosniff`. Browser rendering and codec support depend on the client; unsupported types such as Office files remain download-only without conversion. Media and PDF previews support single HTTP byte ranges; generated Markdown HTML always returns the full rendered page. The existing `/ccm/preview/<token>` and `/ccm/download/<token>` routes need no extra Funnel route, intermediate HTML file, MCP resource, or ChatGPT Library storage. Invalid UTF-8 Markdown cannot be rendered, but its original bytes remain downloadable. Publish proactively for requested artifacts; verify clickable links in each ChatGPT client after deployment.
- **Markdown formulas and model-facing visual inspection:** `ccm-extra.publish` retains its existing `{plan_id}` or `{workspace_handle, path}` arguments, original Markdown bytes, public preview URL, and MCP App card. Controller Markdown rendering now uses `@mdit/plugin-katex` with `$...$`, `$$...$$`, `\(...\)` and `\[...\]`; server-generated MathML requires no external JavaScript, CDN or font download and retains HTML escaping, restricted CSP and disabled remote images. During that same publish call, the Controller renders the full Markdown HTML in an installed headless Chrome/Edge browser through `playwright-core` and attaches up to four bounded JPEG screenshots as native MCP `image` content, with a `render_inspection` diagnostic object also returned in `structuredContent`. The inline card is still capped at 8 KiB source and 32 KiB rendered HTML, but screenshot generation uses the complete original Markdown up to a 2 MiB inspection limit. Documents longer than one screenshot receive representative beginning/formula/table/end slices, **not exhaustive full-document visual verification**. Automatic diagnostics count parsed formula errors and detect page-wide horizontal overflow; only the receiving Host model can perform semantic visual review. The model must inspect returned screenshots and correct/re-publish defects before claiming visual acceptance. Missing browser, blocked browser launch, malformed source, oversized Markdown or capture failure is reported as `status=unavailable` instead of a successful visual check; the original file and full preview link remain published. Screenshots represent published browser HTML, not pixels from the ChatGPT-hosted card itself, which still needs real-client acceptance. No additional MCP tool, public image route or screenshot file is created.
- **ChatGPT link tracking on file URLs:** ChatGPT's mobile link opener may append `?utm_source=chatgpt.com`. Both Controller and the HTTPS sidecar must resolve `/ccm/download/<token>` and `/ccm/preview/<token>` by pathname and ignore query parameters rather than rejecting them with 404. The sidecar forwards only the validated pathname to the Controller; file token validation, GET-only handling, size checks, and existing cache expiry remain in force. This fixes opening CCM preview/download links; it does not by itself guarantee Markdown images render inline in every ChatGPT client.
- **Long process polling / Host limitation:** A previous extended ChatGPT session exhibited stalls while repeatedly polling `write_stdin` through the Host. CCM now exposes a single direct `write_stdin` path, including empty reads, and no internal alternate dispatcher. The Host is responsible for reliable long-duration polling. Reuse the same `workspace_handle` and `session_id`; on Host-level failure without a CCM result do not presume the poll completed or create a replacement session. Revalidate extended polling on actual clients.

CCM does not embed JavaScript orchestration or nested tool execution. The Host is responsible for loops, branching and parallel calls. The `write_stdin` tool directly polls or writes to a live process.

### Unified conversation import and reading

Use `ccm-extra.conversation` directly for public ChatGPT (`https://chatgpt.com/share/...`) and Codex (`https://chatgpt.com/s/cx_...`) shares, or local Codex thread UUIDs. The same tool handles import, reading and export without browser automation.

- `action=import`: provide `share_url`, optional `environment_id` and ChatGPT `branch=active|all`. The selected Worker fetches the public payload using desktop headers (ChatGPT) or the Codex JSON snapshot API, then atomically saves its complete normalized and raw snapshot in ignored `.state/conversations/`. The response gives a stable `conversation_id` and revision.
- `action=thread/read`: read metadata from a saved snapshot using `conversation_id` and the same `environment_id`, or from a local Codex UUID using `thread_id` and its Worker.
- `action=thread/turns/list`: paginate human-readable turns with `cursor`, `limit` (default 20, maximum 50), and `sort_direction`. ChatGPT turns follow the active branch, even when other branch nodes are retained.
- `action=thread/items/list`: paginate individual items, optionally with `turn_id` and `mode=text|full`. Full mode retains original records where available, bounded in inline output.
- `action=export`: save Markdown or JSON under ignored `.cache/conversation/` with `mode=text|full`, optionally publish the file using `ccm-extra.publish`.

Reads of imported shares are offline; only a new import refreshes the snapshot. Failed refresh keeps the previous complete version and old cursors become invalid after successful refresh. ChatGPT message branches and Codex item order are retained. Missing content in public shares, including any withheld tool activity, cannot be reconstructed. Local Codex UUID reads use the configured Worker-local `codex.home` (default the user's `~/.codex`) and do not resume or modify Codex sessions.

**Network behavior:** Share imports inherit the selected Worker's hot-reloaded child proxy mode and CA bundle, just like shell commands. In direct mode the Python reader explicitly disables Windows system proxy fallback. An optional per-import `proxy` can override the Worker mode. Without this inheritance the isolated Python subprocess can time out even when regular web requests succeed.

**Version-skew guard:** each Worker advertises `capabilities.conversation`. The Controller rejects calls to Workers that do not advertise the method without sending an unknown RPC that would trigger `unknown_method` quarantine. Matching Git commit IDs alone do not prove running code matches if either checkout has uncommitted changes or a Worker was not restarted.

Full contracts and examples: `tools/conversation/README.md`.

### Bundled specialized capabilities

CCM exposes optional specialized workflows as ordinary peer tools alongside its core execution tools.

- `ccm-extra.publish` publishes one Controller Plan (`{plan_id}`) or Worker file (`{workspace_handle, path}`) at a time. The modes are mutually exclusive: a Plan never requires a Worker connection or local intermediate file. Each call returns `structuredContent.download_url` for an immutable snapshot; a later Plan change requires a new publication. For Markdown (including Plans), `preview_kind: markdown`, `preview_url`, and a bounded `markdown_preview`/`markdown_truncated` render the card and full isolated HTML page while `download_url` retains the original `.md`. Other verified UTF-8 text has `text_url`, `text_preview` (up to 8 KiB) and `text_truncated`; raster images, PDF, audio, video and isolated markup have their own `preview_kind` and `preview_url`. Every file has a download link. Non-Markdown full text returns plain text; Markdown/HTML/SVG previews run under a restrictive CSP. There is no Office conversion or extra preview call. Host bridge links use `window.openai.openExternal`, with `ui/open-link` fallback. Keep the HTTPS download URL available when the client cannot open a card link. Published links expire within 72 hours (potentially sooner if the 1 GiB cache fills), and possession of the link grants access. `view_image` remains model-side only. No ChatGPT Library storage is involved.
- `ccm-extra.import_chatgpt_file` accepts one native attachment in its own `file` parameter. For Library files first materialize an authorized `raw_file`. The selected Worker streams the ChatGPT temporary HTTPS URL into a relative destination inside the context, with opt-in overwrite. Multiple imports must be sequential.
- `ccm-extra.transfer_path` is a peer tool for copying a regular file or a recursive directory between two existing CCM workspace handles. Supply `source_handle`, `source_path`, `target_handle`, and `target_path`. The source can be any path readable by its Worker (including an absolute path); the target must be relative to its own selected workspace. It never replaces an existing destination (even an empty directory), never deletes source data, and preserves empty directories. Existing destination collisions are rejected before file bytes are transferred. The destination is reserved first and may be visible/incomplete during transfer. Symbolic links/junctions and workspace escapes are refused.
- `ccm-extra.transfer_status({transfer_id})` reports file/byte progress and terminal state; `ccm-extra.transfer_cancel({transfer_id})` requests cancellation and safe cleanup. Transfers run in a Controller-owned task independent of the Controller result lifetime; terminal status is retained for up to 24 hours. On a failure, cancellation, or restart, cleanup removes only objects that can still be proven to belong to this transfer; unsafe or externally modified leftovers are preserved and reported. Initial version does not resume interrupted copies.
- File contents take the Worker A → Controller/WorkerHub → Worker B route as bounded, ordered 4 MiB Base64 chunks over the existing JSON-RPC WorkerHub connection (24 MiB message ceiling). Each chunk is acknowledged before the next, with socket backpressure, bounded task concurrency, source change checks, and full-file SHA-256 verification. File contents are neither exposed in ChatGPT tool results nor placed into the Controller's public download cache. WorkerHub's underlying TCP protocol is not itself TLS; remote link encryption depends on the deployment (for example Tailscale/WireGuard). No extra HTTP listener, certificate, port forwarding, or Tailscale-specific address is required by this tool. Both Workers must be connected to the same Controller.
- `ccm-extra.quark_upload` is a peer tool, submits one or more files through that local Quark desktop session, and can wait for verified completion.
- `ccm-extra.bilibili_download_dash` uses BMGCTL in the logged-in Bilibili browser on 6v to select real account-authorized DASH representations, then a one-shot localhost `tools/bilibili-download/bridge.py` to hand signed URLs and selected video height into an ignored local file. BMGCTL redacts signed URLs in tool results: do not pass these through the model. The browser currently rejects loopback CORS requests: POST a JSON body using `mode: 'no-cors'` and `Content-Type: text/plain`, then **require `BRIDGE_RECEIVED`** from the local Bridge (an opaque browser response cannot confirm success). Invoke the tool with **required `browser_tab_id`** from `get_windows_and_tabs` and `output_path` as a filename (e.g. `video.mp4`, not an absolute path), plus optional timeout. **Before downloading**, `pause_video.py` verifies the exact Bilibili tab and automatically pauses/acknowledges its video elements via BMGCTL; missing tab, browser outage, or unverifiable pause **fails closed before transfer**, and the one-shot handoff is deleted. BMGCTL subprocess output must be decoded as UTF-8 on Windows. The 6v projectless Worker writes the MP4 inside the returned `workspace_root`; use the returned `workspace_handle` to access or publish it subject to the Controller file-size limit. Python downloads with curl.exe, remuxes via `ffmpeg -c copy`, checks resolution and audio with ffprobe. Verified a 1920x1080 HEVC + AAC MP4 with automatic pause in a real logged-in 6v browser on 2026-11-05. See `tools/bilibili-download/README.md`.

All specialized tools are direct MCP peers. The Host handles their selection and orchestration. Continue live process sessions directly with `write_stdin`.

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
The Codex-native TOML is declared under `codex.native_sandbox_toml` in the
root `ccm.config.json`, with a non-secret template in `ccm.config.example.json`.
The trusted runtime helper writes those exact bytes to
`%LOCALAPPDATA%\\CCM\\CodexSandbox\\config.toml`, without modifying the
interactive user's `%USERPROFILE%\\.codex\\config.toml`. This native config
is exercised by the isolated execution tests; it is not yet the production
Worker default.

**Not deployed:** CCM still uses its existing Windows native sandbox and approval
logic. Neither Worker has been switched to the upstream Codex runtime. Until
the entire decision chain is integrated and tested, do not call the CCM sandbox
Codex-equivalent. The owner-approved local administrator agent is a separate
CCM execution path; it is not claimed to reproduce Codex sandbox semantics.

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
`CURL_CA_BUNDLE` override from `ccm.config.json` (`worker.env` / `worker.child_env`) are applied afterward. Other
platforms continue using the Worker's inherited environment. The Windows registry
must be readable when starting a new command; errors are reported rather than
silently executing with an outdated environment.

CCM runs as the signed-in **ordinary Windows user**, not as an administrator.
`scripts/install-ccm-autostart.ps1` and `scripts/install-ccm-worker-autostart.ps1`
register the Controller group and Remote Worker scheduled tasks with `RunLevel
Limited`. They start at logon, retry on failure and supervise their own child
processes. Keep `CCM_PERMISSION_PROFILE=workspace-write` to restrict ordinary
command writes to the selected project. Explicit Full Access grants and trusted
unsandboxed commands use the **ordinary Worker's** Windows identity; they do not
acquire administrator rights automatically.

**Administrator execution (owner-approved CCM adaptation):** Run
`scripts/install-ccm-admin-agent.ps1` **once from an already elevated PowerShell**
on each Windows Worker machine. The installer creates a random private IPC key
under `.state`, restricts its file ACL to the account, Administrators and SYSTEM,
registers a separate `CCM Administrator Agent` Task Scheduler job with `RunLevel
Highest`, and starts it. The agent checks that its own token is elevated before
opening a random-port local TCP listener bound **only to 127.0.0.1**. Its
endpoint file is stored under `.state` and the ordinary Worker uses the
existing 256-bit secret to authenticate every IPC connection before forwarding
precisely a command invocation and its environment; the agent
streams stdout/stderr, handles stdin and cancellation, and returns an exit code.
The Worker never receives the administrator token. Missing agents, invalid keys
or broken connections fail closed rather than running as a different user.

To explicitly invoke it, set `run_as_admin=true` on `exec_command` with a valid
`workspace_handle`. The Controller freezes the exact command, Worker,
Workspace and administrator execution mode, then requests one-time approval:
Guardian decides first when enabled; its refusal blocks dispatch, and review
errors fall back to the human approval card. If Guardian is disabled, human
approval is required. An approval never persists an administrator Allow rule.
The approved command runs with full administrator permissions and **no workspace
write boundary**.
Only explicit parameter use selects the agent; no command matching or sandbox
failure should trigger an automatic administrator retry. The option cannot
combine with `sandbox_permissions=require_escalated`, `prefix_rule` or
`full_access_grant_id`; neither ordinary Full Access nor a saved Allow rule
authorizes administrator execution. `apply_patch` is not privileged.

To repair or upgrade an administrator agent that cannot be reached through
`run_as_admin=true`, execute `scripts/install-ccm-admin-agent.ps1` **from an
independent, elevated Windows PowerShell on that machine**. The installer
stops the registered task, removes only stale agent Node processes launched
from this installation, replaces the task, and verifies the new elevated
loopback endpoint before reporting success. Do **not** run this recovery
installer through the administrator agent itself: stopping the agent would
also terminate the command connection. A CCM ordinary-command sandbox
approval does not elevate the Windows account token and cannot repair an
inaccessible `Highest` task.

**Deployment order (both 6v and noha):** Install and test the separate elevated
agent **before** replacing the currently scheduled CCM tasks; then run the
relevant normal-task installer, restart that scheduled task and check that its
actual principal is `Limited`. Test ordinary Git/Node/Python, a denied
outside-project write and an explicitly elevated command. Reinstalling the
scheduled tasks changes their saved principal; editing the scripts or using
`ccm.restart` alone does not. Keep a recoverable session on each machine until
the normal Worker reconnects. A Task Scheduler administrator authorization may
be required for one-time installation. Each subsequent administrator command
requires Guardian or human approval.

For a host where the administrator agent is already installed, run
`scripts/complete-ccm-privilege-split.ps1 -Role RemoteWorker` or
`-Role Controller` through `exec_command(run_as_admin=true)`. The script
preflights the elevated agent and delegates the actual service restart to an
independent temporary scheduled task, which records its recovery/rollback in
`logs/ccm-privilege-switch.log`.
The switch verifies that the old scheduled task has exited before starting the
new instance; the Controller Supervisor also waits for the previous global
mutex owner to exit and logs native-build failures before the main loop.

For an assistant-operated restart use `ccm.restart` rather than `exec_command`/`taskkill` or any command-prefix authorization. Its input is restricted to `{ "component": "controller_service_group" | "worker", "environment_id": "<registered id>" }`. The Controller checks `ccm.config.json` (`restart_allowlist`) on **every request**, requiring exact environment IDs in `controller_service_groups` or `workers` (no wildcard). The Controller group may only target the locally supervised Controller identity; a Worker request may only target an actively connected, healthy registered Worker. Neither action accepts an executable, shell, script, PID, path, nor arbitrary arguments; no `exec_command` or approval-policy permissions are created. Add new Worker identities by updating the allowlist, without changing code or restarting the Controller. Invalid/missing configuration fails closed.

The dedicated restart RPC makes the supervised target exit after acknowledging the request. `ccm-supervisor.ps1` restarts the Controller, local Worker and OAuth sidecar as a group; `ccm-worker-supervisor.ps1` or `LocalWorkerSupervisor` restores an individual Worker. Controller service-group restart checks the existing Supervisor-owned gateway parent PID; remote-Worker restart checks the Supervisor-owned Worker PID; the local Worker uses its Supervisor launch marker. Processes without verified supervision reject restart. An accepted response means **requested, not recovered**: after the relevant reconnect, independently verify Controller health, Worker normal state, and OAuth sidecar health. The Controller connection will be interrupted when restarting its service group. The installer scripts manage startup, not routine restart; do not alter Task Scheduler configuration just to issue a restart.

主动重启现已增加停止期限：Worker 在停止清理完成后明确退出，清理超过 10 秒则以失败状态退出，避免残留句柄使旧进程永久存活。本地 Supervisor 只在白名单重启请求成功受理后设置 15 秒停止期限；届时只终止其仍拥有的旧子进程，收到退出事件后才启动替代进程。普通网络断线仍由 Worker 自行重连，不触发此强制终止。远端 Worker 同样使用上述 10 秒退出兜底，其现有 Supervisor 负责重新启动。

`ccm.restart` initiates an asynchronous Worker restart, with duplicate in-flight restart requests coalesced by the Controller. Check `ccm.list_projects` before and after restarting: successful recovery requires a normal Worker state with a new `connected_at` timestamp, not merely the old connection still reporting online. A Worker absent from discovery has not yet reconnected; timeouts and errors must not be reported as success. Controller service-group restarts additionally require separate Controller, OAuth, and Worker health checks.

For a Controller machine that should run the Controller, its local Worker, and the OAuth sidecar as one service group:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-ccm-autostart.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\ccm-status.ps1
```

Remove it with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-ccm-autostart.ps1
```

For a standalone Windows Remote Worker, create its machine-local root
`ccm.config.json` from the tracked `ccm.config.example.json` and customize
`worker.env`, `worker.child_env` and `codex.home`. The root JSON is the only
CCM runtime configuration; each machine keeps its own ignored file.

Set at least `CCM_WORKER_HUB_CONNECT_HOST`; normally also give the Worker a stable `CCM_ENVIRONMENT_ID`. `CCM_WORKSPACE` is a Worker bootstrap workspace seed and is not a GPT-visible default project. Then install and inspect the Worker task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-ccm-worker-autostart.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\ccm-worker-status.ps1
```

Remove it with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-ccm-worker-autostart.ps1
```

The Remote Worker supervisor reads root `ccm.config.json` itself, builds the native helpers on startup, and launches `src/worker/agent.mjs`. The Worker agent owns connection retry/reconnect behavior, so temporary Controller/network loss does not cause a process restart. `ccm.config.json`, PID files, and supervisor logs are local runtime state and are not committed.

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

The public MCP resource is `https://<host>/ccm/mcp`. Runtime OAuth configuration is stored under `controller.env` in ignored root `ccm.config.json`; OAuth tokens/state and the local approval secret remain under ignored `.state/`.

Funnel is CCM's public **ingress/control path** only. It lets a remote MCP client continue reaching the OAuth sidecar and Controller even when a Worker's ordinary outbound proxy is unhealthy, but it is not a SOCKS proxy, HTTP CONNECT proxy, NAT gateway, or general egress service. A Worker child process such as `git`, `curl`, `npm`, or `pip` creates its own outbound connection and cannot route that new connection "back through" Funnel. Child-process egress is controlled independently by the proxy/direct mode described below.

仅在 Controller `/ccm/health`、OAuth 网关 `/health`、本地 MCP 调用及 Worker 状态均正常，但 Host 调用 CCM 持续报连接失败或 `-32603 Internal error`，且 OAuth 网关没有对应请求日志时，可尝试在 CCM 入口所在的 Windows 机器上以管理员身份打开 PowerShell，执行 `Restart-Service -Name Tailscale` 重启 Tailscale 系统服务；仅退出并重开任务栏程序不足以重启该服务，恢复以真实 Host 工具调用成功且网关出现对应成功请求日志为准。

### ChatGPT MCP tool refresh

When any peer tool is introduced or its schema/description changes, restart the CCM Controller and refresh the ChatGPT CCM tool definitions. A new conversation or account reconnection alone may leave cached definitions.

1. Verify the running Controller responds to MCP `tools/list` with the intended complete tool inventory.
2. In ChatGPT **Settings → Plugins → CCM**, select **Refresh tools (刷新工具)**.
3. Confirm that ChatGPT can see and call the refreshed tools. A successful server response alone does not prove the Host updated its cache.

Refresh does not require recreating the connector or disclosing protected OAuth secrets. Initial plugin installation/OAuth consent remains a separate procedure.

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

### Worker child-process CA configuration

Each machine uses one Git-ignored root `ccm.config.json`. Worker bootstrap variables
(`CCM_*`) reside in the `worker.env` object, and a machine-local absolute
`CURL_CA_BUNDLE` path may be provided in `worker.child_env`. The Worker supervisor
reads bootstrap variables at startup. The native executor re-reads
`worker.child_env` for every new pipe or PTY command. The CA override is
applied **before** Codex `shell_environment_policy`, so that policy may
exclude or override it. Invalid entries and absent CA files fail the command;
neither OAuth nor Controller credentials are injected into shell children.

### Single CCM configuration file

`ccm.config.json` in the CCM repository root is the only active CCM
configuration file. It is ignored by Git and intentionally differs between 6v
and noha. `ccm.config.example.json` is the version-controlled template, not
an additional runtime config. The schema groups `controller.env`, `worker.env`,
worker.child_env, restart_allowlist, worker_quarantine_errors, codex.home and codex.native_sandbox_toml are grouped under version: 1. Command authorization is stored separately as a standard Codex Starlark .rules file under the protected Controller state directory, not in the machine config. Credential and session data remain separate in private state/secrets files and are not embedded in the version-controlled template.
`worker_quarantine_errors`, `codex.home` and
`codex.native_sandbox_toml` under `version: 1`. Credential and session data
remain separate in private state/secrets files and are not embedded in the
version-controlled template.

The restart-allowlist section is read for each restart request. The quarantine error section is hot-reloaded; on an invalid live edit it retains the last valid selection.
authorization or restart request, respectively. The quarantine error section is
hot-reloaded; on an invalid live edit it retains the last valid selection.
An invalid configuration at startup fails closed. For the native Codex
sandbox staging, the trusted Worker bootstrap materializes
`codex.native_sandbox_toml` inside the isolated Codex runtime Home and
rejects mismatched pre-existing bytes; the interactive user's Codex configuration
remains untouched. The `codex.home` setting is **only** the historical Codex
sessions directory for the conversation reader (default user `~/.codex`).

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

apply_patch enforces its own workspace-write boundary on the Worker, including real-path checks that reject symlink/junction escapes. Ordinary exec_command remains inside the selected environment sandbox unless the live native Codex .rules policy returns Allow, a separately hash-bound package-script rule matches, a one-shot approval is consumed, or a timed Full Access grant is supplied. Prompt use the approval card; Forbidden is rejected before dispatch; unmatched commands keep the normal sandbox path. The policy file is stored under the protected Controller state directory and parsed by the unchanged upstream Rust engine on every decision.

Matched command rules grant **unsandboxed execution**, not merely network/filesystem exceptions. Git hooks/helpers/configured transports and test modules run with the Worker's normal host permissions, not within its workspace-write sandbox.

The initial migrated Codex policy contains exact token prefixes for Windows Git clone, fetch, pull, push, and ls-remote, node --test, npm run build:native, plus absolute-path rules for the installed Tailscale and TeX Live executables. These standard global Codex prefix rules are shared across Workers and workspaces; suffix arguments have the same scope as any other Allow prefix. The npm rule covers only npm run build:native, not unrelated npm scripts or npm install.

For PowerShell, the unchanged upstream Codex Tree-sitter lowerer supplies executable tokens. The owner-approved literal wrapper recognizer additionally supports static & calls and literal $env:NAME assignment prefixes for policy matching; dynamic expressions remain opaque. Every executable segment in a compound command must receive Allow. The native .rules policy is the sole general command authorization source.

**6v TeX authorization migration (2026-11-11):** the former absolute-path xelatex.exe trust and saved xdvipdfmx.exe prefix are represented in the native Codex .rules policy. The xelatex prefix is pinned to C:\texlive\2026\bin\windows\xelatex.exe; it authorizes that exact executable path and suffix arguments, not a bare PATH alias. A prior real one-page PDF compile succeeded under the former rule; the migrated rule is covered by the native policy tests. Tailscale likewise uses its exact installed absolute path; bare aliases are no longer rewritten.

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

The approval flow below applies to restricted permission profiles. Restricted Workers support an explicit one-shot escalation flow through `exec_command(sandbox_permissions=require_escalated)`. The model supplies the exact command, `workspace_handle`, optional working directory/shell/TTY settings, output/yield settings, user-facing justification, and optionally a reusable ordered-token `prefix_rule`. If no built-in, trusted package script, or saved global Allow rule matches, CCM parses the command conservatively, validates/freezes the proposed persistent prefix, freezes the exact execution into a `PendingAction`, assigns an `approval_id` and `operation_id`, and returns without executing the command. The model then calls the `request_approval` tool with only that opaque `approval_id`; `request_approval` binds the pending action to the approval card but cannot change the frozen command, prefix or execution context. A `full-access` environment executes the requested command directly under normal Worker host permissions and does not create an execution approval.

The approval card receives a high-entropy approval capability only through tool-result `_meta`; that secret is not placed in `content` or `structuredContent`. For execution approvals the card displays the frozen workspace/environment/command/justification. **Always allow** is shown only when the Controller has frozen a valid persistable command prefix, and the card explicitly indicates its global scope across Workers and workspaces. **Approve once** and **Deny** remain available independently. For workspace entry/registration the card displays the frozen environment/workspace/root/action and offers only **Approve** or **Deny**. The app-only `resolve_pending_action` resolver accepts only `approval_id`, the card capability, and the user's decision; it does not accept a replacement command, prefix, workspace target, workdir, shell, or TTY value.

On Approve, CCM resumes the already-frozen action directly. There is no second model decision and no model-generated retry of the command. The grant:

- is valid for the configured approval lifetime (3 days by default),
- is atomically dispatchable only while the frozen approval is in an allowed state,
- is bound to the environment, workspace handle/root, command, working directory, shell, TTY mode, and execution output/yield settings,
- runs that one command with `full-access`,
- cannot be reused after execution.

After a terminal approve or deny result, the approval App separately hands that result back to the conversation. It first writes the bounded final result into model context, then triggers exactly one follow-up turn. Standard MCP Apps `ui/message` is preferred when the initialized Host advertises text-message support; the ChatGPT `sendFollowUpMessage` compatibility alias is only a fallback for missing or explicitly failed standard messaging. A successful standard message response is treated as authoritative and is never followed by the alias, preventing duplicate turns. If context handoff or both continuation routes fail, the server-side approval result remains final and the card reports that the user must send a message to continue; CCM never reruns the frozen action merely to recover conversation continuation.

**Always allow** executes the current frozen action through the same approval state machine, then appends a global ordered-token prefix_rule to the Controller native Codex .rules file using the upstream file-locked persistence function. The saved rule has no environment, Worker, workspace, workdir, Shell or TTY binding. On later ordinary exec_command calls, the Controller evaluates the native policy before the first execution and dispatches matching commands with Full Access; the model does not need require_escalated. The one-shot approval action itself remains frozen to its original Worker, workspace, command and settings.

Controller model instructions and the `exec_command` description encourage a reusable `prefix_rule` whenever a repeated build, test, or development command genuinely needs escalation. A useful prefix keeps stable executable/subcommand/script path/invariant options and leaves varying suffix arguments outside the prefix: e.g. `npm run build:native` proposes `["npm","run","build:native"]`. The model must not offer a bare general-purpose interpreter such as `powershell`, `cmd`, `pwsh`, or `node` as a persistent prefix. A `prefix_rule` is valid only with `require_escalated`; the user sees the exact proposed global prefix before choosing **Always allow**.

Prefix matching is token-based, not raw-string startsWith. A rule [git, config, --get] matches git config --get user.name but not git config --global --get user.name. Suffix tokens are intentionally covered. Compound commands reuse Full Access only when each executable segment is allowed, with no special authorization needed for a literal $env: prefix or static PowerShell & wrapper. When saving a rule, repeated identical executable segments can share one exact prefix, and a partially authorized compound with only one distinct missing command automatically proposes that missing command as the persistable prefix; other multi-command requests still require an explicit applicable prefix or one-shot approval. The card always displays the exact global rule before saving.

The Tailscale rule is an absolute executable-path prefix pinned to C:\Program Files\Tailscale\tailscale.exe. Invoke that exact path to match it. The former CCM alias-rewrite path has been removed: bare tailscale/tailscale.exe commands do not inherit the pinned-path Allow. Compound commands still require an Allow for every executable segment; no special shell rewrite or pipe-denial hint is added.

For WSL this can intentionally be broad. A user-approved `["wsl.exe"]` prefix automatically authorizes subsequent WSL invocations in any workspace on any Worker, with arbitrary suffix arguments, including Linux-side writes, package management, networking, services, or root commands reachable through WSL. A narrower `["wsl.exe","-d","PhD-CFD"]` prefix restricts matching to that distro selector. The Linux command inside `bash -lc '...'` is opaque suffix data to the outer Windows prefix matcher.

The independent trusted-package-script store remains hash-bound to an exact workspace/script, using the current `package.json` script SHA-256. This separate mechanism does not change the scope of user-saved global command Allow rules.

Saved global Allow prefixes are checked for ordinary `use_default` commands as well as explicit escalation requests. Once a rule is saved, matching WSL or build invocations therefore run with Full Access on their first attempt, without a preliminary sandboxed failure.

If CCM can prove a failure occurred before Worker dispatch, the same frozen action may be presented for retry with the same frozen prefix scope. If a timeout/disconnect makes it uncertain whether the Worker started the command, the approval enters `execution_unknown`; CCM will not retry automatically and saves no policy. If execution succeeds/starts but persisting **Always allow** fails afterward, the action remains consumed: CCM reports the policy-save failure and does not rerun the command merely to retry persistence. Denied, consumed, unknown-outcome, and expired requests cannot start another execution.

For restricted profiles, workspace entry/registration uses the same card capability and one-shot state model, but it never grants `full-access` and never creates an execution allow rule. On approval CCM re-reads the registered workspace or re-inspects the registration path, verifies that the frozen environment/workspace/root still match, then creates the registered `workspace_handle`. If the target has drifted, the frozen action fails closed and is consumed so a new approval is required. A pending workspace action blocks only continuation that depends on that same current intended target: after calling `request_approval`, the model waits rather than continuing that project through a projectless workspace or retrying the same target. If the user explicitly corrects or changes the intended project, the old approval becomes superseded orchestration state but remains an independent valid pending action until resolved or expired; the model may request entry/registration for the new project only when explicitly authorized by the user and no usable handle exists, without requiring the user to Deny the old card. Multiple workspace approvals can therefore coexist with distinct `approval_id` values, and approving an older card creates only that older target's own `workspace_handle`; it does not change which project the model should treat as current. In a `full-access` environment, `select_workspace` and `register_workspace` perform the same identity/path revalidation and context creation directly without creating an approval request.

There is no model-driven approval retry path and no public text-decision approval endpoint. When an action requires approval, CCM freezes that action and returns an opaque `approval_id`; `request_approval` renders the card, and the app-only `resolve_pending_action` consumes the frozen action after the user's decision. Full-access workspace selection/registration and execution do not enter this approval state machine, but deregistration always does.

This approval mechanism controls CCM's sandbox boundary; it does **not** grant Windows Administrator/UAC privileges. The approval app is the interaction mechanism, while the server-side frozen action, approval capability, state machine, and workspace revalidation remain the security boundary. If ChatGPT supplies its anonymous `openai/session` metadata on both calls, CCM also binds the request and app resolver to that host session as defense in depth.


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

`view_image` is a peer MCP tool and returns native MCP image content with source metadata and optional compression information in result `_meta`.


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
