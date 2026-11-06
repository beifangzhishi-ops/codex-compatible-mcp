# Codex Windows Elevated Sandbox: upstream parity baseline

> **Status: isolated native CLI adapter and native-host probes; deployment requires functional validation.**
> Owner-approved safety goal: protect against accidental modification of important files using upstream Codex semantics, not defend against malicious processes or guarantee absolute outside-workspace confinement. Upstream hardlink behavior is accepted; do not fork Codex for this issue.

## Reviewed upstream source baseline (not a CLI version constraint)

- Repository: `https://github.com/openai/codex`
- Tag: `rust-v0.166.0-alpha.5.1`
- Annotated tag object: `b9d5adaac47e7bf474ebdafa95c7ee96724b3eeb`
- **Commit (authoritative): `f79b26ccbb3116b052544666a181012fb45dc49b`**
- Platform: native Windows.
- These source identifiers document which Codex implementation was reviewed; the executing CLI **does not have to match this tag**. CCM selects the newest complete installed CLI, including its colocated command runner and setup helper. Any CLI syntax/config compatibility problems must be corrected based on actual behavior and tests, not handled by requiring an old version.
- Source reviewed in a pinned shallow, sparse checkout at `.cache/codex-upstream` in the primary CCM worktree; that checkout is ignored and is not part of the deliverable.
- The Git submodule records the reviewed source commit, independently of the executing CLI version. Its checkout is not required by the staged native CLI adapter. On 6v, a post-merge `git submodule update --init --depth 1` in the restricted CCM Worker failed in Git's `sh.exe` with `Win32 error 5`; the gitlink remains tracked and source checkout is unverified in this execution context. No additional sandbox grant was requested.

## Complete upstream decision chain to reuse

| Concern | Exact upstream sources at pinned commit | Existing CCM implementation to replace/align |
| --- | --- | --- |
| Configuration schema, layer precedence, profile resolution | `codex-rs/config/src/config_toml.rs`; `codex-rs/core/src/config/mod.rs`; `codex-rs/protocol/src/models.rs` | `config/worker.env`; `src/runtime/environment-registry.mjs`; `src/runtime/sandbox/sandbox-policy.mjs` |
| Permission and sandbox selection | `codex-rs/sandboxing/src/manager.rs`; `codex-rs/sandboxing/src/windows.rs`; `codex-rs/core/src/windows_sandbox.rs` | `src/runtime/remote-process-manager.mjs`; `src/runtime/process-manager.mjs` |
| Provisioning, elevation and sandbox users | `codex-rs/windows-sandbox-rs/src/setup.rs`; `src/identity.rs`; `src/dpapi.rs`; `src/setup_provisioning.rs` | `native/windows-sandbox/CcmSandboxRunner.cs`; CCM Supervisor/Worker startup |
| Filesystem permissions and protected roots | `codex-rs/windows-sandbox-rs/src/workspace_acl.rs`; `src/acl.rs`; `src/deny_read_acl.rs`; `src/resolved_permissions.rs` | CCM synthetic capability SID and `EnsureWorkspaceWriteAce` |
| Windows token, default DACL and user identity | `codex-rs/windows-sandbox-rs/src/token.rs`; `src/identity.rs` | `CreateRestrictedToken` in `CcmSandboxRunner.cs` |
| Command runner, IPC, stdout/stdin and cancellation | `codex-rs/windows-sandbox-rs/src/elevated_impl.rs`; `src/elevated/`; `src/bin/command_runner/`; `src/process.rs`; `src/stdio_bridge.rs` | `src/runtime/sandbox/native-sandbox.mjs`; `src/runtime/executors/native-executor.mjs`; PTY/process sessions |
| Online/offline network enforcement | `codex-rs/windows-sandbox-rs/src/wfp.rs`; `src/wfp_setup.rs`; `src/setup_provisioning.rs` | CCM's child proxy environment and no equivalent Windows identity-based network sandbox |
| Direct command sandbox CLI and metadata | `codex-rs/cli/src/debug_sandbox.rs`; `codex-rs/codex-mcp/src/sandbox_metadata.rs` | CCM's `exec_command` Controller-to-Worker adapter |
| Approval and persistent allow/deny semantics | `codex-rs/core/src/exec_policy.rs`; `codex-rs/protocol/src/models.rs` | CCM `exec-policy-store`, trusted-command policy and approval workflow |

