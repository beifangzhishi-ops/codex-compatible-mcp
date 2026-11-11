# Guardian auto-review integration (implementation staged 2026-11-11)

**Status: integrated in the old CCM Controller and tested locally, disabled by default.** Real CPA adapter has passed but production Worker auto-approval and double-host rollout are separate acceptance gates. Do not call the feature deployed or end-to-end verified until actual running Controller/Worker tests pass.

## Owner-approved decisions

1. **Trust the main Host model's account.** The reviewer accepts the main model's description of the task, user authorization, prior instructions and restrictions. An independent search or authentication of the original Host conversation is not required. The caller supplies task context; do not erect an additional transcript-verification gate.
2. **Use the main model's permissions.** Reviewer tool calls have the same tool access and effective permissions as the main model for the relevant Worker and Workspace. Do **not** impose a dedicated read-only ceiling on reviewer tools. All existing tool, sandbox, saved-policy, grant and approval checks still apply; reviewer status neither expands privileges nor automatically approves its own calls.
3. **Treat CPA model inference as working.** The target model is CPA `codex-auto-review`. The owner's direction is to diagnose function-call/result plumbing, session continuation and tool invocation at the **tool/transport integration layer**, not to replace, retrain, retune or blame the model. This is a design/debugging assignment, not a claim that the exact transport bug is already proved or fixed.

## Source-level investigation and target interfaces

Reference: `C:/Users/Songjx/Documents/ChatGPT/codex-core-mcp` (the separate Codex-derived Rust project).

- Reviewer source: `codex-rs/ext/guardian-reviewer/src/{review.rs,settings.rs,instructions.rs,assessment.rs,completion.rs,execution.rs,model.rs}`.
- Core orchestration: `codex-rs/core/src/guardian/{review.rs,review_session.rs,review_session_setup.rs}`.
- Policy templates: `codex-rs/prompts/templates/guardian/{policy.md,policy_template.md}`.
- Target Controller: `src/controller/{approval-manager.mjs,runtime.mjs}` and `src/runtime/remote-process-manager.mjs`; WorkerHub remains the execution dispatcher.

The source has a `ReviewHost` abstraction and `ReviewerRuntime` trait, but the real Codex implementation also depends on Rust `Session`, `Thread`, `ContextManager`, `ToolRouter` and Codex protocol types. Therefore copying its directory into the JavaScript Controller is not a standalone integration. Prefer source-level porting of policy/prompt, request representation, outcome/schema parser, completion and retry/denial logic, with host-boundary adapters to the existing Controller/Worker architecture. Do not install a second command executor or policy store.

The original action must stay bound to its frozen command, arguments, Worker and Workspace. Reviewer tool calls use the same effective permission rules as main-model tool calls, even for non-read-only work; they do not create lasting `Always allow` authorization. Host summaries are intentionally trusted as review context, though that is not cryptographic evidence of their authorship.

## Verified observations

- CPA `GET /v1/models` returned `codex-auto-review`.
- On 2026-11-11, the real CPA `POST /v1/responses` **stateless full-history replay path passed twice**. The model requested `inspect_example_action`, consumed its simulated result, then requested `inspect_example_authorization`, consumed that result, and returned a valid JSON decision with `outcome: "allow"`. All three inference requests completed successfully; no actual execution or filesystem approval was performed.
- The alternate HTTP `previous_response_id` continuation using `function_call_output` **still fails** with HTTP 400, `No tool call found for function call output`. Thus the currently verified adapter route is **full input history replay**, explicitly including the preceding assistant function calls and tool result messages. This is a **tool-side continuation/adapter** distinction, not a model-generation defect. Root cause of server-state continuation has not been established.
- Reproducible opt-in live probe: `scripts/probe-cpa-auto-review.mjs`. It reads the actual local CPA client key from the sibling CPA project's ignored `config.yaml` (or `CPA_CONFIG`), uses only mock tool results, never prints credentials and never dispatches the action under review. It checks both continuation styles and validates the final decision JSON.
- The separate Codex Core MCP project recorded a native Guardian MCP end-to-end approval PASS on 2026-11-10. That result does not imply the current CCM Controller supports Guardian already.

## Implemented Controller mapping and source parity

