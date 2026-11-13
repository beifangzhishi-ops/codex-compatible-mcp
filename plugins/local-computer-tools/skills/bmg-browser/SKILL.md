---
name: bmg-browser
description: "Use when the user explicitly asks to use BMG or its managed Edge browser to visit, read or interact with websites."
---

# BMG local browser

- Computer: **6v** (`DESKTOP-KFL6V1F`)
- CLI: `C:\Users\Songjx\Documents\ChatGPT\browser-mcp-gateway\bmgctl.cmd`

Use this local CLI through CCM `exec_command` (or locally from Codex), not the separately hosted BMG MCP plugin. The CLI documents the operations (`health`, `workspace`, `call`, `show`, `hide`). For browser tools, use `call TOOL` and `--args-base64 BASE64` for nonempty UTF-8 JSON arguments. The local CLI authenticates to BMG without the public MCP phone/card approval flow; it operates on BMG's ownership-verified dedicated Edge workspace. Do not read internal secrets or call `/internal/*` directly. For BMG-specific procedures, consult `C:\Users\Songjx\Documents\ChatGPT\browser-mcp-gateway\README.md` and `AGENT.md`. Use the CLI's show/hide explicitly when manual login is necessary; do not adopt ordinary Edge windows.
