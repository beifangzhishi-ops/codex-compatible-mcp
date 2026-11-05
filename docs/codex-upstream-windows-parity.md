# Codex Windows Elevated Sandbox: upstream parity baseline

> **Status: isolated native CLI adapter and native-host probes only; NOT deployed.**
> Do not enable the CCM sandbox substitution until the hardlink write-escape gate is resolved.

## Pinned upstream

- Repository: `https://github.com/openai/codex`
- Tag: `rust-v0.166.0-alpha.5.1`
- Annotated tag object: `b9d5adaac47e7bf474ebdafa95c7ee96724b3eeb`
- **Commit (authoritative): `f79b26ccbb3116b052544666a181012fb45dc49b`**
- Platform: native Windows.
- 6v desktop runtime and noha desktop runtime both report `codex-cli 0.166.0-alpha.5.1`. The older 6v convenience executable under `AppData\Local\Programs\OpenAI\Codex\bin` reports 0.147.0 and MUST NOT silently substitute for the pinned runtime.
- Source reviewed in a pinned shallow, sparse checkout at `.cache/codex-upstream` in the primary CCM worktree; that checkout is ignored and is not part of the deliverable.

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

- `src/runtime/sandbox/codex-windows-sandbox.mjs` uses the **unmodified** pinned `codex sandbox` CLI with a native named permissions profile and the upstream `permissions.<profile>.workspace_roots` TOML mechanism. The complete CLI, command runner, ACL setup and privilege model are owned by Codex; CCM does not duplicate them. The Worker launcher can propagate a dedicated `CODEX_HOME`, but this backend is **not yet selected** in production and a protected home has not been provisioned.
- The adapter fails closed if it cannot find exactly one CLI with version `0.166.0-alpha.5.1` and its paired setup/command runner. On noha, the installed desktop CLI has already advanced to `0.166.0-alpha.6`, so the pinned adapter is **not deployable there** without a dedicated pinned runtime.
- Verified via trusted admin-host execution on 6v: native `CodexSandboxOnline` process can write inside an isolated disposable workspace, including a sibling of its cwd, and rejects an ordinary write to a disposable outside file. `whoami /priv` listed only `SeChangeNotifyPrivilege`. These tests are not evidence about all filesystem aliases.
- **Hardlink escape, reproduced twice:** create a disposable file outside the chosen workspace, then an NTFS hardlink to that file inside the writable root before Codex initialization. The native Codex Elevated setup adds `CodexSandboxUsers:(I)(M)` to the outside file's ACL; a sandbox command can then overwrite the file using **either** the outside path or the inside hardlink. A before/after `icacls` probe confirmed the ACE change even when the command itself only queried `whoami`. Both paths and content were disposable and cleaned afterward.
- Relevant upstream: `codex-rs/windows-sandbox-rs/src/acl.rs` grants the write ACE and `src/setup.rs` provisions workspace ACLs. `src/file_write_tests.rs` tests atomic writes protecting the setup's own state files, but that does **not** protect arbitrary shell writes or ACL changes to linked workspace files. No general hardlink check was identified in the pinned ACL path; the next alpha tag's corresponding ACL files likewise show no obvious hardlink check (not proof of an exhaustive later-version fix).
- Permanent manual regression: `test/codex-elevated-containment.test.mjs`, opt-in only for trusted Windows host testing. It must **fail** on the current release until the upstream-compatible containment issue is resolved. Ordinary CI skips it to avoid provisioning Windows accounts and changing ACLs.

## Required integrated acceptance (not yet passed)

1. Both Workers use the **same** pinned Codex source/runtime and validate their executable and setup-helper versions, with no fallback to a different revision.
2. Trusted elevated provisioning creates or validates dedicated Online/Offline sandbox users, DPAPI credentials, read/write/deny ACLs, offline firewall rules and their versions. Ordinary commands never inherit the Worker administrator token.
3. The active workspace handle determines precisely the approved write roots even if the shell working directory is a subdirectory; outside-workspace writes, hard-link/reparse escapes, ACL modifications and SeRestorePrivilege-based writes fail. **FAILED on 6v due to NTFS hardlinks; release blocker.**
4. Reads, Python/venv, shell execution, Git, interactive stdin/PTY, output streaming, cancellation, process exit codes, service/IPC isolation, and network access match pinned upstream behavior.
5. Codex's config precedence, permissions profiles, failure semantics, approval/allowlist lifecycle and trust-boundaries are checked end-to-end. No legacy CCM-only semantics are silently retained.
6. Tests pass on both machines **before** replacing default CCM sandbox. Restart and health/reconnect verification follow a clean version-synchronized release; stop on any failure.

## Explicitly unresolved

The upstream sandbox implementation is a multi-crate Rust subsystem with independently provisioned users and persistent OS policy. Simply replacing the current C# token flags or wrapping `codex sandbox` inside the current CCM sandbox does **not** deliver parity. A native upstream-code integration or a verified pinned upstream runner in the trusted Worker execution layer is necessary. This research does **not** authorize deployment or a weaker fallback.
