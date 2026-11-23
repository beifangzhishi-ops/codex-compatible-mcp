---
name: after-effects-background
description: "Use when controlling Adobe After Effects (AE) on noha through CCM, especially rendering existing AEP projects without opening the interactive AE window or disturbing the user's foreground desktop."
---

# After Effects 2025: noha 后台调用与渲染

## 已验证环境与结论（2026-11-13，实机测试）

- 机器：**noha**（Windows；不是 6v）。通过 CCM `exec_command`，使用用户已有的 noha workspace handle；不要为本任务切换到 6v。
- AE 安装路径：`C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\`。
- 版本：AE / `aerender` **25.0x53**；`AfterFX.exe`、`AfterFX.com`、`aerender.exe` 均存在。
- **已验证**：当 `AfterFX` 和 `aerender` 都未运行时，独立执行 `aerender.exe`，无需先打开交互式 AE，即可读取已有 `.aep` 工程并渲染出 H.264 MP4。2026-11-13 的测试产物经 `ffprobe` 验证为 320×180、24 fps、24 帧、1 秒，渲染后无 `AfterFX` / `aerender` 进程。
- **前台影响**：独立 `aerender` 测试期间未观察到 AE 前台窗口打开。某次前台句柄发生变化，调查时对应夸克网盘而非 AE；因此不应承诺对所有系统配置绝对不切换焦点。
- **未验证**：完全不干扰前台的自动新建、编辑或保存 `.aep` 工程。尤其**不能**把脚本执行成功直接等同于“无界面成功”。

## 使用方式：仅后台渲染已有工程

1. 用 CCM 检查 `Get-Process AfterFX,aerender -ErrorAction SilentlyContinue`，确认不误用用户已打开的 AE。目标是既不抢前台，也不修改当前打开的项目。
2. 确认 `.aep` 和 `aerender.exe` 存在。用绝对路径指定项目、合成名称、输出文件及日志文件。
3. 独立调用 `aerender.exe`，**不加 `-reuse`**（`-reuse` 会把任务交给已运行的 AE）。使用 `Start-Process ... -WindowStyle Hidden` 隐藏其命令行窗口，日志重定向到文件。
4. 轮询进程退出；检查标准输出里的合成完成信息、标准错误、输出文件是否存在。用 `ffprobe` 验证编解码器、帧数、帧率、分辨率和时长。需要时使用 `ffmpeg` 抽帧并目视检查。
5. 渲染后重新检查 `AfterFX,aerender`，以及用户的前台窗口；不要主动调用 `AppActivate`、`SendKeys` 或点击 AE。

PowerShell 样例（把 `$project`、`$comp`、`$output`、`$logDir` 改为任务实际路径）：

```powershell
$ae = 'C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\aerender.exe'
$project = 'C:\path\to\project.aep'
$comp = 'MyComp'
$output = 'C:\path\to\render.mp4'
$logDir = 'C:\path\to\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$args = '-project "' + $project + '" -comp "' + $comp + '" -output "' + $output + '" -v ERRORS_AND_PROGRESS'
$p = Start-Process -FilePath $ae -ArgumentList $args -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'aerender.stdout.log') `
    -RedirectStandardError (Join-Path $logDir 'aerender.stderr.log') -PassThru
$p.WaitForExit()
"ExitCode=$($p.ExitCode)"
Get-Content (Join-Path $logDir 'aerender.stdout.log') -Tail 30
Get-Content (Join-Path $logDir 'aerender.stderr.log') -Tail 30
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate,nb_frames -of default=noprint_wrappers=1 $output
```

如需指定帧范围，测试中 `-s 0 -e 23` 得到 24 帧。输出格式由 **AE Output Module** 实际设置控制，**不要只靠输出扩展名判断格式**：实测曾请求 `.avi` 路径，但实际生成 `.mp4`。要根据项目输出设置、最终文件及 `ffprobe` 核实。

## 关键失败案例与规避

- `AfterFX.exe -r <jsx>` 和 `AfterFX.com -noui -r <jsx>` 在**已有交互式 AE 进程**的环境中均不能视为纯后台方案。后者尽管脚本已成功创建 AEP，用户仍看到 AE 窗口被带到前台。**用户要求不干扰桌面时，不要尝试这两种命令**。
- `-noui` 并不等于对已有 AE 会话无副作用，不能据此承诺后台自动生成或编辑工程。
- PowerShell 构造 JSX 的字符串时，曾出现 `第 2 行：未终止的字符串常数`。直接检查生成的 `.jsx` 文件；不要让 JS 字符串字面量被换行拆开。推荐用 UTF-8 无 BOM 的完整 here-string，加占位符 `.Replace()` 注入已转 `/` 的路径。例如：`$code = @' ... var f = new File("__RESULT__"); ... '@`，之后 `$code.Replace('__RESULT__', $path.Replace('\','/'))` 并将其一次性写入文件。
- 测试时弹过 `crashpad_handler.exe` 的 `0x80000003` 异常框；**未确认它与 AE 渲染故障的因果关系**。实际独立渲染成功，不能因此认定 AE 不可用，也不应忽略反复出现的异常。
- 做前台焦点诊断时，可记录 `GetForegroundWindow()`、`GetWindowThreadProcessId()` 和 `GetWindowText()`，并对应进程名，而不只比较窗口句柄。用户本身也可能切换窗口。

## 范围与后续

本技能只确认 **已有 `.aep` 的独立后台渲染**。需要完全无界面地制作/修改 AE 工程时，先进行单独的隔离实验，避免破坏或抢占用户当前交互窗口；确认成功前必须明确说明这一能力尚未验证。不应擅自启动 GUI AE、输入键鼠或结束用户已有 AE 进程。