Only GPT Host/MCP transport adaptation is exempted from matching Codex. A matching-looking token flag or isolated ACL patch does not satisfy the upstream parity rule.

## Host configuration findings

- The 6v personal Codex config uses `sandbox_mode = "workspace-write"`, `approval_policy = "on-request"`, `[windows] sandbox = "elevated"` and `[sandbox_workspace_write] network_access = true`.
- The noha personal Codex config currently selects `[windows] sandbox = "unelevated"`. CCM cannot read both hosts' personal configurations and claim the same Elevated Sandbox policy.
- 0.166 CLI's `codex sandbox` debug entrypoint requires a named `--permission-profile`; a direct invocation with the user's legacy TOML and `--permission-profile workspace-write` rejected the config with “default_permissions requires a [permissions] table”.
- A separate **native Codex** `config.toml` using `default_permissions`, `[permissions]` and `[windows] sandbox = "elevated"` passed parsing, but launching the nested sandbox from inside CCM's existing restricted-token process failed to open the privileged setup mutex. This is not an upstream sandbox failure in a properly privileged orchestrator.
- Do not copy personal Codex credentials, model-provider tokens or unrelated application settings into CCM's repository. A CCM-specific Codex configuration must use Codex's actual schema and dedicated protected runtime state.

## Staged native CLI adapter and real-host evidence (2026-11-05)

- `src/runtime/sandbox/codex-windows-sandbox.mjs` uses the **unmodified installed** `codex sandbox` CLI with a native named permissions profile and the upstream `permissions.<profile>.workspace_roots` TOML mechanism. The complete CLI, command runner, ACL setup and privilege model are owned by Codex; CCM does not duplicate them. The staged `createWorkerRuntime({codexSandbox:true})` path provisions a dedicated `CODEX_HOME` and selects the newest complete local CLI; it does not reject later releases merely by version. Production `src/worker/agent.mjs` has **not** been switched.
- `src/runtime/sandbox/codex-runtime-home.mjs` provisions `%LOCALAPPDATA%\\CCM\\CodexSandbox\\config.toml` from the exact native Codex TOML template, refuses to silently overwrite a different config, and leaves interactive personal Codex settings untouched. The actual native CLI has been tested with this dedicated home on 6v, which may need an initial sandbox-account, ACL and WFP provisioning pass.
- **Real execution-chain test passed on 6v:** an elevated Node test created a disposable workspace, used CCM's `ProcessManager` and `NativeEnvironmentExecutor` with `CodexWindowsSandboxBackend`, and received a normal exit code and the `CodexSandboxOnline` identity. Workspace write succeeded and an unrelated outside write was rejected. This also exercises the dedicated configuration path, standard output capture, and session polling. Formal opt-in regression is `test/codex-elevated-execution.test.mjs`.
- **Worker-runtime selection path passed on 6v during the initial host probe:** the formal test invokes `createWorkerRuntime({codexSandbox:true})`, which checks the installed CLI/helpers and provisions `%LOCALAPPDATA%\\CCM\\CodexSandbox`. It executes the same actual `ProcessManager → NativeEnvironmentExecutor → CodexSandboxOnline` path successfully. Initial provisioning may take tens of seconds because upstream configures sandbox users, workspace ACLs and WFP; a repeat run with the same home completed in approximately 2.4 seconds.
- The adapter requires a complete installation and chooses the highest semantic version available, without enforcing the source-audit tag as the runtime version. Equally recent duplicate installations fail with an explicit ambiguity error. A version update alone is not a reason to reject noha; actual runtime behavior still needs integration testing on that Worker.
- Verified via trusted admin-host execution on 6v: native `CodexSandboxOnline` process can write inside an isolated disposable workspace, including a sibling of its cwd, and rejects an ordinary write to a disposable outside file. `whoami /priv` listed only `SeChangeNotifyPrivilege`. These tests are not evidence about all filesystem aliases.
- **Hardlink escape, reproduced twice:** create a disposable file outside the chosen workspace, then an NTFS hardlink to that file inside the writable root before Codex initialization. The native Codex Elevated setup adds `CodexSandboxUsers:(I)(M)` to the outside file's ACL; a sandbox command can then overwrite the file using **either** the outside path or the inside hardlink. A before/after `icacls` probe confirmed the ACE change even when the command itself only queried `whoami`. Both paths and content were disposable and cleaned afterward.
- Relevant upstream: `codex-rs/windows-sandbox-rs/src/acl.rs` grants the write ACE and `src/setup.rs` provisions workspace ACLs. `src/file_write_tests.rs` tests atomic writes protecting the setup's own state files, but that does **not** protect arbitrary shell writes or ACL changes to linked workspace files. No general hardlink check was identified in the pinned ACL path; the next alpha tag's corresponding ACL files likewise show no obvious hardlink check (not proof of an exhaustive later-version fix).
- Manual upstream-behavior check: `test/codex-elevated-containment.test.mjs`, opt-in only for trusted Windows host testing. It must verify normal outside-path write denial and report the hardlink limitation rather than treating the known upstream behavior as a failure. Ordinary CI skips OS provisioning.

