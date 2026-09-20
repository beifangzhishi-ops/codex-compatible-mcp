# CCM Project Direction

CCM means **Codex-Compatible MCP**. It is a new project and must remain separate from WCM.

CCM exists to improve GPT's coding/execution performance over WCM by providing a smaller, more consistent agent-oriented harness. Codex is the main implementation reference where its design improves execution efficiency, but CCM is not a full Codex-parity project and does not attempt to reproduce Codex's host-owned conversation/context loop.

## Current priorities

The first implementation round is intentionally narrow and performance-oriented:

1. **P0 — Execution Core:** `exec_command`, `write_stdin`, reliable PTY/process sessions, bounded command output, structured results, and the native sandbox required to run them safely.
2. **P0 — Environment + Remote Worker:** every execution environment is backed by the same Remote Worker protocol, including the machine that hosts the Controller; a session has a default environment and each operation may override `environment_id`.
3. **P0 — Editing:** CCM-owned `apply_patch` and `view_image`.
4. **P0 — Tool Architecture:** a stable small top-level MCP surface plus ToolRegistry, deferred discovery, `tool_search`, and Code Mode so capability growth does not continuously enlarge the plugin schema.

The first round ends after these four areas are working and tested. Plan Mode, Goal, MCP resource aggregation, Skills, multi-agent orchestration, and reviewer/auto-review features are later work unless a concrete workflow proves they are needed earlier.

Current implementation status:

- **Milestone 1 / Execution Core: complete.** Native Windows sandbox, Rust/ConPTY PTY, interactive `write_stdin`, bounded capture/model output, and final MCP response guards are covered by regression tests.
- **Milestone 2 / Environment + Remote Worker: complete.** Controller execution goes through the Remote Worker protocol, including the Controller host over loopback; per-operation environment routing, public session mapping, remote-native paths, disconnect cleanup, reconnecting worker agent behavior, and worker-transport size limits are implemented.
- **Milestone 3 / Editing: complete.** Codex-style patching and bounded image reads execute on the selected Remote Worker, with preflight validation, workspace/symlink protections, media structure checks, and MCP end-to-end coverage.
- **Milestone 4 / Tool Architecture: complete.** ToolRegistry uses independent Direct / Deferred / Code Mode surfaces with derived exposure states, namespaced provenance/collision rules, `tool_search`, and bounded nested `exec/wait` dispatch. Deferred capabilities can be registered without changing the top-level MCP schema.

The earlier idea of keeping Desktop Commander tools as the main model-visible API is superseded. CCM may reuse implementation ideas, but GPT should primarily see CCM's smaller Codex-like execution surface.

## Core design principles

- Copy Codex behavior and lifecycle where useful, not merely tool names.
- Keep the top-level model-visible tool surface small, stable, and high-signal.
- Treat remote machines as first-class environments rather than adding a device argument everywhere.
- Keep shell, cwd, path syntax, filesystem semantics, and process state native to the selected environment.
- Do not let the controller reinterpret Windows paths as Linux paths or vice versa.

## Orchestration ownership

CCM cannot copy Codex's control loop exactly because the control direction is different.

In Codex, the harness is the active orchestrator: it invokes the model, executes tools, and decides when to invoke the model again.

In ChatGPT + CCM, ChatGPT is the active orchestrator. CCM is a passive but persistent execution/runtime substrate and must never rely on being able to initiate another LLM turn.

CCM therefore owns only the state required for execution and continuation: environments, process sessions, sandbox/policy state, runtime events, optional Goal state, and other execution metadata. It does not own or duplicate ChatGPT conversation history or ChatGPT-side context management.

The current filesystem and live runtime remain the source of truth for code and execution state. Goal checkpoints record durable execution progress and decisions needed for continuation, not verbose reasoning transcripts.
## Execution core

The first-round model-visible execution surface should converge on:

- `exec_command`
- `write_stdin`
- `apply_patch`
- `view_image`

Normal repository work such as reading files, searching, Git, builds, tests, directory operations, and diagnostics should normally be performed through `exec_command` rather than many narrow file/process tools.

