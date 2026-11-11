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
| PowerShell literal command lowering | codex-rs/shell-command/src/command_safety/{mod,powershell_tree_sitter,powershell_tree_sitter_tests}.rs, fixtures/powershell_lowering.json | native/codex-powershell-parser; src/runtime/sandbox/{codex-powershell-parser,shell-policy-parser}.mjs | Original upstream Rust lowering and fixture suite retained; **owner-approved CCM divergence (2026-11-11)**: a separate literal-wrapper recognizer permits static PowerShell & calls and literal $env: assignment prefixes to reuse existing Allow rules. Ordinary executable segments still pass upstream validation; source-bound built-in rewrites are not inferred for wrappers. CMD remains independent. |
| Policy evaluation and rules | codex-rs/execpolicy/src/{parser,rule,policy,decision,execpolicycheck,amend}.rs; codex-rs/utils/absolute-path/src | native/codex-execpolicy, native/codex-utils-absolute-path, src/controller/codex-execpolicy.mjs, src/runtime/remote-process-manager.mjs | **Live Controller integration**: unchanged upstream Starlark parser, matcher, severity and file-locked Allow persistence are called by the native bridge on every decision. Allow maps to approved Full Access; Prompt maps to the frozen CCM approval card; Forbidden rejects; no match retains the Worker sandbox. The standard .rules file is shared across Workers. Codex core heuristics/reviewer orchestration remain outside this slice. |
| Approval and escalation state machine | codex-rs/protocol/src/approvals.rs; codex-rs/core/src/exec_policy.rs | src/controller/approval-manager.mjs, src/runtime/remote-process-manager.mjs, native Codex ExecPolicy adapter | **Policy decisions integrated; Host approval transport remains CCM-specific**: exact command/prefix/workspace freezing and one-shot state machine are retained behind the GPT Host approval card. The full Codex reviewer/heuristics orchestration is not claimed as imported. |
| Guardian auto-review | CCMv2 `f7f0c498347ce552f3851437ce013e125468b407`: `codex-rs/ext/guardian-reviewer/src/{assessment,retry,review,execution,settings}.rs`, `codex-rs/prompts/templates/guardian/{policy.md,policy_template.md}`; Codex base `c983513c1fc79e6a19bc009b3b6e08fbe9ab5367` | `src/controller/{guardian-*,cpa-review-client}.mjs`, `src/runtime/remote-process-manager.mjs`, `src/controller/approval-manager.mjs`, sole ToolRegistry; see `docs/auto-review.md` | **Synchronous Controller adapter implemented, staged disabled.** Native source policy files copied unchanged; assessment parsing/defaults, retry categorization, timed review and exact frozen execution claim ported. **Owner-approved Host adaptations**: trust main-model task/authorization summary, same model-visible CCM tools and effective privileges (not read-only). Response function tool rounds replay full history; real CPA 2-tool cycle passed. Still *not native-full parity*: no Codex parent-turn/async pre-scoring/cached history or native denial circuit; writable reviewer means no implicit retry after tool side effects. No running Controller/Worker end-to-end approval attested yet. |
| Windows sandbox / administrator profiles | `codex-rs/windows-sandbox-rs/src/{resolved_permissions,allow,setup}.rs`; `codex-rs/protocol/src/{models,permissions}.rs` at `f79b26ccbb3116b052544666a181012fb45dc49b` | `native/windows-sandbox/CcmSandboxRunner.cs`, `src/runtime/sandbox/native-sandbox.mjs`, `src/runtime/admin` | **Partial owner-approved adaptation, not aligned end-to-end**: production `workspace-write` now resolves workload `TMP`/`TEMP` as additional writable restricted-token capability roots, as in upstream's default `:tmpdir` policy. CCM retains its own stable SID/NTFS ACL implementation and stricter protected-path checks; `read-only` never gains temp writes. The separately approved `run_as_admin=true` administrator agent remains unrestricted and outside workspace confinement. |