## Required integrated acceptance (not yet passed)

1. Both Workers discover their own complete Codex CLI and same-directory setup/command-runner helpers, regardless of CLI release. For any differing CLI behavior, verify the actual native interface and fix the adapter. Keep a documented upstream source baseline for comparisons, not a CLI version gate.
2. Trusted elevated provisioning creates or validates dedicated Online/Offline sandbox users, DPAPI credentials, read/write/deny ACLs, offline firewall rules and their versions. Ordinary commands never inherit the Worker administrator token.
3. The active workspace handle determines writable roots even if the command starts in a subdirectory. Ordinary outside-file writes are rejected, and protected project paths are protected as in upstream Codex. **Owner explicitly accepts the known NTFS hardlink ACL limitation; no custom hardlink enforcement or security patch.**
4. Reads, Python/venv, shell execution, Git, interactive stdin/PTY, output streaming, cancellation, process exit codes, service/IPC isolation, and network access match pinned upstream behavior. **Basic PowerShell pipe output and exit code passed on 6v; remaining cases still require full testing.**
5. Codex's config precedence, permissions profiles, failure semantics, approval/allowlist lifecycle and trust-boundaries are checked end-to-end. No legacy CCM-only semantics are silently retained.
6. Tests pass on both machines **before** replacing default CCM sandbox. Restart and health/reconnect verification follow a clean version-synchronized release; stop on any failure.

### Staged interactive terminal acceptance (2026-11-06)

The opt-in `test/codex-elevated-terminal.test.mjs` runs through the real
`createWorkerRuntime({ codexSandbox: true })` and
`ProcessManager → NativeEnvironmentExecutor → ConPTY proxy → native Codex sandbox`
chain, rather than simulating the sandbox with a fake child process. It checks:

- Two successive interactive stdin submissions, incremental PTY output, and a normal exit.
- Ctrl+C delivered to the live ConPTY session and confirmed termination.
- `terminateSession` stopping the process tree, verified by the absence of a delayed workspace marker.

It uses only disposable workspaces under the project's ignored `.cache`, keeps
the production Worker sandbox unchanged, and requires both Windows and the
explicit `CCM_RUN_CODEX_ELEVATED_TERMINAL=1` environment variable on a
**trusted elevated host**. Its three cases are *skipped* during ordinary CCM
test runs. **These three real-host checks have not yet passed on either
machine**: starting the native sandbox from the currently restricted CCM
Worker cannot provision its privileged Windows sandbox components.

`test/native-executor-proxy.test.mjs` separately verifies that the staged
Codex CLI receives the unaltered native argument vector and protected
`CODEX_HOME` through the ConPTY launcher, while stdin bytes (including Ctrl+C)
are forwarded to the proxy. This test is a transport contract check, **not**
evidence of a completed privileged native PTY integration test.

On 6v, the focused non-privileged suite returned **16 pass / 0 fail / 3
intentionally skipped** using Node's `--test-isolation=none`. A regular
`npm test` attempt was blocked before any test-file body executed because the
Worker sandbox denied spawning Node's test-file subprocesses (`spawn EPERM`);
those framework errors are not functional failures of Codex PTY. The attempted
process-internal *full* suite did not yield a usable completion result from
this Worker environment. Neither attempt counts as a complete regression
pass. The previously verified full-suite results from an earlier commit do
not cover these newly added tests.

## Explicitly unresolved

The upstream sandbox implementation is a multi-crate Rust subsystem with independently provisioned users and persistent OS policy. Simply replacing the current C# token flags or wrapping `codex sandbox` inside the current CCM sandbox does **not** deliver parity. Native upstream-code integration or a verified upstream runner in the trusted Worker execution layer is necessary. This research does **not** authorize deployment or a weaker fallback.
