# CCM Project Direction

CCM means **Codex-Compatible MCP**. It is a new project and must remain separate from WCM.

CCM exists to give GPT, through MCP/plugin integration, a tool surface and runtime behavior that resemble the Codex harness as closely as practical. The first priority is model-facing harness compatibility, not Desktop Commander compatibility.

## Current priorities

1. **P0 — Codex-like harness surface and execution semantics.**
2. **P1 — Remote environments, Plan Mode, and persistent Goal execution.**
3. **P1 — Code Mode / ToolRegistry so capabilities can grow without continuously adding top-level MCP tools.**
4. **P2 — Tool discovery / hot capability access when the ChatGPT plugin schema is stale.**
5. **P2 — MCP resource aggregation.**
6. **P3 — Multi-agent orchestration and other advanced runtime features.**

The earlier idea of keeping Desktop Commander tools as the main model-visible API is superseded. CCM may temporarily reuse implementation ideas or adapters, but GPT should primarily see CCM's Codex-like harness.

## Core design principles

- Copy Codex behavior and lifecycle where useful, not merely tool names.
- Keep the top-level model-visible tool surface small, stable, and high-signal.
- Treat remote machines as first-class environments rather than adding a device argument everywhere.
- Keep shell, cwd, path syntax, filesystem semantics, and process state native to the selected environment.
- Do not let the controller reinterpret Windows paths as Linux paths or vice versa.
## Execution core

The initial execution surface should center on:

- `exec_command`
- `write_stdin`
- `apply_patch`
- `view_image`

Normal repository work such as reading files, searching, Git, builds, tests, directory operations, and diagnostics should normally be performed through `exec_command`, matching the Codex style rather than exposing many narrow file/process tools.

`exec_command` must have a real process lifecycle. A still-running command returns a CCM-managed public `session_id`; `write_stdin` resumes or polls that session without requiring the model to re-specify its environment. CCM maps the public session to the underlying worker/process internally.

`apply_patch` should use Codex-style patch grammar and execute against the selected environment filesystem. It is not just an alias for string replacement.

`view_image` reads an image from the selected environment. Image **generation** is intentionally out of scope because ChatGPT already provides a better native image-generation path.

## Remote environment model

Current environments include 6v1f and noha, but the design must support additional workers.

A worker should report environment metadata such as:

- environment id
- operating system
- native shell
- cwd / workspace roots
- process, patch, image, and filesystem capabilities

The existing WCM controller/worker idea is useful conceptually, but CCM is a fresh implementation and should not be constrained by Desktop Commander schemas.
## Plan Mode

Plan Mode is a real CCM session mode, not a cosmetic tool name.

In Plan Mode, repository inspection, searching, and non-destructive validation are allowed. Mutating operations such as `apply_patch` and clearly destructive execution must be blocked or separately gated by the runtime.

Because an MCP server cannot inject exactly the same host-level instructions as Codex, Plan Mode should combine model instructions with server-side enforcement.

A structured user-question mechanism may be added for important planning decisions, but CCM should not pretend to reproduce a native Codex UI if ChatGPT already provides the interaction surface.

## Goal Mode and scheduled continuation

Goal continuity must not depend on the original ChatGPT conversation being available.

CCM therefore needs a persistent GoalStore. A goal checkpoint should preserve at least:

- goal id and objective
- status: active / paused / blocked / complete
- current phase
- completed work
- remaining work
- important decisions and assumptions
- target repository and environment
- last verified repository/runtime state
- blockers and next actions
- optional budget/accounting metadata

The intended continuation driver is a ChatGPT scheduled task. The current desired cadence is hourly, matching the platform's highest scheduling frequency.
Each scheduled run should restore the active CCM goal, inspect the checkpoint, re-verify actual repository state, and continue doing useful work. It must not treat one successful command as completion of the run.

The continuation instruction should explicitly prefer multiple consecutive implementation / verification steps during the available run window, checkpointing before the run ends. The user has observed roughly a 25-minute tool-work window in current usage, but CCM must not hard-code that duration as a guaranteed platform contract.

A run should stop early only when the goal is complete, genuinely blocked, requires user input, or cannot make another justified step.

This is an MCP-compatible approximation of Codex Goal continuation: CCM persists the state, while ChatGPT scheduling starts later turns.

## Code Mode and extensibility

Code Mode is a major design target, not an optional decoration.

CCM should own a ToolRegistry with exposure concepts similar to:

- Direct
- Deferred
- CodeModeOnly
- Hidden

The stable top-level MCP surface should not grow every time CCM gains a specialized capability. Specialized tools should normally become nested ToolRegistry capabilities callable from Code Mode.

This is also the preferred solution to the plugin-refresh problem: new nested capabilities can become usable without requiring ChatGPT to register a brand-new top-level MCP function.

A `tool_search`-style capability should search the current registry and expose relevant deferred/nested capabilities to the model.
## MCP resources

CCM should support Codex-style resource helpers even if no external MCP servers are configured initially:

- `list_mcp_resources`
- `list_mcp_resource_templates`
- `read_mcp_resource`

Long term, CCM may act as an MCP aggregator with its own connection manager for child MCP servers.

## Later work

Multi-agent orchestration is desirable later: agent sessions, messaging, waiting, interruption, cancellation, and result propagation. It is not part of the first execution milestone.

Host-native features that ChatGPT already provides should generally stay outside CCM. In particular:

- do not duplicate ChatGPT image generation
- do not duplicate ChatGPT web search
- do not implement UI-only Codex features merely to copy their names

## Deployment direction

