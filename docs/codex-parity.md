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
| Policy evaluation and rules | `codex-rs/execpolicy/src/{parser,rule,policy,decision,execpolicycheck,amend}.rs`; `codex-rs/utils/absolute-path/src`; `codex-rs/core/src/exec_policy.rs` | `native/codex-execpolicy`, `native/codex-utils-absolute-path`, `src/controller/exec-policy-store.mjs`, `src/runtime/remote-process-manager.mjs` | **Native engine ported and tested, not connected to Controller**: exact upstream Starlark parser/evaluator/decision/file-locked append code builds as standalone Rust; independent tests cover alternatives, embedded examples, canonical matching, host paths, conflicting decisions and persistence. Controller still uses CCM's JSON Allow store. **Not aligned end-to-end**: actual policy routing, Codex `.rules` loading, heuristics, requirements and approval/sandbox handling remain. |
| Approval and escalation state machine | `codex-rs/protocol/src/approvals.rs`; `codex-rs/core/src/exec_policy.rs` | `src/controller/approval-manager.mjs`, `src/runtime/remote-process-manager.mjs` | **Not aligned**; approval card is Host adaptation, but the decision model and escalation must be checked upstream. |
| Windows sandbox / administrator profiles | `codex-rs/windows-sandbox-rs`, `codex-rs/windows-sandbox-service`; `codex-rs/protocol/src/sandbox.rs` | `native/windows-sandbox/CcmSandboxRunner.cs`, `src/runtime/sandbox/native-sandbox.mjs` | **Not aligned**; CCM-specific restricted administrator token behavior is not proof of Codex equivalence. |

| Process, terminal, PTY and session lifecycle | `codex-rs/core/src/exec.rs`; `codex-rs/exec` | `src/runtime/process-manager.mjs`, `src/runtime/executors/native-executor.mjs` | **Not aligned**; stream/yield/exit/cancellation behavior requires comparison. |
| Patch and filesystem semantics | `codex-rs/apply-patch`; `codex-rs/core/src/apply_patch.rs` | `src/runtime/filesystem`, `apply_patch` tools | **Not aligned**; existing CCM tests are not an upstream-differential suite. |
| Configuration loading, inheritance and policy | `codex-rs/config`, `codex-rs/protocol/src/config_types.rs` | Worker bootstrap and `config/` | **Not aligned overall**; only the shell environment policy TOML subset has been ported. |
| Worker routing and GPT Host delivery | Codex execution host and protocol interfaces | CCM Controller/Worker RPC, MCP, OAuth, approval UI | **Adaptation surface**; Host-specific presentation excluded, but execution semantics must still be equivalent. |

**Staged upstream native Windows execution (separate integration branch):**
`feat/codex-elevated-parity` pins `openai/codex` at
`f79b26ccbb3116b052544666a181012fb45dc49b` and adds
`src/runtime/sandbox/codex-windows-sandbox.mjs` with native CLI/runtime
version lookup, native named permission profiles, and dedicated `CODEX_HOME`
provisioning. It is not the production default. On 6v, CCM's actual
`ProcessManager` successfully used this adapter to launch a native
`CodexSandboxOnline` process, write within the workspace, deny an ordinary
outside write, and report its output/exit code. Separate upstream probes
demonstrated the known outside-file hardlink limitation, accepted by the owner
as outside the accidental-write safety goal. The pinned binary is currently
available on 6v; noha's installed CLI is alpha.6 rather than alpha.5.1.
See `docs/codex-upstream-windows-parity.md` for exact upstream source locations,
native setup evidence, accepted limitations and remaining integration gaps.

## Evidence and remaining acceptance gates

The shell environment slice is backed by `test/shell-environment.test.mjs`, `test/shell-environment-config.test.mjs`, `test/codex-shell-profile.test.mjs`, and native executor tests, translated from behavior verified in the pinned Codex implementation. On 6v, `npm test` passed 313/313 and `npm run build:native` succeeded; noha's 19 targeted tests and native build passed. Both Workers successfully executed a real restricted PowerShell command after restart. Those facts **do not** establish parity for unrelated modules.

For every subsequent slice, collect pinned source paths, map each upstream decision/branch to CCM behavior, add positive and adversarial regression tests, inspect native side effects, update this table, and validate both Workers. Do not mark a domain fully aligned while any listed discrepancy remains.