- Source baseline inspected: CCMv2 `f7f0c498347ce552f3851437ce013e125468b407` (underlying native Codex snapshot `c983513c1fc79e6a19bc009b3b6e08fbe9ab5367`). Its four concurrent dirty files were **not copied or overwritten**. The Guardian `policy.md` and `policy_template.md` files were verified unchanged at that commit, then copied into `src/controller/guardian-policy.md` and `guardian-policy_template.md`. The existing Codex Apache-2.0 attribution remains in `third_party/openai-codex/LICENSE`.
- `src/controller/guardian-prompts.mjs` reads these policy sources and replaces only the explicit Host evidence-handling and reviewer-permission sections. The original Codex read-only ceiling and authenticated original transcript requirement are deliberately adapted to the two owner-approved choices. Risk taxonomy and ordinary outcome rules remain Codex-derived.
- `guardian-assessment.mjs` ports native `assessment.rs` strict outcome enums and tolerant JSON parsing/defaults. `guardian-retry.mjs` adapts `retry.rs`'s recoverable parse/transport retry and shared deadline. Since reviewer tools now carry the main model's possible write authority, **a review is never automatically retried after any tool invocation**; otherwise a failed inference could duplicate a side effect. The native per-parent-turn denial-history breaker requires a reliable Codex parent turn ID not supplied by the ChatGPT Host; the current implementation does not invent that identity and is not full native Guardian session parity.
- `cpa-review-client.mjs` implements bounded multi-round Responses history replay including `function_call` items, outputs, strict call ID correlation, tool-result error feedback, final JSON schema, deadlines and cancellation. `guardian-tool-dispatcher.mjs` advertises model-visible `ToolRegistry` tool schemas and invokes the **same handlers** with ordinary tool permissions and exact Workspace identity, excluding App-only signed operations. Function results can include text and bounded image inputs; CPA image transport remains an integration follow-up until exercised live.
- `approval-manager.mjs` has atomic Reviewer claim/deny methods bound to the original frozen intent SHA. `remote-process-manager.mjs` calls Guardian before returning a human card and shares its existing one-time `#dispatchClaimedExecution` function with App approval. Reviewer dispatch errors before enqueue return the **same** frozen request to human approval; an in-flight Worker failure enters `execution_unknown` without retry. Reviewer decisions never save permanent native rules.
- `runtime.mjs` constructs the reviewer; `index.mjs` attaches the sole ToolRegistry. The optional `exec_command.review_context` model summary does not reach the Worker command arguments, and the source code never reads Host conversation history. Root `ccm.config.example.json` declares `controller.guardian`, including `enabled=false` and an optional **absolute-path reference** to CPA's local key config rather than a plaintext copied key.

**Test evidence:** `scripts/probe-cpa-guardian-adapter.mjs` completed the real CPA `codex-auto-review` round trip with two function calls, two actual local mock-tool handler executions, three model responses and an accepted `allow` decision. `test/guardian-reviewer.test.mjs` exercises semantic mapping and frozen App/Reviewer state transitions. The existing approval and Codex ExecPolicy suites remained green (42 targeted regression tests on 6v). No protected user command or permanent policy was modified by these probes.

The full serial 6v Node suite passed after implementation: **357 tests, 351 passed, six opt-in skips, zero failures** (`node --test --test-concurrency=1 --test-isolation=none --test-timeout=60000`). This does not yet establish live Controller/Worker automatic approval, or real CPA image-result handling. The parent-turn scoped Codex Guardian denial circuit and async evidence reuse are not present without an authenticated Host turn identity.

## Acceptance before implementation is called complete

1. **CPA/tool adapter test passed via stateless replay (2026-11-11).** Two actual mock tool handlers executed through the new production transport. Full running Controller/Worker approval still needs its deployment acceptance.
2. Demonstrate the Reviewer has the same effective tool permissions as the main model, including an authorized non-read-only tool action; no dedicated read-only ceiling and no reviewer privilege inflation.
3. Demonstrate the reviewer accepts the main model's account of user instructions and authorization without independently fetching the original Host conversation.
4. Cover allow/deny, failed JSON, timeout, cancelled review, tool-call failures and denial-limit behavior. On an unavailable or malformed reviewer result, no reviewed command may run; the existing human approval route may be offered.
5. Revalidate frozen command, args, Worker/Workspace and one-shot execution identity at dispatch; never turn a single model allow into persistent `Always allow` or duplicate execution.
6. Run focused Node/Controller/Worker tests and a real disposable end-to-end CPA approval scenario before deployment; update README, AGENTS.md and the upstream parity audit to reflect actual—not planned—status.

## Production gate

The code is staged but the enabled production state must not be reported complete until 6v's live Controller can review and execute a harmless frozen command, reject a denied one, and survive a simulated CPA failure without executing or doubling a command, and noha has the same synced source commit and remains healthy. Maintain README/AGENTS and this parity audit as tests progress; remove superseded claims rather than layering them indefinitely.
