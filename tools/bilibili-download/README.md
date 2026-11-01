# Bilibili authenticated DASH download

Working workflow:

`CCM on 6v -> BMGCTL logged-in Bilibili tab -> DASH selection -> localhost Bridge -> CCM downloader -> curl.exe + ffmpeg -c copy -> ffprobe verified MP4`

**Only 6v (`DESKTOP-KFL6V1F`) supports this handoff**, because its browser, Bridge, handoff file and downloader must run on the same machine. No BMG MCP phone authorization or Bilibili cookie export is needed.

## Browser steps

1. On 6v, invoke `C:\Users\Songjx\AppData\Roaming\npm\bmgctl.cmd health` through CCM, then `call get_windows_and_tabs --args '{}'`. Use `call chrome_navigate` and `call chrome_javascript`; encode nonempty JSON as UTF-8 Base64 and pass `--args-base64 BASE64` to avoid Windows argument quoting errors. Do not use the BMG MCP tools.
2. In the logged-in Bilibili browser, fetch `https://api.bilibili.com/x/web-interface/nav` with `credentials: 'include'`. Require `code: 0` and `data.isLogin: true`. If login is missing, stop instead of falling back to anonymous streams.
3. Resolve the requested BV/CID and get the authenticated DASH `playurl` response. Request high-quality formats where permitted, but compare the *actual* `dash.video` entries rather than trusting the requested `qn`. Choose the best permitted actual video resolution, suitable codec/frame rate and an appropriate high-quality audio representation.
4. Start `tools/bilibili-download/bridge.py` on 6v through CCM with Python and wait for `BRIDGE_READY`. It listens only on `127.0.0.1:8765`, accepts only `https://www.bilibili.com` as Origin, and terminates after a successful transfer or 180 seconds. In the logged-in Bilibili tab, POST using BMGCTL `chrome_javascript`:

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

   Expect HTTP 204 and `BRIDGE_RECEIVED`. Never return signed URLs through BMGCTL: it redacts them. The Bridge writes only to Git-ignored `.cache/bilibili-download/dash_urls.json`, which is consumed and deleted by the downloader, even on failure.
5. Use `tool_search` -> `exec` to call `ccm-extra.bilibili_download_dash` with only `output_path` (a **filename**, e.g. `video.mp4`) and optional `timeout_seconds`. The capability always targets 6v (optional `environment_id: DESKTOP-KFL6V1F`), and creates a writable projectless workspace. **Do not pass an absolute path or a path into another workspace**: the MP4 belongs in the returned `workspace_root`. Reuse the returned `workspace_handle` to publish or access the file. The Python Worker helper downloads through `curl.exe`, remuxes with `ffmpeg -c copy`, checks the actual video height and audio track through `ffprobe`, then moves the verified MP4 to the requested destination. Temporary stream files are cleaned up and signed URLs never enter command arguments or tool results.
6. After any video-page operation, including failures and tests, pause playback via BMGCTL (`document.querySelector('video')?.pause()`), and verify the player is paused. Only close a tab if this workflow opened it; preserve pre-existing tabs.

## Real test

On 6v, the logged-in Bilibili tab for `BV11H4y1Z7UX` returned 1080P video and AAC audio. BMGCTL -> Bridge handed off the signed URLs (HTTP 204). Both direct Python execution in the registered CCM workspace and the real deferred `ccm-extra.bilibili_download_dash` call using a projectless-relative filename produced a 1920x1080 H.264 + AAC MP4 (12,701,104 bytes, 274.218 seconds), verified with ffprobe. The Windows restricted token blocks PowerShell script execution and Python private temporary-directory ACLs in this environment; the active Python downloader writes temporary files directly into an existing writable directory instead.
