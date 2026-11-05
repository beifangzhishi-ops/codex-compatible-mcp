# Bilibili authenticated DASH download

Working workflow:

`CCM on 6v -> BMGCTL logged-in Bilibili tab -> DASH selection -> localhost Bridge -> CCM downloader -> curl.exe + ffmpeg -c copy -> ffprobe verified MP4`

**Only 6v (`DESKTOP-KFL6V1F`) supports this handoff**, because its browser, Bridge, handoff file and downloader must run on the same machine. No BMG MCP phone authorization or Bilibili cookie export is needed.

## Browser steps

1. On 6v, invoke `C:\Users\Songjx\AppData\Roaming\npm\bmgctl.cmd health` through CCM, then `call get_windows_and_tabs --args '{}'`. **Record the exact numeric `tabId` for this task.** Use `call chrome_navigate` and `call chrome_javascript`; encode nonempty JSON as UTF-8 Base64 and pass `--args-base64 BASE64` to avoid Windows argument quoting errors. Do not use the BMG MCP tools.
2. In the logged-in Bilibili browser, fetch `https://api.bilibili.com/x/web-interface/nav` with `credentials: 'include'`. Require `code: 0` and `data.isLogin: true`. If login is missing, stop instead of falling back to anonymous streams.
3. Resolve the requested BV/CID and get the authenticated DASH `playurl` response. Request high-quality formats where permitted, but compare the *actual* `dash.video` entries rather than trusting the requested `qn`. Choose the best permitted actual video resolution, suitable codec/frame rate and an appropriate high-quality audio representation.
4. When an **existing 6v projectless workspace_handle** is available, reuse that exact handle for BMGCTL, Bridge, and the download. Start `tools/bilibili-download/bridge.py --projectless-handoff` through CCM `exec_command` **with that handle** and wait for `BRIDGE_READY`. The Bridge writes `.bilibili-dash-urls.json` inside the same projectless workspace, without crossing into the registered CCM project. Otherwise, start `bridge.py` without the switch (shared Bridge mode). It listens only on `127.0.0.1:8765`, accepts only `https://www.bilibili.com` as Origin, and terminates after a successful transfer or 180 seconds. In the logged-in Bilibili tab, POST using BMGCTL `chrome_javascript`:

   ```javascript
   const response = await fetch('http://127.0.0.1:8765/dash', {
     method: 'POST', mode: 'no-cors',
     headers: { 'Content-Type': 'text/plain' },
     body: JSON.stringify({
       video_url: selectedVideo.baseUrl || selectedVideo.base_url,
       audio_url: selectedAudio.baseUrl || selectedAudio.base_url,
       expected_height: selectedVideo.height,
     }),
   });
   return { attempted: response.type === 'opaque' };
   ```

   The browser blocks CORS requests to the local Bridge, so use `no-cors` with a `text/plain` JSON body. The opaque response does **not** reveal status or prove delivery. Require the one-shot Bridge process to print **`BRIDGE_RECEIVED`**, which occurs only after accepting the JSON and sending HTTP 204; otherwise stop. Never return signed URLs through BMGCTL: it redacts them. The projectless Bridge writes only to its own workspace; the shared Bridge instead writes to Git-ignored `.cache/bilibili-download/dash_urls.json` under the CCM install root. Either handoff is consumed and deleted by the matching downloader, including on failure.
5. Use `tool_search` -> `exec` to call `ccm-extra.bilibili_download_dash` with **required `browser_tab_id`**, taken from `get_windows_and_tabs`, and `output_path` (a **filename**, e.g. `video.mp4`) and optional `timeout_seconds`. For the projectless Bridge mode, also supply **the same existing `workspace_handle`**. In shared Bridge mode, omit `workspace_handle` and the tool creates a fresh projectless workspace. **Do not pass an absolute output path or a path into another workspace.** The downloader first invokes BMGCTL to verify the exact selected Bilibili tab, pause all of its `video` elements, and verify a positive pause acknowledgement. If the tab is missing, points to another site, BMGCTL is unavailable, or pause confirmation is absent, the tool **fails before any media download**. The one-shot handoff is still deleted. After the pause, the Python Worker downloads through `curl.exe`, remuxes with `ffmpeg -c copy`, and checks video height and audio with `ffprobe`. Reuse the returned `workspace_handle` to publish or access the MP4. Never mix handoff modes.

## Real test

Offline pre-download pause tests: `python.exe -B -m unittest discover -s test -p test_bilibili_pause.py`. The CCM restricted Worker blocks `node --test` child-process isolation and Node-to-Python `spawnSync` with `EPERM`, so run this Python suite directly (without a Node wrapper). BMGCTL emits UTF-8 JSON, which the Python caller must explicitly decode as UTF-8 instead of using the Windows default GBK codec.

On 2026-11-05, the logged-in Bilibili tab for `BV11H4y1Z7UX` returned `isLogin: true` and an actual 1920x1080 DASH video representation with AAC audio. The `no-cors` browser POST resulted in `BRIDGE_RECEIVED`; the real deferred `ccm-extra.bilibili_download_dash` invoked automatic pre-download pause successfully. The tab was independently checked afterward and reported `paused: true`. `ffprobe` verified the resulting MP4 as **1920x1080 HEVC + AAC, 274.218 seconds, 21,202,061 bytes**. The Windows restricted token blocks PowerShell script execution and Python private temporary-directory ACLs in this environment; the downloader writes temporary streams directly into an existing writable directory. `ccm-extra.publish` cannot publish this 21 MB MP4 because the current send_file limit is 12 MiB; the original local MP4 is intact.
