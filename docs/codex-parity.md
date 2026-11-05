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
| PowerShell literal command lowering | `codex-rs/shell-command/src/command_safety/{mod,powershell_tree_sitter,powershell_tree_sitter_tests}.rs`, `fixtures/powershell_lowering.json`; `codex-rs/shell-command/src/powershell.rs` | `native/codex-powershell-parser`, `src/runtime/sandbox/codex-powershell-parser.mjs`, `shell-policy-parser.mjs` | **Ported native source and verified**: unchanged upstream Tree-sitter parser, matching upstream Git object hashes, original fixture cases, fail-closed parsing of expressions, assignments, invocation operators, and command chains. **Remaining**: native parser uses a subprocess bridge; CMD parsing and CCM source rewriting are not Codex ports, and policy composition is incomplete. |
| Policy evaluation and rules | `codex-rs/execpolicy/src/{parser,rule,policy,decision,execpolicycheck}.rs`; `codex-rs/core/src/exec_policy.rs` | `src/controller/exec-policy-store.mjs`, `src/runtime/remote-process-manager.mjs` | **Partially aligned**: saved prefix tokens now use Codex's exact case-sensitive token comparison, and every parsed segment (including pipes) needs an Allow before bypassing the sandbox. **Not yet aligned**: Starlark rules DSL, decision precedence (allow/prompt/forbidden), host executable resolution, requirements, sandbox fallback and rule persistence remain CCM implementations. |
| Approval and escalation state machine | `codex-rs/protocol/src/approvals.rs`; `codex-rs/core/src/exec_policy.rs` | `src/controller/approval-manager.mjs`, `src/runtime/remote-process-manager.mjs` | **Not aligned**; approval card is Host adaptation, but the decision model and escalation must be checked upstream. |
| Windows sandbox / administrator profiles | `codex-rs/windows-sandbox-rs`, `codex-rs/windows-sandbox-service`; `codex-rs/protocol/src/sandbox.rs` | `native/windows-sandbox/CcmSandboxRunner.cs`, `src/runtime/sandbox/native-sandbox.mjs` | **Not aligned**; CCM-specific restricted administrator token behavior is not proof of Codex equivalence. |
| Process, terminal, PTY and session lifecycle | `codex-rs/core/src/exec.rs`; `codex-rs/exec` | `src/runtime/process-manager.mjs`, `src/runtime/executors/native-executor.mjs` | **Not aligned**; stream/yield/exit/cancellation behavior requires comparison. |
| Patch and filesystem semantics | `codex-rs/apply-patch`; `codex-rs/core/src/apply_patch.rs` | `src/runtime/filesystem`, `apply_patch` tools | **Not aligned**; existing CCM tests are not an upstream-differential suite. |
| Configuration loading, inheritance and policy | `codex-rs/config`, `codex-rs/protocol/src/config_types.rs` | Worker bootstrap and `config/` | **Not aligned overall**; only the shell environment policy TOML subset has been ported. |
| Worker routing and GPT Host delivery | Codex execution host and protocol interfaces | CCM Controller/Worker RPC, MCP, OAuth, approval UI | **Adaptation surface**; Host-specific presentation excluded, but execution semantics must still be equivalent. |

## Evidence and remaining acceptance gates

The shell environment slice is backed by `test/shell-environment.test.mjs`, `test/shell-environment-config.test.mjs`, `test/codex-shell-profile.test.mjs`, and native executor tests, translated from behavior verified in the pinned Codex implementation. On 6v, `npm test` passed 313/313 and `npm run build:native` succeeded; noha's 19 targeted tests and native build passed. Both Workers successfully executed a real restricted PowerShell command after restart. Those facts **do not** establish parity for unrelated modules.

For every subsequent slice, collect pinned source paths, map each upstream decision/branch to CCM behavior, add positive and adversarial regression tests, inspect native side effects, update this table, and validate both Workers. Do not mark a domain fully aligned while any listed discrepancy remains.

For TeX, Codex's `shell_environment_policy.set` can set a Worker-session-wide variable without transforming a Shell command or granting extra execution permissions. The exact Codex PowerShell parser is now ported and explicitly leaves `$env:TEXMFHOME='...'; & xdvipdfmx.exe` opaque. The remaining migration work concerns the full Codex policy and approval decision path, not support for splitting this dynamic command into a reusable executable-only Allow.

### PowerShell native parser port (2026-11-05)

**Exact upstream blobs at the pinned revision:** `codex-rs/shell-command/src/command_safety/powershell_tree_sitter.rs` = Git blob `a904e9249d8e76eb237c13a2654d098218d8facc`; `powershell_tree_sitter_tests.rs` = `a5d4e269ad7122f2bf27ea3ad46b7ea57f6bba36`; `fixtures/powershell_lowering.json` = `e1d8abcc3bddfd3adc736ff91f17be1b0f8a21c2`. All three tracked files in `native/codex-powershell-parser/src/` were retrieved by raw bytes and verified with `git hash-object`. Rust dependencies use upstream `tree-sitter 0.25.10` and `tree-sitter-powershell 0.26.4`. The thin Rust binary and JS JSON-line bridge do not evaluate user scripts; unavailable or malformed parser results produce no reusable authorization.

**Observed Codex behavior:** `& 'C:\\...\\xdvipdfmx.exe'` (PowerShell call operator) and `$env:TEXMFHOME='...'; & ...` are opaque rather than separately trusted. The Codex rule parser uses exact tokens: saved `["wsl.exe"]` does not cover `wsl`, and differently cased path spellings are not interchangeable. Under the same upstream check, a pipe may bypass the sandbox when each executable segment is explicitly allowed; this is distinct from CCM's independently configured built-in trusted commands, which still require safe source-to-executable binding and do not trust pipe rewriting.

**Important limitation:** A correctly parsed literal PowerShell command is not equivalent to complete Codex approval behavior. CCM still uses its Controller-specific `exec-allowlist.json` and approval state machine instead of Codex's Starlark `~/.codex/rules/default.rules`, complete rule precedence and prompt/forbidden semantics. The original TeX command is now conservatively opaque, not automatically authorized; the remaining policy/approval migration must be completed before claiming full parity.
