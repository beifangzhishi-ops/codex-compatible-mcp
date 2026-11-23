---
name: solidworks-background
description: "Use when diagnosing or controlling SOLIDWORKS 2025 through CCM on 6v without disturbing its foreground session, especially COM startup, hidden application API, and sandbox restrictions."
---

# SOLIDWORKS 2025：6v 沙箱外后台 COM（实测 2026-11-13）

## 已验证事实

- 目标电脑：**6v**（`DESKTOP-KFL6V1F`），使用已有 6v workspace handle；安装 `C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\sldworks.exe`，版本 2025 SP0，COM `RevisionNumber()` 返回 **33.0.0**。
- 通过 CCM `exec_command` 使用 **`sandbox_permissions="require_escalated"`**（跳出普通 CCM 沙箱，**不是** Windows 管理员 `run_as_admin=true`）；遵守 CCM 提权审批。实测执行身份是 `DESKTOP-KFL6V1F\Songjx`、普通用户、中完整性级别，**无需管理员权限**。
- **普通 CCM 沙箱下**运行 `CreateObject("SldWorks.Application")` 最终报 `429 ActiveX 部件不能创建对象`；**同一用户在 CCM 沙箱外**调用成功：`COM_CREATED=2026-11-13 20:25:39`、`RevisionNumber()=33.0.0`、`Visible=False`、`UserControlBackground=False`，属性读取错误码均为 0。
- 测试使用隐藏的 `cscript.exe` 和只读 VBS，记录前台窗口句柄未变化，6v 原有交互式 SOLIDWORKS PID 19076 未被关闭；另起的测试进程曾短暂留存，后已按 PID 清理。
- **尚未验证**：通过隐藏会话创建/编辑 `.SLDPRT/.SLDASM/.SLDDRW`、`OpenDoc6`、导出 STEP/DXF/PDF、重建、工程图更新及 GUI 依赖功能。先在隔离的可写副本上逐项验证，再称“后台建模成功”。

## 操作原则

1. 首先盘点 `Get-Process SLDWORKS -ErrorAction SilentlyContinue | Select Id,StartTime,MainWindowHandle`；**现有用户会话不得调用 `QuitDoc`、`ExitApp`、强杀进程或擅自修改模型**。防止 COM 连接到用户交互进程：隔离测试前记录快照，跟踪新 PID 和启动时间。
2. 用 CCM `exec_command` 的 `sandbox_permissions="require_escalated"` 在当前登录用户下启动隐藏 `cscript.exe`，调用 `CreateObject("SldWorks.Application")`。不要直接用管理员模式，也不要通过提权绕过 CCM 拒绝；必要审批依工具要求处理。
3. 最小探针仅读取 `sw.RevisionNumber`、`sw.Visible`、`sw.UserControlBackground`，每步记录 `Err.Number` 和时间；可按需验证 `GetActiveObject`（此前在普通沙箱下两机均 `MK_E_UNAVAILABLE`）。
4. 只有在确认**独立、专供任务使用**的实例后，才考虑 `Visible = False`、`UserControlBackground = True`、`Frame().KeepInvisible = True`、`DocumentVisible(False, docType)` 及 `OpenDoc6` 的静默选项。上述隐藏与打开文件操作是候选 API 方案，**不属于已完成的本机功能性测试**；在任务级别验证能力与 API 行为，不能认为设置某个属性就保证所有窗口都不会出现。
5. 对新项目先生成临时副本，在工具权限允许的工作区中编辑，完成后验证模型几何与导出文件；对工程图和需要 UI 的功能特别谨慎。监控 `GetForegroundWindow()` 和实际进程归属，不主动 `AppActivate`、`SendKeys` 或点击窗口。
6. 完成后核对进程列表，只清理**本次明确创建的测试实例**。测试前后记录原有 PID，不能按名字批量 `Stop-Process SLDWORKS`。

## VBS 只读探针

用 PowerShell 将下例保存为 UTF-16LE `.vbs`，将 `__LOG__` 替换为可写的工作区绝对路径，使用 `Start-Process $env:windir\System32\cscript.exe -ArgumentList @('//NoLogo', ('"' + $script + '"')) -WindowStyle Hidden -RedirectStandardOutput ... -RedirectStandardError ... -PassThru` 运行。该命令应由 **带 `sandbox_permissions="require_escalated"` 的 CCM `exec_command`** 调用。

```vbscript
On Error Resume Next
Dim fso, log, sw
Set fso = CreateObject("Scripting.FileSystemObject")
Set log = fso.OpenTextFile("__LOG__", 2, True)
log.WriteLine "START=" & Now
log.Close
Set sw = CreateObject("SldWorks.Application")
Set log = fso.OpenTextFile("__LOG__", 8, True)
If Err.Number <> 0 Then
  log.WriteLine "CREATE_ERROR=" & Err.Number & " " & Err.Description
  log.Close
  WScript.Quit 2
End If
log.WriteLine "CREATED=" & Now
Err.Clear
log.WriteLine "REVISION=" & sw.RevisionNumber
log.WriteLine "REVISION_ERROR=" & Err.Number
Err.Clear
log.WriteLine "VISIBLE=" & sw.Visible
log.WriteLine "VISIBLE_ERROR=" & Err.Number
Err.Clear
log.WriteLine "USER_CONTROL_BACKGROUND=" & sw.UserControlBackground
log.WriteLine "BACKGROUND_ERROR=" & Err.Number
log.Close
Set sw = Nothing
```

注意：释放 `sw` 引用不保证 SOLIDWORKS 服务进程自动退出。**禁止**对未确认归属的现有进程做全局退出。

## 差分诊断和风险

- 两机 `SldWorks.Application` 注册到 `{6AF263BB-EB9F-4176-89E9-4F892EB0CA3D}`，`LocalServer32` 是 `C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\sldworks.exe`，两台机器的该文件数字签名 `Valid`。
- 两机普通沙箱能创建基础 COM，例如 `Scripting.FileSystemObject`、`WScript.Shell`、`Schedule.Service`，说明不是全局 COM 禁用。`GetActiveObject` 在先前普通沙箱下返回 `MK_E_UNAVAILABLE`；是否跨进程绑定 ROT 涉及会话和权限，应分别验证。
- 6v 在不改变 Windows 管理员状态下，只从普通 CCM 沙箱切换到 `require_escalated` 即让同一 COM 探针从 429 变为成功。这强烈支持 **CCM 沙箱妨碍 SOLIDWORKS COM 初始化/握手** 的结论，但尚未精确定位受阻的文件或 Windows IPC 调用。
- 使用 `run_as_admin=true` 可能反而造成不同完整性级别下无法连接普通桌面会话；**勿将管理员提权作为默认修复**。
- 若使用 noha，注意其原先存在多个 `SLDWORKS` 进程；本轮 `require_escalated` 成功仅在 6v 验证，不要把 6v 的结果直接当作 noha 已测试成功。
