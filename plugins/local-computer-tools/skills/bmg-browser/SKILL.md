---
name: bmg-browser
description: "Use BMG for 知乎 (Zhihu) links, 闲鱼 (Xianyu) product searches, 微信公众号 (WeChat Official Account) articles, or when the user explicitly requests BMG. For other tasks prefer lighter tools."
---

# BMG local browser

## Tool selection and authorization

- BMG is relatively slow and resource-heavy. For tasks outside this Skill's `description`, prefer lighter Web, API, and CLI options.
- When the task matches the scenarios in `description`, or the user explicitly asks for BMG, use BMG directly without asking for separate tool-use permission. Continue using BMG for follow-up tasks in the same category without repeated confirmation. When the task changes to another category, choose tools again; do not carry the BMG preference across categories.
- For other categories, do not automatically switch to BMG even if lighter tools fail. If BMG is genuinely necessary, ask the user and use it only after they agree.
- Choosing BMG does not authorize unrelated actions. Follow the user's instructions and all underlying CCM execution and approval requirements; do not add a separate BMG usage-approval step. Check current CLI/browser availability instead of assuming that a previous successful call guarantees availability.

## Local invocation

- Computer: **6v** (`DESKTOP-KFL6V1F`)
- CLI: `C:\Users\Songjx\Documents\ChatGPT\browser-mcp-gateway\bmgctl.cmd`

Use this local CLI through CCM `exec_command` (or locally from Codex), not the separately hosted BMG MCP plugin. The CLI documents the operations (`health`, `workspace`, `call`, `show`, `hide`). For browser tools, use `call TOOL` and `--args-base64 BASE64` for nonempty UTF-8 JSON arguments. The local CLI authenticates to BMG without the public MCP phone/card approval flow; it operates on BMG's ownership-verified dedicated Edge workspace. Do not read internal secrets or call `/internal/*` directly. For BMG-specific procedures, consult `C:\Users\Songjx\Documents\ChatGPT\browser-mcp-gateway\README.md` and `AGENT.md`. Use the CLI's show/hide explicitly when manual login is necessary; do not adopt ordinary Edge windows.