`exec_command` must have a real process lifecycle. A still-running command returns a CCM-managed public `session_id`; `write_stdin` resumes, polls, or writes to that session without requiring the model to repeat its environment.

Command output must be bounded before it is returned to the model. This is **output/context protection**, not a separate feature phase: CCM keeps structured metadata such as exit/session state and original output size, while limiting the text sent back in one tool result. Large build logs, recursive listings, test output, and similar commands must not consume the model's entire context window. Incremental polling should return only new output where practical.

`apply_patch` should use Codex-style patch grammar and execute against the selected environment filesystem. It is not just an alias for string replacement.

`view_image` reads an image from the selected environment. Image **generation** is intentionally out of scope because ChatGPT already provides a better native image-generation path.

## Environment and Remote Worker model

CCM must support one or more Remote Workers without giving any particular machine a special execution path.

CCM uses a single worker model. The Controller does not have a separate Local Worker or Local Executor execution path. The machine hosting the Controller runs a normal **Remote Worker** too; when both processes are on the same machine, the connection may use loopback/local transport, but the protocol and runtime semantics remain identical to every other worker.

Environment selection is **per operation with a session default**, not an exclusive global mode. A normal call can omit `environment_id` and use the session/default environment, while workflows that alternate between machines can explicitly target each operation:

`exec_command(environment_id="machine1", ...)`
`apply_patch(environment_id="machine2", ...)`

A Remote Worker should report environment metadata such as:

- environment id
- operating system
- native shell
- cwd / workspace roots
- process, patch, image, and filesystem capabilities

The Controller routes each operation to the Remote Worker that owns the selected environment. Shell syntax, cwd, filesystem paths, PTY/process lifecycle, sandbox enforcement, patching, and image access remain native to that worker.

This single-worker architecture is intentional: local and physically remote machines must not develop separate execution semantics or separate implementations.

Cross-environment file-transfer functionality is not a current CCM goal.

The existing WCM controller/worker idea is useful conceptually, but CCM is a fresh implementation and should not be constrained by Desktop Commander schemas.
## Deferred runtime features

### Plan Mode

Plan Mode is useful for reliability but is not part of the first performance-focused implementation round. If implemented later, it should be a real runtime mode: inspection and non-destructive validation remain available while mutations are blocked or separately gated server-side.

### Goal

Goal is also deferred until after the first four implementation areas. It must not be used as a substitute for unavailable ChatGPT conversation history.

If Goal is implemented, it should stay lightweight and persist only durable continuation state:

- **Goal Contract:** objective, success criteria, scope, constraints, target workspace/repository, target environments, status.
- **Directive Ledger:** append-only user instructions that materially affect future continuation; not every user message.
- **Implementation Decisions:** agent/runtime technical decisions kept distinct from user directives.
- **Checkpoint:** completed work, remaining work, verified facts, blockers, and next actions.

Normal interactive CCM sessions should not require a Goal. Goal exists only for durable cross-run or scheduled continuation.

## Code Mode and extensibility

Code Mode is implemented as a registry-backed nested dispatch path rather than a second JavaScript runtime inside CCM.

CCM should own a ToolRegistry where model exposure is represented by independent surfaces:

- **Direct** — included in the initial model-visible tool list
- **Deferred** — omitted initially but discoverable through `tool_search`
- **Code Mode** — callable as a nested capability from Code Mode

A tool may support any useful combination of these surfaces; no enabled surface is equivalent to Hidden. Convenience labels such as Direct, Deferred, CodeModeOnly, DirectModelOnly, DeferredModelOnly, and Hidden may be derived from the surface flags.

The stable top-level MCP surface should not grow every time CCM gains a specialized capability. Specialized tools should normally become deferred and/or nested ToolRegistry capabilities rather than new top-level MCP functions.

This is also the preferred solution to the plugin-refresh problem: new nested capabilities can become usable without requiring ChatGPT to register a brand-new top-level MCP function.

`tool_search` searches deferred registry capabilities and returns their qualified name, schema, provenance, exposure surfaces, and environment requirements. `exec` and `wait` dispatch Code Mode-capable registry entries. The host Code Mode owns JavaScript/control flow; CCM owns bounded capability dispatch and continuation state.
## Later extension: MCP resources

