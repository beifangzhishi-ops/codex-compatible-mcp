# Native Codex Elevated Sandbox — source-level integration

**Status (2026-11-06): staged, not production-ready.** CCM's experimental
Windows sandbox now targets the native Codex Rust library rather than an
externally installed Codex CLI. The native executable has not yet compiled
successfully in the restricted 6v Worker, and privileged end-to-end acceptance
remains outstanding on both machines. The ordinary CCM Worker is unchanged.

## Normative upstream baseline

- Source repository: `openai/codex` at Git commit
  `f79b26ccbb3116b052544666a181012fb45dc49b`
  (source-review SHA, **not an installed CLI version requirement**).
- The source is a Git submodule at `vendor/openai-codex`; its code retains
  OpenAI's Apache-2.0 license. `npm run build:codex-native` requires the
  submodule's `codex-rs` source tree to be checked out.
- No modifications have been made to the upstream ACL, account, Windows
  token, WFP, IPC, PTY or process-lifetime code.
- The additional `native/codex-native-sandbox` binary is a CCM
  transport/launch adapter only, not a replacement Windows sandbox.

## Source API mapping

| Lifecycle stage | Upstream source / function | CCM integration |
| --- | --- | --- |
| Profile selection | `codex-rs/protocol/src/models.rs`: `PermissionProfile::workspace_write_with`, `read_only`; `config/codex/config.toml` | Map CCM workspace-write to the upstream workspace+network-enabled profile and read-only to Codex read-only |
| Workspace binding | `codex-utils-absolute-path`, `PermissionProfile::materialize_project_roots_with_workspace_roots` | Pass the registered root and the command cwd separately |
| Native preparation | `codex-rs/core/src/windows_sandbox.rs::prepare_elevated_sandbox` | Call `sandbox_setup_is_complete`, `run_elevated_setup`, then `run_setup_refresh` in upstream order |
| Protected reads | `codex-rs/cli/src/debug_sandbox.rs::run_command_under_windows_session`; `resolve_windows_deny_read_paths` | Resolve exact upstream deny paths from the materialized filesystem policy |
| Elevated process spawn | `codex-rs/windows-sandbox-rs/src/unified_exec/mod.rs::spawn_windows_sandbox_session_for_level` | Launch with `WindowsSandboxLevel::Elevated` and upstream `WindowsSandboxSessionRequest` |
| Pipes/PTY/cancellation/exit | `src/unified_exec/backends/elevated.rs`, `src/stdio_bridge.rs::forward_sandbox_session_stdio` | Delegate to original native async session, input/output and termination implementation |
| Windows helper binaries | `codex-rs/windows-sandbox-rs/src/bin/{command_runner,setup_main}` | Build `codex-command-runner.exe` and `codex-windows-sandbox-setup.exe` from the same upstream commit |

CCM's Node backend `src/runtime/sandbox/codex-windows-sandbox.mjs` builds
arguments for the **CCM-owned**
`native/bin/ccm-codex-native-sandbox.exe`, the two adjacent upstream helpers,
and a separate protected `CODEX_HOME`. It does not search the Codex Desktop
installation, use `PATH` to find Codex, or call `codex.exe`.

`createWorkerRuntime({ codexSandbox: true })` selects this backend only
when explicitly requested. Full Access keeps the upstream unsandboxed launch
contract. Unsupported CCM-only permission profiles do not pass to the native
sandbox. Regular `npm run build:native` and production Worker startup do not
build or select this staged backend.

## Native build and validation

Run `npm run build:codex-native` in the project after fetching the submodule.
The separate build entrypoint compiles the upstream setup and command runner
plus `native/codex-native-sandbox` and publishes all three under
`native/bin`. The independent Cargo manifest reproduces the upstream
Git-patched versions of `crossterm`, `tokio-tungstenite`, and `tungstenite`.
Its Cargo dependency metadata resolves successfully.

**Current blocker:** Cargo tries to fetch `mio v1.2.0` from crates.io but
Schannel in the restricted 6v Worker returns
`SEC_E_NO_CREDENTIALS`. The offline check also fails because that crate is
not cached. The check never reached source compilation, so no new native
executable is verified. No custom SSL bypass, fallback to an external Codex
CLI, unapproved sandbox relaxation or fake binary is used to overcome this.

The isolated JavaScript validation ran with:
`node --test --test-isolation=none` on
`test/codex-windows-sandbox.test.mjs`,
`test/native-executor-proxy.test.mjs`,
`test/codex-runtime-home.test.mjs`,
`test/codex-elevated-terminal.test.mjs`, and
`test/codex-elevated-containment.test.mjs`.
Result: **19 total, 15 passed, 0 failed, 4 intentionally skipped**. These
verify native argument selection, full access bypass, workspace validation,
ConPTY transport and fail-closed missing-binary diagnostics; they do not
prove the Rust binary works.

The 6v full Node regression run reported **350 total: 343 passed,
2 failed and 5 skipped**. The two failures came from the existing
`test/runtime.test.mjs` native Windows sandbox checks: a nonzero command exit
and an inside-workspace write returned no `exit_code` within their initial
wait. A follow-up with a longer wait did not reliably resolve the issue, and
that experimental test edit was discarded. The ordinary CCM native sandbox
has not been modified by this branch. Some focused tests also require
`TEMP`/`TMP` within the writable worktree, because the restricted Worker
cannot create files in the system temp directory (`EPERM`). With an in-tree
test temp directory, the focused 19-case result above was reproduced.
These facts are **not** a full-suite green result.

## Native acceptance and security scope

Before the production Worker is switched, complete these checks on **both**
6v and noha under appropriately trusted Windows hosts:

1. Build all three same-source Rust executables successfully, run the Rust
   argument and upstream Windows tests, verify helper materialization.
2. Provision native sandbox users, ACLs, DPAPI credentials and WFP policies
   through the upstream code; verify the Worker never inherits unrestricted
   administrator permissions.
3. Permit writes inside the registered workspace (including sibling folders
   when the cwd is nested); deny ordinary, non-hardlinked outside-file writes
   and check read-only restrictions.
4. Verify PowerShell, Python, Git and other subprocesses, output/exit status,
   interactive PTY, sequential stdin, Ctrl+C, termination and no surviving
   writes by cancelled process trees.
5. Verify online/offline network policy, proxy behavior, profile inheritance,
   error semantics, Controller approvals and authorization persistence.
6. Check two-machine configuration consistency, native binary versions, service
   health and reconnect behavior after any separately approved rollout.

Opt-in real-host tests:
`test/codex-elevated-execution.test.mjs`,
`test/codex-elevated-containment.test.mjs`, and
`test/codex-elevated-terminal.test.mjs`.
The privileged tests are skipped during normal CCM testing.

The owner has explicitly accepted upstream Codex's NTFS hardlink behavior as
an **accidental-write protection** limitation: a hardlink inside a writable
workspace can cause the upstream setup to grant its sandbox account access to
an outside target. Previous disposable-source/native-CLI experiments on 6v
demonstrated this behavior, and an ordinary outside-file write was denied.
Those earlier probes **do not** validate the new library-based launch adapter.
Do not fork upstream sandbox enforcement to patch the accepted limitation,
and do not describe it as a malicious-actor-proof security boundary.
