---
name: illustrator-background
description: "Use when creating, editing, or exporting Adobe Illustrator 2025 files on 6v via CCM without bringing Illustrator to the foreground; includes verified COM and sandbox troubleshooting."
---

# Illustrator 2025：6v 后台 COM 自动化（实测 2026-11-13）

## 已验证结果、适用范围

- 目标电脑：**6v**（`DESKTOP-KFL6V1F`）；通过 CCM `exec_command`，复用用户给出的 6v workspace handle，勿误用 noha。
- **必须通过 CCM `sandbox_permissions="require_escalated"` 在沙箱外执行**；这表示提升 CCM 执行环境权限，**不是** Windows `run_as_admin=true`。实测以当前 `Songjx` 用户、非管理员 token 执行成功，无须 Windows 管理员权限；遵守 CCM 的授权/审批结果，切勿尝试绕过拒绝。
- `Illustrator.Application` 的 COM 启动路径已在 Windows 注册：`C:\Program Files\Adobe\Adobe Illustrator 2025\Support Files\Contents\Windows\Illustrator.exe /Automation`。版本是 Illustrator **29.0.0**。
- **已实测**（6v、沙箱外）：隐藏运行 `cscript.exe` -> `CreateObject("Illustrator.Application")` -> 读取 `Name`、`Version`、`Documents.Count` -> `Quit`；前台窗口句柄未发生变化。
- **已实测真正文件操作**：COM 新建 `Documents.Add`，创建 `doc.TextFrames.Add` 并填文字，`doc.SaveAs` 为 `.ai`，`doc.Close 2`，`app.Quit`；以上操作逐项错误码 0。输出约 **351,836 字节**，文件头为 `%PDF-1.6`（AI 采用 PDF 兼容格式）。测试文件在 6v：`<PhD-CFD workspace>\.cache\background-apps\illustrator_hidden_test.ai`。运行期间前台未被抢占，进程最后退出。
- **未实测**：复杂图层编辑、路径/渐变/嵌入图像、打开已有 AI 进行修改、导出 EPS/SVG/PDF 的稳定性、noha 上沙箱外运行。扩展前逐项小测试并复核实际文件内容。

## 推荐执行步骤（安全约束）

1. `Get-Process Illustrator,cscript -ErrorAction SilentlyContinue` 记录已有进程与 PID；如有用户的活动 Illustrator 会话，先保护该会话，避免 `CreateObject` 意外附着、修改或 `Quit` 用户实例。禁止用 `AppActivate`、`SendKeys`、鼠标操作来抢占前台。
2. 在**允许写入的工作区**中建立 `.cache\illustrator-background`，保存 VBScript、stdout/stderr、日志和测试成果。不要把测试文件写进用户论文正式素材路径。
3. 以单独的 UTF-16LE `.vbs` 文件通过 `Start-Process "$env:windir\System32\cscript.exe" -ArgumentList @('//NoLogo',('"'+$script+'"')) -WindowStyle Hidden -RedirectStandardOutput ... -RedirectStandardError ... -PassThru` 启动（`cmd` 通过 CCM `exec_command`、`sandbox_permissions="require_escalated"` 执行）。隐藏的是 cscript 的控制台窗口；还须**实测** Illustrator 不抢焦点。
4. VBS 先写启动标志日志，`CreateObject("Illustrator.Application")`，对每一步捕获 `Err.Number` / `Err.Description`；完成后仅在明确为自己创建的隔离会话中调用 `app.Quit`。若调用阻塞，继续观察而非重复创建实例。
5. 跟踪 `GetForegroundWindow()` 与 `GetWindowThreadProcessId()`，同时查询 Illustrator 进程 PID；检查日志、实际 `.ai` 文件大小与内容，可抽取文件头/转为可预览格式核验。完成后确认测试进程退出。仅清理测试创建的可验证 PID；**不要**结束用户已有 Illustrator 进程。

## VBScript 最小示例（路径用实际路径替换）

使用 PowerShell here-string 将以下文本保存为 UTF-16LE `.vbs`；替换 `__LOG__` 和 `__OUTPUT__` 为工作区内的 Windows 绝对路径。避免 PowerShell 数组构造时把一个 JS/VBS 字符串字面量错误拆成多行。

```vbscript
On Error Resume Next
Dim fso, log, app, doc, tf
Set fso = CreateObject("Scripting.FileSystemObject")
Set log = fso.OpenTextFile("__LOG__", 2, True)
log.WriteLine "START=" & Now
log.Close
Set app = CreateObject("Illustrator.Application")
Set log = fso.OpenTextFile("__LOG__", 8, True)
If Err.Number <> 0 Then
  log.WriteLine "CREATE_ERROR=" & Err.Number & " " & Err.Description
  log.Close
  WScript.Quit 2
End If
log.WriteLine "VERSION=" & app.Version
Err.Clear
Set doc = app.Documents.Add
log.WriteLine "ADD_DOCUMENT_ERROR=" & Err.Number
If Err.Number = 0 Then
  Err.Clear
  Set tf = doc.TextFrames.Add
  tf.Contents = "CCM background Illustrator test"
  log.WriteLine "ADD_TEXT_ERROR=" & Err.Number
  Err.Clear
  doc.SaveAs "__OUTPUT__"
  log.WriteLine "SAVE_ERROR=" & Err.Number
  doc.Close 2
  log.WriteLine "CLOSE_ERROR=" & Err.Number
End If
Err.Clear
app.Quit
log.WriteLine "QUIT_ERROR=" & Err.Number
log.Close
```

> 生产任务应增加更严格的逐步异常处理和 finally 式清理，异常时不能关闭原本由用户开启的 Illustrator 实例。COM 接口可能长期阻塞，需保留原始 PID/时间以排查。

## 已定位的失败原因和排查路径

- 普通 CCM 沙箱运行 `CreateObject("Illustrator.Application")` 时 6v 最终报 `429 ActiveX 部件不能创建对象`，Windows 系统日志有 DCOM **10010**（`{303D549B-3B36-47B4-8657-1B0374E2F553}` 服务未及时注册）。noha 普通沙箱下也出现 10010，还曾把 Illustrator 带到前台。**不要**据此重复进行会抢前台的 noha 常规启动测试。
- **同一台 6v、同一普通用户**以 `require_escalated` 沙箱外运行，COM 返回 29.0.0，文件创建保存成功。因此本机普通 CCM 沙箱是已确认的关键限制；具体受限的底层系统调用尚未定位。不能把 `429` 一概归因于管理员权限不足。
- `Illustrator.exe` 在两台机器上 `Get-AuthenticodeSignature` 返回 `HashMismatch`，但 `ScriptingSupport.aip` 在 6v 的签名是 `Valid`，且沙箱外自动化成功。**签名异常独立记录，不应断言其导致 COM 429**；不可未经用户许可自行修改软件安装文件或重装。
- 两台电脑都能读到 `Illustrator.Application` 的 ProgID/CLSID/LocalServer32，且基础 COM（`Scripting.FileSystemObject`、`Schedule.Service`）可正常运行。无需盲目重新注册整个 COM 子系统。