MCP resource aggregation is explicitly outside the first release. If a later workflow justifies it, CCM may add Codex-style resource helpers and a child-MCP connection manager without changing the first-release execution ABI.

## Later work

Multi-agent orchestration is desirable later: agent sessions, messaging, waiting, interruption, cancellation, and result propagation. It is not part of the first execution milestone.

Host-native features that ChatGPT already provides should generally stay outside CCM. In particular:

- do not duplicate ChatGPT image generation
- do not duplicate ChatGPT web search
- do not implement UI-only Codex features merely to copy their names

## Deployment direction

The repository must remain self-contained and free of developer-machine paths or private deployment assumptions.

The default MCP endpoint path is:

`/ccm/mcp`

The Controller and WorkerHub bind to loopback by default. Remote Worker exposure beyond the local host must be an explicit deployment choice and, until authenticated transport is implemented, should only be used on a trusted/private network.

WCM remains a separate project and should not be modified as part of CCM development unless explicitly requested.
## Codex source alignment for the first release

The current Codex source is used as a design reference only for CCM's first four milestones. CCM should copy execution contracts that improve reliability or model efficiency, not host-specific lifecycle features that ChatGPT already owns.

### 1. Execution Core

Current Codex `unified_exec` uses the same basic limits CCM already adopted: a default 10,000-token model-output budget, a 1 MiB captured-output ceiling, and a 64-process ceiling. CCM should keep these as initial defaults and additionally enforce an absolute serialized MCP-response byte limit at the Controller boundary.

For live processes, the useful Codex pattern is cursor-based incremental output rather than replaying the full buffer. The Remote Worker protocol should therefore support sequence/cursor reads with a response byte budget and bounded wait time.

On Windows, Codex does not rely on the stock `portable-pty` Windows backend. Its `codex-utils-pty` contains a modified ConPTY implementation with process-tree/Job Object handling and newer ConPTY lifecycle fixes. CCM should align its Windows PTY helper with that implementation rather than returning to `node-pty` or treating stock `portable-pty` behavior as authoritative.

### 2. Environment + Remote Worker

Current Codex has a separate `codex-exec-server` responsible for transport plus process and filesystem handlers. It supports local WebSocket use and remote environment registration while keeping the execution API stable.

The useful contract for CCM is:
- `initialize` / `initialized` handshake with environment metadata
- process start/read/write/terminate
- asynchronous output/exited/closed state
- sequence-based incremental reads with `maxBytes` and bounded wait
- worker-owned filesystem and sandbox operations

CCM should follow the same ownership split: the Controller routes by `environment_id`; the Remote Worker owns shell/PTY/process lifetime, sandbox enforcement, patch filesystem access, and image reads. The Controller host is not special: it also runs a Remote Worker and uses the same protocol over loopback/local transport.

The model-facing API may keep environment-native path strings. Internally, the Worker protocol may normalize paths to `file:` URIs, as Codex does, so Windows and POSIX paths remain unambiguous across the transport.

CCM should **not** copy Codex's Noise relay, AWS signing, rendezvous protocol, or forwarding machinery in the first release. Those solve deployment/authentication problems rather than the WCM performance problems CCM is targeting.

### 3. Editing

Current Codex `apply_patch` resolves the selected `environment_id`, verifies the parsed patch against that environment's filesystem and sandbox policy, and only then executes it. CCM should preserve this separation: parse/verify centrally, execute against the selected Remote Worker filesystem, and fail before mutation when the patch is invalid or forbidden.

Current Codex `view_image` is also environment-aware and validates image data before returning it. CCM should follow that behavior while adding an explicit media-size/preview budget so image results cannot reproduce WCM's oversized-response failures.

### 4. Tool Architecture

Current Codex treats tool exposure as three independent model-facing surfaces: **Direct**, **Deferred**, and **Code Mode**. Its convenience states include Direct, Deferred, CodeModeOnly, DirectModelOnly, DeferredModelOnly, and Hidden.

CCM should therefore avoid locking Milestone 4 to a rigid four-value enum. The durable representation should be exposure-surface flags/capabilities, with convenience labels derived from those flags.

