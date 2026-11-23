---
name: quark-upload
description: "Use when the user requests uploading local files to 夸克网盘 (Quark Cloud Drive) through the logged-in Windows desktop client."
---

# Quark Cloud Drive desktop upload

- Computer: **6v** (`DESKTOP-KFL6V1F`)
- CLI: `C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\tools\quark-transfer\cloud-transfer.cmd`

Use CCM `exec_command` on 6v and pass the user's intended absolute local file paths. Reuse an existing suitable 6v workspace. Run `probe --json` if the desktop login or local service needs checking.

```powershell
& 'C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\tools\quark-transfer\cloud-transfer.cmd' probe --json
& 'C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\tools\quark-transfer\cloud-transfer.cmd' upload 'C:\path\file.mp4' --timeout 1800 --json
```

The CLI accepts multiple file paths and optional `--no-wait`. By default, wait for completion and verify 100% progress and matching local/remote sizes. For a long-running CCM session, poll it with `write_stdin` using the returned handle and session ID. The upload target is Quark's own `manual_upload` destination.

Requires Quark Desktop for Windows to be running and logged in. The helper supports files, not directories. It uses account/session information only in memory and does not print credentials.

Only use this workflow for Quark upload requests, not automatically based on file size. Other file delivery methods remain independent.
