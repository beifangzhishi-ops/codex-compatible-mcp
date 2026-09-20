# Bilibili DASH download helper

CCM keeps the proven WCM workflow but exposes the download/remux step as a deferred capability:

`authenticated BMG browser session -> Bilibili playurl -> CCM Remote Worker -> curl DASH streams -> ffmpeg -c copy`

The browser side should first confirm that the user is logged in and request the normal Bilibili `view` / `playurl` APIs for content and quality the account is allowed to access. Pass the selected signed DASH video and audio URLs to `ccm-extra.bilibili_download_dash`.

The Worker downloads each signed URL with a Bilibili Referer and normal browser User-Agent, then remuxes the streams into MP4 without re-encoding. Signed URLs expire, so start the Worker download soon after obtaining them.

CCM does not export browser cookies into this helper and does not attempt to bypass Bilibili account or quality restrictions.

`bridge.py` is retained as an optional compatibility helper for older WCM-style browser workflows. The deferred CCM capability does not require it.
