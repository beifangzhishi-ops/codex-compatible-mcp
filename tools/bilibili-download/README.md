# Bilibili authenticated DASH download

Working workflow:

`CCM on 6v -> BMGCTL logged-in Bilibili tab -> DASH selection -> localhost Bridge -> CCM downloader -> curl.exe + ffmpeg -c copy -> ffprobe verified MP4`

**Only 6v (`DESKTOP-KFL6V1F`) supports this handoff**, because its browser, Bridge, handoff file and downloader must run on the same machine. No BMG MCP phone authorization or Bilibili cookie export is needed.

## Browser steps

1. On 6v, invoke `C:\Users\Songjx\AppData\Roaming\npm\bmgctl.cmd health` through CCM, then `call get_windows_and_tabs --args '{}'`. **Record the exact numeric `tabId` for this task.** Prefer navigating to a logged-in **non-video** Bilibili page for API fetches; visiting or playing the requested video is unnecessary. If an existing tab is already showing a video, or navigation opens one, immediately run `chrome_javascript` on that same `tabId` to pause all video elements and confirm they are paused, **before any other step**. Use `call chrome_navigate` and `call chrome_javascript`; encode nonempty JSON as UTF-8 Base64 and pass `--args-base64 BASE64` to avoid Windows argument quoting errors. Do not use the BMG MCP tools.
2. In the logged-in Bilibili browser, fetch `https://api.bilibili.com/x/web-interface/nav` with `credentials: 'include'`. Require `code: 0` and `data.isLogin: true`. If login is missing, stop instead of falling back to anonymous streams.
3. Resolve the requested BV/CID and get the authenticated DASH `playurl` response. Request high-quality formats where permitted, but compare the *actual* `dash.video` entries rather than trusting the requested `qn`. Choose the best permitted actual video resolution, suitable codec/frame rate and an appropriate high-quality audio representation.
4. When an **existing 6v projectless workspace_handle** is available, reuse that exact handle for BMGCTL, Bridge, and the download. Start `tools/bilibili-download/bridge.py --projectless-handoff` through CCM `exec_command` **with that handle** and wait for `BRIDGE_READY`. The Bridge writes `.bilibili-dash-urls.json` inside the same projectless workspace, without crossing into the registered CCM project. Otherwise, start `bridge.py` without the switch (shared Bridge mode). It listens only on `127.0.0.1:8765`, accepts only `https://www.bilibili.com` as Origin, and terminates after a successful transfer or 180 seconds. In the logged-in Bilibili tab, POST using BMGCTL `chrome_javascript`:

   ```javascript
   const response = await fetch('http://127.0.0.1:8765/dash', {
     method: 'POST', mode: 'cors',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       video_url: selectedVideo.baseUrl || selectedVideo.base_url,
       audio_url: selectedAudio.baseUrl || selectedAudio.base_url,
       expected_height: selectedVideo.height,
     }),
   });
   return { ok: response.ok, status: response.status };
   ```

   Expect HTTP 204 and `BRIDGE_RECEIVED`. Never return signed URLs through BMGCTL: it redacts them. The projectless Bridge writes only to its own workspace; the shared Bridge instead writes to Git-ignored `.cache/bilibili-download/dash_urls.json` under the CCM install root. Either handoff is consumed and deleted by the matching downloader, including on failure.
5. Use `tool_search` -> `exec` to call `ccm-extra.bilibili_download_dash` with **required `browser_tab_id`**, taken from `get_windows_and_tabs`, and `output_path` (a **filename**, e.g. `video.mp4`) and optional `timeout_seconds`. For the projectless Bridge mode, also supply **the same existing `workspace_handle`**. In shared Bridge mode, omit `workspace_handle` and the tool creates a fresh projectless workspace. **Do not pass an absolute output path or a path into another workspace.** The downloader first invokes BMGCTL to verify the exact selected Bilibili tab, pause all of its `video` elements, and verify a positive pause acknowledgement. If the tab is missing, points to another site, BMGCTL is unavailable, or pause confirmation is absent, the tool **fails before any media download**. The one-shot handoff is still deleted. After the pause, the Python Worker downloads through `curl.exe`, remuxes with `ffmpeg -c copy`, and checks video height and audio with `ffprobe`. Reuse the returned `workspace_handle` to publish or access the MP4. Never mix handoff modes.
6. Cleanup is **immediate**, not merely an end-of-task reminder. On video page entry and on failures/tests/early returns before invoking the downloader, pause every video element using `chrome_javascript` targeted to this `tabId` and verify `player.paused === true`. Download-tool calls perform their own automatic fail-closed pause; do not rely on that safeguard when the task ends before download. Do not close or pause an unrelated user tab. Only close a tab if this workflow opened it; preserve pre-existing tabs.

## Real test

Offline playback guard tests: `python.exe -B -m unittest discover -s test -p test_bilibili_pause.py`. The CCM restricted Worker currently blocks `node --test` child-process isolation and Node-to-Python `spawnSync` with `EPERM`, so run this Python suite directly (without a Node wrapper). Browser integration requires a functioning BMGCTL connection; a BMGCTL error fails the download closed rather than claiming playback was paused. On 2026-11-05, 6v BMGCTL navigation failed HTTP 502 while recovering its Edge workspace and `get_windows_and_tabs` failed with exit code 2; therefore the live pause could not be verified, although the offline guard tests passed (5/5).

On 6v, the logged-in Bilibili tab for `BV11H4y1Z7UX` returned 1080P video and AAC audio. BMGCTL -> Bridge handed off the signed URLs (HTTP 204). Both direct Python execution in the registered CCM workspace and the real deferred `ccm-extra.bilibili_download_dash` call using a projectless-relative filename produced a 1920x1080 H.264 + AAC MP4 (12,701,104 bytes, 274.218 seconds), verified with ffprobe. The Windows restricted token blocks PowerShell script execution and Python private temporary-directory ACLs in this environment; the active Python downloader writes temporary files directly into an existing writable directory instead.