For TeX, Codex's `shell_environment_policy.set` can set a Worker-session-wide variable without transforming a Shell command or granting extra execution permissions. The exact Codex PowerShell parser is now ported and explicitly leaves `$env:TEXMFHOME='...'; & xdvipdfmx.exe` opaque. The remaining migration work concerns the full Codex policy and approval decision path, not support for splitting this dynamic command into a reusable executable-only Allow.

### PowerShell native parser port (2026-11-05)

**Exact upstream blobs at the pinned revision:** `codex-rs/shell-command/src/command_safety/powershell_tree_sitter.rs` = Git blob `a904e9249d8e76eb237c13a2654d098218d8facc`; `powershell_tree_sitter_tests.rs` = `a5d4e269ad7122f2bf27ea3ad46b7ea57f6bba36`; `fixtures/powershell_lowering.json` = `e1d8abcc3bddfd3adc736ff91f17be1b0f8a21c2`. All three tracked files in `native/codex-powershell-parser/src/` were retrieved by raw bytes and verified with `git hash-object`. Rust dependencies use upstream `tree-sitter 0.25.10` and `tree-sitter-powershell 0.26.4`. The thin Rust binary and JS JSON-line bridge do not evaluate user scripts; unavailable or malformed parser results produce no reusable authorization.

**Observed Codex behavior:** `& 'C:\\...\\xdvipdfmx.exe'` (PowerShell call operator) and `$env:TEXMFHOME='...'; & ...` are opaque rather than separately trusted. The Codex rule parser uses exact tokens: saved `["wsl.exe"]` does not cover `wsl`, and differently cased path spellings are not interchangeable. Under the same upstream check, a pipe may bypass the sandbox when each executable segment is explicitly allowed; this is distinct from CCM's independently configured built-in trusted commands, which still require safe source-to-executable binding and do not trust pipe rewriting.

**Important limitation:** A correctly parsed literal PowerShell command is not equivalent to complete Codex approval behavior. CCM still uses its Controller-specific `exec-allowlist.json` and approval state machine instead of Codex's Starlark `~/.codex/rules/default.rules`, complete rule precedence and prompt/forbidden semantics. The original TeX command is now conservatively opaque, not automatically authorized; the remaining policy/approval migration must be completed before claiming full parity.

### Native Codex execpolicy source import (2026-11-05)

- Fixed source commit: `ed8eac40832e6a79f30eaeb3c521912f231d43eb`.
- Upstream source copied directly: all Rust files in `codex-rs/execpolicy/src` into `native/codex-execpolicy/src`, plus all source files in `codex-rs/utils/absolute-path/src` into `native/codex-utils-absolute-path/src`. The package manifests were adapted to compile them independently of the Codex monorepo. The added `src/bin/ccm-bridge.rs` is a transport adapter only and does not implement Starlark or command matching.
- Git object verification against the upstream revision: `parser.rs` `cdd7935d965308d00b9a9b0ac93db107780f4047`; `policy.rs` `206094f37654651ac3c94d55db7c6ec94cd23057`; `rule.rs` `92d94baab16bf75816b36649a78215831312e846`; `amend.rs` `2716fbf81bd9a5cee6a6f447e1bc79b2cdd1f711`. The 6v source bytes match each upstream Git object exactly.
- Upstream `tests/basic.rs` is retained at `native/codex-execpolicy/tests/basic.rs`. The Node tests `test/codex-execpolicy-native.test.mjs` and `test/codex-execpolicy-bridge.test.mjs` exercise the built Rust engine and its upstream persistence method. Their pass results must not be mistaken for the upstream Rust test suite until the suite itself is executed.
- 6v: normal native release build passed, the 9 native evaluator/bridge tests passed, and `npm test` passed 327/327. The direct Rust `cargo test --release` was attempted but failed before compilation of test code because the workspace-write sandbox's Schannel TLS context could not download a dev dependency (`SEC_E_NO_CREDENTIALS`). The separate native build attempt with extra test arguments did not match the existing trusted build rule and failed to write a C# test build artifact under the sandbox. No exemption was introduced; **the upstream Rust test suite has not yet passed**. Do not erase this blocker from the record until it has been verified on an appropriate build environment.
- **No production policy switch yet**: no existing saved Controller rules were reinterpreted, replaced, deleted or automatically imported. To finish the migration, map the full upstream `codex-rs/core/src/exec_policy.rs` decision chain and `~/.codex/rules` loading into the Controller/Worker adaptation, retain Host-only approval-card transport, test prompt/forbidden precedence and sandbox fallback end-to-end, and then explicitly replace obsolete storage/documentation. No old compatibility scheme should be invented without user authorization.
