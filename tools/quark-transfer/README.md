# Quark desktop transfer helper

This optional Windows helper is ported from WCM and is exposed by CCM as deferred capabilities:

- `ccm-extra.quark_probe`
- `ccm-extra.quark_upload`

Requirements:

- Quark Cloud Drive for Windows is running.
- The local Quark desktop client is already logged in.
- Python is available on the Worker.

The helper reuses only the local desktop client's existing login/session state. Account mapping, WSG data, and encrypted request material are used in memory and are not written to tool configuration or printed.

Account resolution supports both the legacy Chromium `atom_user_info` layout and current Quark 7.x cache namespaces. The Quark 7.x fallback reads local `account.json` candidates and identifies the active account only when the current Local Storage / IndexedDB log evidence is unambiguous. It does not export browser cookies or submit probe uploads.

The upload destination is selected by Quark's own `manual_upload` system mechanism. The helper currently accepts files only and does not recursively upload directories.

The original CLI wrappers remain available:

```bat
cloud-transfer.cmd probe --json
cloud-transfer.cmd upload "C:\path\video.mp4" --json
cloud-transfer.cmd upload "C:\a.mp4" "D:\b.zip" --timeout 3600 --json
cloud-transfer.cmd upload "C:\path\video.mp4" --no-wait --json
```
