# CCM ↔ OpenAI Codex upstream conformance

## Normative baseline and policy

- Upstream repository: https://github.com/openai/codex
- Reviewed revision: `ed8eac40832e6a79f30eaeb3c521912f231d43eb` (2026-11-05)
- Rule: `AGENTS.md` requires Codex source-level behavior equivalence for all non-GPT-Host behavior. Any semantic difference or historical compatibility mechanism requires the user's explicit prior decision. No existing CCM behavior is grandfathered in.
- Always pin the exact upstream revision examined when performing a later migration. A test about CCM's old behavior does not establish Codex parity.

## Module-by-module status

| Domain | Upstream starting points at pinned revision | CCM counterpart | Verified status |
| --- | --- | --- | --- |
| Shell environment policy transformation | `codex-rs/protocol/src/shell_environment.rs`, `config_types.rs`; `codex-rs/config/src/shell_environment_policy.rs` | `src/runtime/shell-environment.mjs`, `shell-environment-config.mjs` | **Ported and tested**: policy order, inheritance, filters, overrides, non-inheritable variables, Windows PATHEXT and case behavior. |
| Shell environment process integration | `codex-rs/core/src/exec_env.rs`; `codex-rs/protocol/src/shell_environment_tests.rs` | `src/runtime/executors/native-executor.mjs`, `src/runtime/sandbox/native-sandbox.mjs`, native Windows runner | **Integrated and tested**: Worker child environment, PTY/pipe, profile option. **Still divergent**: CCM registry refresh, proxy and CA preprocessing; Codex config layering is not replicated end-to-end. |
| PowerShell and shell command parsing | `codex-rs/shell-command/src/{powershell,parse_command}.rs` | `src/runtime/sandbox/shell-policy-parser.mjs` | **Not aligned**; complete dynamic-expression and compound-command parity needs source tests. |
| Policy evaluation and rules | `codex-rs/execpolicy/src/{parser,rule,policy,decision,execpolicycheck}.rs`; `codex-rs/core/src/exec_policy.rs` | `src/controller/exec-policy-store.mjs`, `src/runtime/remote-process-manager.mjs` | **Not aligned**; saved global prefix matching and executable assessment remain CCM implementations. |
| Approval and escalation state machine | `codex-rs/protocol/src/approvals.rs`; `codex-rs/core/src/exec_policy.rs` | `src/controller/approval-manager.mjs`, `src/runtime/remote-process-manager.mjs` | **Not aligned**; approval card is Host adaptation, but the decision model and escalation must be checked upstream. |
| Windows sandbox / administrator profiles | `codex-rs/windows-sandbox-rs`, `codex-rs/windows-sandbox-service`; `codex-rs/protocol/src/sandbox.rs` | `native/windows-sandbox/CcmSandboxRunner.cs`, `src/runtime/sandbox/native-sandbox.mjs` | **Not aligned**; CCM-specific restricted administrator token behavior is not proof of Codex equivalence. |
| Process, terminal, PTY and session lifecycle | `codex-rs/core/src/exec.rs`; `codex-rs/exec` | `src/runtime/process-manager.mjs`, `src/runtime/executors/native-executor.mjs` | **Not aligned**; stream/yield/exit/cancellation behavior requires comparison. |
| Patch and filesystem semantics | `codex-rs/apply-patch`; `codex-rs/core/src/apply_patch.rs` | `src/runtime/filesystem`, `apply_patch` tools | **Not aligned**; existing CCM tests are not an upstream-differential suite. |
| Configuration loading, inheritance and policy | `codex-rs/config`, `codex-rs/protocol/src/config_types.rs` | Worker bootstrap and `config/` | **Not aligned overall**; only the shell environment policy TOML subset has been ported. |
| Worker routing and GPT Host delivery | Codex execution host and protocol interfaces | CCM Controller/Worker RPC, MCP, OAuth, approval UI | **Adaptation surface**; Host-specific presentation excluded, but execution semantics must still be equivalent. |

## Evidence and remaining acceptance gates

The shell environment slice is backed by `test/shell-environment.test.mjs`, `test/shell-environment-config.test.mjs`, `test/codex-shell-profile.test.mjs`, and native executor tests, translated from behavior verified in the pinned Codex implementation. On 6v, `npm test` passed 313/313 and `npm run build:native` succeeded; noha's 19 targeted tests and native build passed. Both Workers successfully executed a real restricted PowerShell command after restart. Those facts **do not** establish parity for unrelated modules.

For every subsequent slice, collect pinned source paths, map each upstream decision/branch to CCM behavior, add positive and adversarial regression tests, inspect native side effects, update this table, and validate both Workers. Do not mark a domain fully aligned while any listed discrepancy remains.

The original TeX case (`$env:TEXMFHOME='...'; & xdvipdfmx.exe` not matching a previous `xdvipdfmx.exe` Allow) is **not resolved** by the shell environment policy slice; Codex policy-level `set` can set a Worker-session-wide variable but does not transform or auto-authorize the original compound command. That case belongs to the unaligned shell parser and approval domains.