| Process, terminal, PTY and session lifecycle | `codex-rs/core/src/exec.rs`; `codex-rs/exec` | `src/runtime/process-manager.mjs`, `src/runtime/executors/native-executor.mjs` | **Not aligned**; stream/yield/exit/cancellation behavior requires comparison. |
| Patch and filesystem semantics | `codex-rs/apply-patch`; `codex-rs/core/src/apply_patch.rs` | `src/runtime/filesystem`, `apply_patch` tools | **Not aligned**; existing CCM tests are not an upstream-differential suite. |
| Configuration loading, inheritance and policy | `codex-rs/config`, `codex-rs/protocol/src/config_types.rs` | Worker bootstrap and `config/` | **Not aligned overall**; only the shell environment policy TOML subset has been ported. |
| Worker routing and GPT Host delivery | Codex execution host and protocol interfaces | CCM Controller/Worker RPC, MCP, OAuth, approval UI | **Adaptation surface**; Host-specific presentation excluded, but execution semantics must still be equivalent. |

**Staged upstream native Windows execution (merged into main):**
`vendor/openai-codex` records the reviewed source at
`f79b26ccbb3116b052544666a181012fb45dc49b` and includes
`src/runtime/sandbox/codex-windows-sandbox.mjs` with native CLI/runtime
discovery (newest complete installation, no CLI version pin), native named permission profiles, and dedicated `CODEX_HOME`
provisioning. It is not the production default. On 6v, CCM's actual
`ProcessManager` successfully used this adapter to launch a native
`CodexSandboxOnline` process, write within the workspace, deny an ordinary
outside write, and report its output/exit code. Separate upstream probes
demonstrated the known outside-file hardlink limitation, accepted by the owner
as outside the accidental-write safety goal. Each Worker now selects its newest
complete local Codex installation independently; actual sandbox behavior with
updated releases must still be validated before production activation.
See `docs/codex-upstream-windows-parity.md` for exact upstream source locations,
native setup evidence, accepted limitations and remaining integration gaps.

## Evidence and remaining acceptance gates

The shell environment slice is backed by `test/shell-environment.test.mjs`, `test/shell-environment-config.test.mjs`, `test/codex-shell-profile.test.mjs`, and native executor tests, translated from behavior verified in the pinned Codex implementation. On 6v, `npm test` passed 313/313 and `npm run build:native` succeeded; noha's 19 targeted tests and native build passed. Both Workers successfully executed a real restricted PowerShell command after restart. Those facts **do not** establish parity for unrelated modules.

For every subsequent slice, collect pinned source paths, map each upstream decision/branch to CCM behavior, add positive and adversarial regression tests, inspect native side effects, update this table, and validate both Workers. Do not mark a domain fully aligned while any listed discrepancy remains.

For TeX, Codex shell_environment_policy.set remains available for Worker-session-wide environment settings. The native policy also recognizes the saved absolute xdvipdfmx.exe and xelatex.exe prefixes. The owner-approved literal PowerShell wrapper recognizer permits static & invocation and literal $env: assignment prefixes to reuse an exact executable Allow; dynamic values and targets remain opaque. This parser extension is a deliberate difference from the pinned upstream PowerShell lowerer, whose source and fixtures remain unchanged.

### PowerShell native parser port (2026-11-05)

**Native policy integration verification (2026-11-11):** both hosts completed `node --test --test-concurrency=1 --test-timeout=60000` over 344 cases with zero failures: 6v passed 338 and skipped six opt-in cases; noha passed 337 and skipped seven (including a 6v-only policy state test). The 40 focused approval, native Codex ExecPolicy and config tests also passed on 6v after cleanup. Coverage includes Allow persistence/reuse across Workers, mixed command segment evaluation, Prompt/Forbidden precedence, malformed Starlark fail-closed behavior, absolute executable prefixes and literal PowerShell wrapper lowering. Both native builds passed; noha required the preauthorized administrator agent because its restricted environment could not discover the installed Visual Studio C++ tools. The default parallel runner can stall on an independent TCP transfer test, while noha's low ephemeral port range exposed a Fetch-restricted port in the OAuth loopback test; the HTTP test client was corrected and the complete suite passed on rerun. Live two-host restart and reconnection remain a separate acceptance gate.

**Exact upstream blobs at the pinned revision:** `codex-rs/shell-command/src/command_safety/powershell_tree_sitter.rs` = Git blob `a904e9249d8e76eb237c13a2654d098218d8facc`; `powershell_tree_sitter_tests.rs` = `a5d4e269ad7122f2bf27ea3ad46b7ea57f6bba36`; `fixtures/powershell_lowering.json` = `e1d8abcc3bddfd3adc736ff91f17be1b0f8a21c2`. All three tracked files in `native/codex-powershell-parser/src/` were retrieved by raw bytes and verified with `git hash-object`. Rust dependencies use upstream `tree-sitter 0.25.10` and `tree-sitter-powershell 0.26.4`. The thin Rust binary and JS JSON-line bridge do not evaluate user scripts; unavailable or malformed parser results produce no reusable authorization.

