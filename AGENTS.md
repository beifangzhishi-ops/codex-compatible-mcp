# Repository Instructions

- Do not change the directory structure of tools without explicit user permission.
- When the user needs to restart or rebuild CCM, provide a command that prints the CCM key and current CCM URL in the user's local command line. The command must use absolute paths and must not copy the key into chat.
- On the current 6v1f installation, use the absolute-path PowerShell form below when that handoff is needed:

```powershell
$ccmKey = (Get-Content -LiteralPath 'C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\.state\ccm-approval-secret.txt' -Raw).Trim()
$ccmUrl = ((Get-Content -LiteralPath 'C:\Users\Songjx\Documents\ChatGPT\codex-compatible-mcp\config\ccm.env' | Where-Object { $_ -match '^CCM_RESOURCE=' } | Select-Object -First 1) -replace '^CCM_RESOURCE=', '').Trim().Trim('"')
Write-Output ("CCM key: " + $ccmKey)
Write-Output ("CCM URL: " + $ccmUrl)
```
