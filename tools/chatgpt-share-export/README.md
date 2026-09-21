# ChatGPT Share Export

Pure CCM helper for exporting a public `chatgpt.com/share/...` conversation. It fetches the Share HTML with `curl.exe`, decodes the serialized React Router payload, resolves indexed references, and reconstructs the selected conversation branch. The active branch follows the payload current_node when available and falls back to latest-leaf inference for older payloads. Conversation titles are read from structured payload metadata before falling back to HTML. It does not use BMG or browser automation.

## Modes

- `--mode text` (default): readable conversation body. Keeps visible user/assistant messages. Image-only or other non-text user content is retained with a placeholder instead of being silently dropped.
- `--mode full`: forensic/full-fidelity export of every message record available in the Share payload on the selected branch, including user, assistant, system and tool records. It preserves IDs, parent/children links, author, timestamps, full content payload, plain text, status, end-turn flag, weight, metadata, recipient and channel.

`full` means all information exposed by the public Share payload; it cannot recover information that the Share snapshot did not publish or that was already redacted upstream.

## Branches and formats

- `--branch active` (default): reconstruct the active/latest branch.
- `--branch all`: export every mapping node for forensic/debug use.
- `--format md` (default) or `--format json`.

Example:

```powershell
python tools/chatgpt-share-export/export.py "https://chatgpt.com/share/..." --mode text --format md --output conversation.md
python tools/chatgpt-share-export/export.py "https://chatgpt.com/share/..." --mode full --format json --output conversation.full.json
```

`--output` is required. It may be a bare filename resolved from the current working directory or an explicit relative/absolute path.

Network fetching uses finite curl connect/overall timeouts and honors `HTTP_PROXY` / `HTTPS_PROXY` from the CCM environment.
