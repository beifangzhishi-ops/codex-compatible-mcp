# CCM Conversation Tool

The single deferred tool **ccm-extra.conversation** handles public ChatGPT shares, including cloud Work conversations, Codex sharing links, and local Codex threads. No browser automation or BMG is used for importing.

- Import a public share with action `import`, `share_url`, and optional `environment_id` and `branch`. The selected Worker fetches and validates the source, then atomically persists original data and normalized records under ignored `.state/conversations/`. A successful import returns `conversation_id`.
- Read the saved snapshot offline using `thread/read`, `thread/turns/list`, or `thread/items/list` with the returned ID and the same Worker. Lists support `cursor`, `limit`, `sort_direction`, and items support `turn_id` and `mode`. Re-importing refreshes the snapshot; old cursors are rejected.
- For local Codex, supply `thread_id` (UUID) and the Worker environment instead of importing. The configured `codex.home` (default `~/.codex`) restricts lookups to native Codex session and archived-session files.
- Export an imported or local thread with `action=export` and `format=md/json`, `mode=text/full`. Export output is stored under ignored `.cache/conversation/`. It can subsequently be published using `ccm-extra.publish`.

Public-share imports inherit the selected Worker's dynamically reloaded child proxy policy and machine-local CA bundle. Proxy mode provides the same HTTP(S) proxy environment as ordinary commands; direct mode explicitly disables Python's Windows-registry proxy fallback. An explicit import proxy overrides the Worker mode for that request.

ChatGPT shares with serialized conversation mappings preserve upstream records and branch relationships. Newer cloud Work/ChatGPT Share pages may instead expose only server-rendered `data-message-role` containers. CCM then saves the visible user/assistant text and message IDs, excluding hidden controls and recovery placeholders, without storing HTML scripts, browser cookies, or page state. `source_type=chatgpt-rendered` and `source_completeness=rendered-messages-only` are returned by import, read, and list operations; JSON/Markdown exports carry the same limitation. On this fallback, original tool invocations, hidden messages, timestamps, other branches and attachment bytes are not recoverable, even in `mode=full` or `branch=all`. Reading/exporting an imported snapshot remains offline. Local `full` JSON retains native Codex JSONL events.

The Controller checks each Worker's advertised `conversation` capability before sending any request. A Worker without the method receives no request, avoiding `unknown_method` quarantine during staggered deployments.

Example inputs:

```json
{"action":"import","share_url":"https://chatgpt.com/share/EXAMPLE"}
{"action":"thread/read","conversation_id":"share:worker-id:<hash>","environment_id":"worker-id"}
{"action":"thread/turns/list","conversation_id":"share:worker-id:<hash>","environment_id":"worker-id","limit":20}
{"action":"thread/items/list","thread_id":"01a1ad26-84a2-7b91-87bc-32b31a875889","environment_id":"DESKTOP-KFL6V1F","mode":"full","limit":5}
```
