# Bilibili authenticated DASH download

Use **BMGCTL on 6v** to reuse the user's logged-in Bilibili browser and obtain the highest-quality playable DASH streams, then let CCM download and remux them on a Windows Worker:

`CCM on 6v -> BMGCTL logged-in Bilibili tab -> verify login -> view/playurl -> select DASH video/audio -> ccm-extra.bilibili_download_dash -> ffprobe quality check -> MP4`

## Required browser steps

1. On 6v through CCM, run the installed BMGCTL executable at `C:\Users\Songjx\AppData\Roaming\npm\bmgctl.cmd`. Start with `health`, then `call get_windows_and_tabs --args '{}'`. Use BMGCTL `call chrome_navigate` and `call chrome_javascript` for browser operations. When passing nonempty JSON from PowerShell to the `.cmd` executable, encode UTF-8 JSON beforehand and pass `--args-base64 BASE64` to preserve quotes. BMGCTL uses the existing browser session and needs no BMG MCP phone-authenticator grant. Do not use the BMG MCP tools in this workflow.
2. Verify the **actual Bilibili login** in that same BMGCTL browser session. For example, call `chrome_javascript` in a Bilibili tab to fetch `https://api.bilibili.com/x/web-interface/nav` with `credentials: 'include'`, returning only `code` and `data.isLogin`. Verification succeeded on 6v with `http: 200`, `code: 0`, `isLogin: true`. A guest response, expired login, or unavailable BMGCTL session is a hard stop. Do not switch to anonymous `playurl`, cookie-file retrieval, or unauthenticated yt-dlp.
3. Resolve the BV ID and the **correct CID for the requested part** from the Bilibili view response. Obtain the page's actual authenticated `playurl` response via BMGCTL (the web endpoint may require WBI signing). Request DASH and available high-quality formats, including 4K where the account and video permit. Do not mistake the requested `qn` for the delivered quality: in DASH mode select a real entry from `data.dash.video`.
4. Compare the available DASH video entries. Prefer the highest **actual** video resolution; among streams of equal resolution, choose the requested frame rate/format and appropriate quality. Select a compatible audio stream from `data.dash.audio` (and other permitted audio representations when useful). Report the actual chosen height and any quality limitation; do not silently downgrade when login/authorization fails.
5. Pass the selected `baseUrl`/`base_url` (or signed backup URL), audio URL, and `height` from the selected video entry to `ccm-extra.bilibili_download_dash` as `video_url`, `audio_url`, and the **required** `expected_height`. The URLs are short-lived; start the Worker transfer promptly.
6. **Always clean up playback** when finished with the Bilibili video page, including after errors and tests. Through BMGCTL `chrome_javascript`, run `document.querySelector('video')?.pause()` and verify `paused === true`; alternatively close the tab **only if this workflow created it**. Preserve pre-existing user tabs and never leave a video autoplaying.

## Worker behavior

The Worker uses `curl.exe` with Bilibili Referer and browser User-Agent to download each signed URL, remuxes with `ffmpeg -c copy`, then requires `ffprobe.exe` to confirm the resulting video height is at least `expected_height` **before** moving the completed file into its destination. Missing `ffprobe`, invalid output, or a downgraded video fails the operation instead of publishing low-quality output.

BMGCTL is the browser login source. CCM never receives browser cookies, Bilibili account credentials, or `SESSDATA`. The downloaded quality cannot exceed the account's permissions or the actual media available for that video. The height check verifies the selected representation was preserved; it does **not** prove that BMGCTL selected the highest available representation. That selection must be checked against the authenticated `playurl` response.
