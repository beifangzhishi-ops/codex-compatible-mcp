# Bilibili authenticated DASH download

Use the user's **logged-in Bilibili account in BMG** to obtain the highest-quality playable DASH streams, then let CCM download and remux them on a Windows Worker:

`BMG logged-in Bilibili tab -> verify login -> view/playurl -> select DASH video/audio -> ccm-extra.bilibili_download_dash -> ffprobe quality check -> MP4`

## Required browser steps

1. Use BMG's browser tools to open the requested Bilibili video in the existing logged-in browser. BMG authorization is separate from Bilibili login. If BMG requires approval, request it; never work around BMG authorization.
2. Verify the **actual Bilibili login** in that same browser session, for example by requesting `https://api.bilibili.com/x/web-interface/nav` with browser cookies and checking `code === 0` and `data.isLogin === true`. A guest response, expired login, or unauthenticated BMG session is a hard stop. Do not switch to anonymous `playurl`, CLI/cookie-file retrieval, or unauthenticated yt-dlp.
3. Resolve the BV ID and the **correct CID for the requested part** from the Bilibili view response. Obtain the page's actual authenticated `playurl` response with BMG (the web endpoint may require WBI signing). Request DASH and available high-quality formats, including 4K where the account and video permit. Do not mistake the requested `qn` for the delivered quality: in DASH mode select a real entry from `data.dash.video`.
4. Compare the available DASH video entries. Prefer the highest **actual** video resolution; among streams of equal resolution, choose the requested frame rate/format and appropriate quality. Select a compatible audio stream from `data.dash.audio` (and other permitted audio representations when useful). Report the actual chosen height and any quality limitation; do not silently downgrade when login/authorization fails.
5. Pass the selected `baseUrl`/`base_url` (or signed backup URL), audio URL, and `height` from the selected video entry to `ccm-extra.bilibili_download_dash` as `video_url`, `audio_url`, and the **required** `expected_height`. The URLs are short-lived; start the Worker transfer promptly.

## Worker behavior

The Worker uses `curl.exe` with Bilibili Referer and browser User-Agent to download each signed URL, remuxes with `ffmpeg -c copy`, then requires `ffprobe.exe` to confirm the resulting video height is at least `expected_height` **before** moving the completed file into its destination. Missing `ffprobe`, invalid output, or a downgraded video fails the operation instead of publishing low-quality output.

BMG is the only authentication source. CCM never receives browser cookies, Bilibili account credentials, or `SESSDATA`. The downloaded quality cannot exceed the account's permissions or the actual media available for that video. The height check verifies the selected representation was preserved; it does **not** prove that BMG selected the highest available representation. That selection must be checked against the authenticated `playurl` response.