Development is local-first on 6v1f at:

`C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp`

No Git remote should be required during early development. When CCM is ready for external testing, it should receive its own Funnel path, currently planned as:

`/ccm/mcp`

WCM remains a separate project and should not be modified as part of CCM development unless explicitly requested.
## Codex parity gaps found after source review

A second comparison against the current Codex repository found several harness layers that are important enough to add to CCM's roadmap.

### Permission, sandbox, and approval policy

CCM should carry a Codex-style native sandbox backend as a first-class part of the worker runtime.

The model-facing permission semantics should stay close to Codex, while enforcement is platform-native inside each worker:

- Linux: Landlock/seccomp for policies the native backend can enforce, with bubblewrap available for richer filesystem policies.
- Windows: a restricted-token/AppContainer-style backend following Codex's Windows sandbox approach.

The initial policy model should support:

- read-only, workspace-write, and full-access style profiles
- per-environment readable and writable roots
- network permission state
- environment-native cwd/path handling
- explicit refusal rather than silently running unsandboxed when the selected backend cannot enforce a requested policy

Windows sandboxing must be treated as less mature than the Linux path. Known platform limitations, such as locations writable by broad Windows ACLs, must be surfaced rather than hidden.

ChatGPT already applies a host-level safety review before some MCP operations reach CCM. That review is an additional outer layer, not part of CCM's sandbox contract.

CCM auto-review is therefore not required for v1. The approval/reviewer architecture should remain pluggable, but model-based auto-review is P2. A future reviewer may use a dedicated model/provider or another host-supported mechanism. Sandbox enforcement must not depend on reviewer availability.

If an operation requires an approval that CCM cannot safely obtain, a Goal run should checkpoint as blocked rather than bypassing policy.

Sandbox/permission enforcement is P0/P1 and is part of the native CCM worker design. Auto-review itself is later work.
### Session and Turn runtime

Codex has a real Session/Turn execution loop; tool calls are only one part of it. CCM needs a lightweight equivalent for reliable Goal continuation and remote execution.

A CCM session should track at least:

- active mode and active goal
- current environment selection
- active process sessions
- turn/run identifier
- pending or steering input where supported
- cancellation / interruption state
- tool call events and terminal result state
- checkpoint / recovery metadata

A scheduled Goal invocation is a new ChatGPT run, but it should attach to the same persistent CCM goal/session state where appropriate.

CCM should define explicit run termination reasons such as complete, blocked, user-input-required, budget-boundary, interrupted, and failed. These are more useful than relying on a model simply stopping.

### Output budgets and context protection

Codex tracks raw command output separately from model-facing output, including original token count and truncation. CCM should do the same.

Execution results should preserve structured metadata such as:

- chunk id
- wall time
- exit code or live session id
- original token count where available
- omitted/truncated byte or token counts
- bounded model-facing output

Large output should be retained or pageable without flooding the model context. A hard byte cap alone is insufficient.
### Project instructions and Skills

Codex has two important instruction-discovery mechanisms that were missing from the first CCM plan.

**Project instructions:** CCM should recognize scoped repository guidance such as `AGENTS.md`. Instructions should follow directory scope and more-specific nested guidance should override broader guidance.

**Skills:** CCM should eventually support progressively disclosed reusable workflows. A skill should have cheap discovery metadata, load its detailed instructions only when relevant, and optionally include scripts/references/assets.

This does not require copying Codex's exact on-disk implementation immediately, but the runtime architecture should leave a place for an Instruction/Skill resolver instead of putting all behavior into global prompts.

Skills are P2 unless a concrete workflow needs them earlier.

### ToolRegistry namespace and provenance rules

The ToolRegistry must record more than a tool name and schema. It should track:

- provider / owner
- namespace
- exposure: Direct / Deferred / CodeModeOnly / Hidden
- search metadata
- immutable or dynamic schema source
- environment requirements
- destructive/open-world hints where applicable

Name collisions must fail predictably rather than silently overriding another provider. Core CCM tools should own their reserved identities; nested or external providers should retain provenance.
### Events, observability, and recovery

CCM should expose or persist structured runtime events for debugging and scheduled continuation:

- run/turn started and completed
- tool started and completed
- process session created/ended
- warning/error
- approval requested/resolved
- goal checkpoint written
- worker connected/disconnected

The event log is not merely telemetry: it gives Goal continuation enough evidence to distinguish "a command ran" from "the phase was completed".

Worker disconnects and controller restarts should not corrupt the GoalStore. Long-running process sessions may be non-resumable after a worker restart; CCM must mark that explicitly rather than pretending the session still exists.

## Revised implementation order

**Milestone 1 — Harness core:** Environment registry, `exec_command`, `write_stdin`, structured outputs, process/session manager, permission profiles, and the first native sandbox backend(s).

**Milestone 2 — Editing and modes:** `apply_patch`, `view_image`, Plan Mode, session/turn state, repository instruction discovery.

**Milestone 3 — Goal runtime:** persistent GoalStore, checkpoints, run termination reasons, scheduled-continuation contract, observability needed for reliable resume.

**Milestone 4 — Tool architecture:** ToolRegistry, Code Mode `exec/wait`, deferred discovery / `tool_search`, namespace/provenance/collision handling.

**Milestone 5 — Extensions:** MCP resources/child MCP manager, Skills, specialized CodeModeOnly providers.

**Milestone 6 — Advanced orchestration:** multi-agent lifecycle, pluggable approval reviewers/auto-review, and richer policy integration.

Image generation and web search remain intentionally outside CCM because ChatGPT already supplies them.
