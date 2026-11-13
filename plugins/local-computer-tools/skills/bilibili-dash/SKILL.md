---
name: bilibili-dash
description: "Use when the user explicitly requests authenticated, high-quality Bilibili video downloading with DASH and local BMG browser."
---

# Bilibili authenticated DASH download

- Computer: **6v** (`DESKTOP-KFL6V1F`)
- BMG CLI: `C:\Users\Songjx\Documents\ChatGPT\browser-mcp-gateway\bmgctl.cmd`
- Workflow and scripts: `C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\tools\bilibili-download\README.md`
- Bridge: `C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\tools\bilibili-download\bridge.py`
- Downloader: `C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\tools\bilibili-download\download-dash.py`

Read the workflow README when the skill is invoked. Use CCM `exec_command` on **6v**, reusing one existing 6v **projectless** workspace for browser, Bridge, and downloader. Do not call public BMG MCP tools (which require separate approval); run `bmgctl.cmd` locally, checking `health` and `get_windows_and_tabs` and retaining the exact task tab ID. For complex browser CLI JSON use UTF-8 `--args-base64` to avoid quoting errors. Verify Bilibili account login (`/x/web-interface/nav` must report `code=0`, `isLogin=true`) and select the highest **actually authorized** DASH video and audio. Do not fall back to anonymous quality.

Signed DASH URLs are redacted by BMGCTL. Start `bridge.py --projectless-handoff` in the same projectless workspace and wait for `BRIDGE_READY`. In the logged-in Bilibili tab, POST JSON `{video_url,audio_url,expected_height}` to `http://127.0.0.1:8765/dash` with `mode:'no-cors'`, `Content-Type:text/plain` and an Origin of `https://www.bilibili.com`; an opaque browser fetch result does not prove receipt. Require the bridge process to print `BRIDGE_RECEIVED`. Do not reveal signed URLs or cookies.

After receipt, run `python.exe <downloader> --projectless-handoff --output <filename.mp4> --browser-tab-id <exact-tab-id>` from the **same** projectless workspace. Use a filename without a path and do not overwrite an existing file. The downloader must verify and pause the actual Bilibili tab **before** transferring, consume/delete the handoff, then use curl, ffmpeg remux and ffprobe to check resolution/audio. Missing pause verification fails closed. Never mix shared and projectless handoff modes. For larger result files, use the retained high-frequency `quark_upload` tool rather than a small-file `publish`.
