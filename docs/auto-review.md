# Guardian auto-review integration (design approved 2026-11-11)

**Current status: design recorded, implementation not started.** CCM still uses its current sandbox, ExecPolicy and approval-card flow. Do not describe the Guardian integration as deployed or end-to-end verified.

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

## Acceptance before implementation is called complete

1. **Live model/tool protocol probe passed via stateless replay (2026-11-11).** Two tool-call/result exchanges and a valid structured final decision are verified. Use explicit input history replay in the future adapter unless another continuation protocol passes its own acceptance; the server-state `previous_response_id` route is not functional in this test. Real CCM integration is still pending.
2. Demonstrate the Reviewer has the same effective tool permissions as the main model, including an authorized non-read-only tool action; no dedicated read-only ceiling and no reviewer privilege inflation.
3. Demonstrate the reviewer accepts the main model's account of user instructions and authorization without independently fetching the original Host conversation.
4. Cover allow/deny, failed JSON, timeout, cancelled review, tool-call failures and denial-limit behavior. On an unavailable or malformed reviewer result, no reviewed command may run; the existing human approval route may be offered.
5. Revalidate frozen command, args, Worker/Workspace and one-shot execution identity at dispatch; never turn a single model allow into persistent `Always allow` or duplicate execution.
6. Run focused Node/Controller/Worker tests and a real disposable end-to-end CPA approval scenario before deployment; update README, AGENTS.md and the upstream parity audit to reflect actual—not planned—status.

## Scope

This design record is **not** an implementation, deployment or service-restart authorization. Do not preserve obsolete compatibility branches or introduce any additional Reviewer restrictions contrary to these decisions.