Codex also separates the complete executable registry from the finalized model-visible tool list. CCM should do the same: ToolRegistry owns all executable capabilities, while a routing/planning layer decides what is directly visible, discoverable through `tool_search`, or callable only from Code Mode.

`tool_search` in CCM should be an ordinary MCP function with ordinary JSON arguments rather than depending on a host-specific tool-call payload type. Code Mode should follow the useful Codex pattern of a small public `exec` / `wait` surface dispatching nested registered capabilities.

### Explicitly outside first-release parity

The first release does not attempt to copy Codex's model loop, conversation/context ownership, Goal-like continuation, Plan Mode, Skills, MCP-resource aggregation, multi-agent runtime, model-based reviewer, or remote relay/auth infrastructure. These remain later options only when a concrete CCM workflow justifies them.

## Performance-first implementation order

### First implementation round

**Milestone 1 — Execution Core**

- `exec_command` and `write_stdin`
- reliable PTY and long-running process sessions
- ProcessManager lifecycle, cancellation, cleanup, and exit semantics
- capture bounds, model-output truncation, incremental output, and final MCP response-size guards
- permission profiles and native sandbox enforcement required for safe execution
- regression coverage for pipe, PTY, long-running, nonzero-exit, sandbox, and oversized-output behavior

**Milestone 2 — Environment + Remote Worker**

- Environment Registry with a default/session environment
- per-operation `environment_id` override
- one Remote Worker protocol for every execution environment, including the Controller host
- Controller-side worker connection/routing layer; no separate Local Executor path
- worker contract, health/capability metadata, reconnect/disconnect/error classification
- native shell/path/cwd/process/sandbox semantics inside each Remote Worker
- no cross-environment file-transfer feature

**Milestone 3 — Editing**

- CCM-owned Codex-style `apply_patch`
- `view_image` with bounded media output
- selected-environment filesystem semantics
- focused tests for patch application, failure modes, path handling, and image-size limits

**Milestone 4 — Tool Architecture**

- stable small top-level MCP tool surface
- ToolRegistry with independent Direct / Deferred / Code Mode exposure surfaces and derived convenience states
- namespace, provider/provenance, collision rules, and environment requirements
- `tool_search` / deferred capability discovery
- Code Mode execution/wait path for nested capabilities

Completion of Milestones 1-4 defines CCM v0.1's first public release target. The repository should be publishable directly at that point rather than requiring a separate prototype-to-public hardening phase.

### Public release gate

Before v0.1 is tagged or published, all of the following must be true:

- a clean clone can install dependencies, build native helpers, run the full test suite, and start the Controller/Remote Worker using documented commands
- the repository contains no machine-specific secrets, credentials, private endpoints, generated binaries, build outputs, diagnostic state, or absolute developer paths that should not be public
- README documents architecture, supported platforms, current limitations, environment variables, Controller/Worker startup, sandbox behavior, and the stable direct execution/editing plus Tool Architecture surface
- package metadata and repository metadata are suitable for public consumption, and an explicit root license is present
- restricted execution fails closed on unsupported sandbox platforms; no public default silently falls back to unsandboxed execution
- filesystem mutations such as `apply_patch` enforce workspace boundaries including symlink/junction escapes
- command, Worker-protocol, image, and MCP-result sizes have hard upper bounds with compact failures
- MCP returns remain standard protocol results; do not reintroduce custom wrappers such as WCM's historical `resultType` envelope
- tests cover the public MCP path, Remote Worker routing, PTY/session lifecycle, sandboxing, oversized results, patch safety, image validation, disconnect cleanup, and a clean production bootstrap
- `git diff --check`, dependency/audit checks, and repository secret/path scans pass immediately before the release commit

### Later, only if justified by real workflows

- **Plan Mode:** runtime-enforced non-mutating mode
- **Goal:** lightweight durable continuation using Goal Contract + Directive Ledger + Implementation Decisions + Checkpoint
- **Extensions:** MCP resources/child MCP manager, Skills, specialized providers
- **Advanced orchestration:** multi-agent lifecycle, pluggable reviewers/auto-review, richer policy integration

Image generation, web search, full ChatGPT conversation persistence, and cross-environment file transfer remain intentionally outside CCM.
