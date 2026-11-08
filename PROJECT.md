# CCM Project Direction

CCM (**Codex-Compatible MCP**) is an independent MCP execution harness, with Codex upstream as the normative source for behavior outside GPT Host integration.

## Current architecture

CCM is a passive, persistent execution substrate. ChatGPT/GPT Host is the active orchestrator and owns tool discovery, choice, sequencing, concurrency, and conversation context. CCM does not initiate model turns or duplicate the Host's planning/control loop.

- **Execution:** `exec_command`, `write_stdin`, persistent process sessions, pipe and PTY, bounded outputs, native sandbox/approval semantics.
- **Remote Workers:** every machine, including the Controller host, runs a normal Worker with native filesystem and shell behavior. Handles identify a Worker and its registered or projectless context; the Controller routes requests using the handle.
- **Editing:** `apply_patch` and `view_image` work in the selected context with validation and bounded outputs.
- **Tools:** a single `ToolRegistry` registers all 30 present capabilities as peer MCP `tools/list` entries. The Host discovers and invokes them directly; names are unique across namespaces. There are no internal model-facing tool exposure categories or secondary dispatchers. MCP App-only bridge tools are registered but restricted with `ui.visibility=["app"]`.
- **Artifacts:** `publish` serves a safe bounded preview and temporary snapshot download. `import_chatgpt_file` binds the Host's native file object directly to its own `file` input.
- **Project and approval:** project entry and registration require explicit user authorization and no existing usable handle. Frozen approval actions are resolved only through the approval App; timed Full Access grants remain controlled by the owner.
- **Specialized workflows:** conversation import/read/export, file transfer, Gmail, Quark upload, and Bilibili download are ordinary peer tools and preserve their separate authorization constraints.

The Controller's HTTP MCP registration is in `src/controller/mcp-http-server.mjs`. Tool contracts are in `src/tools/`. Worker execution and transport are in `src/worker/`, `src/runtime/`, and the Controller runtime. The source-level Codex parity audit is maintained in `docs/codex-parity.md`.

## Codex parity rule

Read `AGENTS.md` before work. Outside Host-specific integration, use the actual upstream Codex implementation and pinned commit evidence as the behavior reference; do not invent substitutes or retain unapproved incompatible semantics. A module's passing tests never demonstrate full-project parity. The README and parity audit identify the coverage and known gaps.

## Host integration

- The Controller advertises all registered peer tools through the ordinary MCP `tools/list` and `tools/call` contracts.
- Adding, renaming, or changing a tool requires deploying the Controller and refreshing Host tool definitions; newly registered tools do not appear in an already initialized server instance without refresh.
- The Host can orchestrate multiple calls in Code Mode or by its own mechanisms, without CCM implementing another orchestration engine.
- ChatGPT's native attachment binding is expressed through the specific tool's `openai/fileParams` metadata.
- App-only approval/verification reads, submissions, and results have independent MCP App visibility constraints. Sensitive verification input is never carried in model-generated arguments.
- Client behavior and incompatibilities are documented in `README.md`. In particular, Host-side long process polling needs real-client acceptance testing; CCM does not promise reliability beyond the MCP results it actually returns.

## Development and acceptance

Use the scripts in `package.json` for native builds and tests. Test the entire registered-tool inventory, unqualified MCP wire-name uniqueness, direct invocation of each class of formerly internal capability, file metadata bindings, App visibility, project approvals, and process continuation.

A change is complete only after:

1. Targeted tests and the full applicable regression suite pass.
2. `git diff --check` and documented repository consistency checks pass.
3. `README.md` and `AGENTS.md` accurately describe the current behavior.
4. Changes are committed and pushed to the remote repository.
5. 6v and noha use the exact same reviewed commit and their affected services are restarted and healthy. If a Worker is unavailable, report deployment as partial; do not overwrite local changes.

## Release scope

The project aims for a self-contained, publishable release with Controller/Worker transport, sandboxed execution, bounded MCP responses, edit/image operations, and native Host tool integration. It must not store developer secrets or machine-specific private deployment values in Git. Controller and WorkerHub are loopback-bound by default; remote transport requires a trusted/private network until authenticated transport is supported.