**Upstream comparison:** At ed8eac40832e6a79f30eaeb3c521912f231d43eb, Codex leaves PowerShell call operators and $env assignments opaque, and evaluates non-canonical saved token prefixes exactly. CCM adds a separate positive matching path for strictly literal wrappers, leaving upstream source and fixture hashes untouched. Compound pipelines require every executable segment to receive an explicit Allow. The wrapper extension returns tokens only and never rewrites command text.

**Current integration boundary:** the upstream Starlark .rules engine is the live Controller policy authority. The Controller maps native decisions into the existing Worker sandbox and GPT Host approval card; no parallel general command policy store remains. Codex core heuristics and reviewer orchestration remain unported, so a command with no matching rule follows CCM normal sandbox behavior. The owner-approved literal PowerShell wrapper extension only supplies tokens after upstream validation and never rewrites command text.

### Native Codex execpolicy source import (2026-11-05)

- Fixed source commit: `ed8eac40832e6a79f30eaeb3c521912f231d43eb`.
- Upstream source copied directly: all Rust files in `codex-rs/execpolicy/src` into `native/codex-execpolicy/src`, plus all source files in `codex-rs/utils/absolute-path/src` into `native/codex-utils-absolute-path/src`. The package manifests were adapted to compile them independently of the Codex monorepo. The added `src/bin/ccm-bridge.rs` is a transport adapter only and does not implement Starlark or command matching.
- Git object verification against the upstream revision: `parser.rs` `cdd7935d965308d00b9a9b0ac93db107780f4047`; `policy.rs` `206094f37654651ac3c94d55db7c6ec94cd23057`; `rule.rs` `92d94baab16bf75816b36649a78215831312e846`; `amend.rs` `2716fbf81bd9a5cee6a6f447e1bc79b2cdd1f711`. The 6v source bytes match each upstream Git object exactly.
- Upstream `tests/basic.rs` is retained at `native/codex-execpolicy/tests/basic.rs`. The Node tests `test/codex-execpolicy-native.test.mjs` and `test/codex-execpolicy-bridge.test.mjs` exercise the built Rust engine and its upstream persistence method. Their pass results must not be mistaken for the upstream Rust test suite until the suite itself is executed.
- 6v: normal native release build passed, the 9 native evaluator/bridge tests passed, and `npm test` passed 327/327. The direct Rust `cargo test --release` was attempted but failed before compilation of test code because the workspace-write sandbox's Schannel TLS context could not download a dev dependency (`SEC_E_NO_CREDENTIALS`). The separate native build attempt with extra test arguments did not match the existing trusted build rule and failed to write a C# test build artifact under the sandbox. No exemption was introduced; **the upstream Rust test suite has not yet passed**. Do not erase this blocker from the record until it has been verified on an appropriate build environment.
- **Live Controller policy (2026-11-11):** the Controller loads the standard Starlark policy file from protected CCM state and evaluates it through the unchanged upstream Rust engine for every parsed command segment. Allow, Prompt and Forbidden map respectively to approved Full Access, the CCM approval card and rejection. No match retains normal sandbox execution. Always allow appends to this same file through the upstream file-locked function. On 6v, 14 existing rules were migrated: five prior saved prefixes plus the Git remote, Node test, npm native-build, pinned Tailscale, and pinned TeX command prefixes. The separate hash-bound package-script store remains workspace-specific. The full Codex core heuristic/reviewer path is not claimed as ported.

## Host conversation reader (not upstream execution parity)

The CCM-specialized `ccm-extra.conversation` tool is an explicitly owner-requested
Host workflow. It provides a public ChatGPT/Codex Share snapshot import and a
Worker-local read-only Codex JSONL reader with `thread/read`,
`thread/turns/list`, and `thread/items/list`-style interfaces. Codex App Server
protocol names and turn/item semantics are audited against the pinned upstream
source baseline `f79b26ccbb3116b052544666a181012fb45dc49b` in
`third_party/openai-codex/codex-rs/app-server` and Codex rollout code.
This is an adapter, **not** an assertion that our read API is byte-for-byte
identical to the upstream App Server. Public Share imports have their own
source limitations. Local reads do not resume sessions, and capability
negotiation prevents a Controller from issuing an unknown method to an older
Worker. Upstream execution/sandbox parity status is unchanged.
