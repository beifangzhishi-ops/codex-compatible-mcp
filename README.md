# CCM — Codex-Compatible MCP

CCM is a Codex-inspired execution harness for GPT over MCP, focused on improving coding/execution performance over WCM rather than reproducing Codex's full host/context loop.

## Current first-release target

1. Execution Core — complete.
2. Environment + Remote Worker — complete.
3. Editing — next: `apply_patch` and `view_image`.
4. Tool Architecture — ToolRegistry, deferred discovery, `tool_search`, and Code Mode.

Every execution environment is backed by the same Remote Worker protocol, including the machine that hosts the Controller. The Controller routes by `environment_id`; the Worker owns native shell/path semantics, process/PTY lifecycle, sandbox enforcement, and filesystem access.

The current direct MCP surface is intentionally small:

- `list_environments`
- `exec_command`
- `write_stdin`

Milestone 1 includes Windows native sandboxing, Rust/ConPTY PTY support, interactive sessions, output budgets, incremental output, and final MCP response-size protection.

Milestone 2 includes Remote Worker registration/routing, per-operation environment selection, public-to-worker session mapping, remote-native path preservation, worker disconnect cleanup, transport message limits, and loopback use of the same worker protocol for the Controller host.

The project is intentionally developed locally first. No Git remote is configured yet.

See [PROJECT.md](PROJECT.md) for architecture decisions, Codex source alignment, and the implementation roadmap.
