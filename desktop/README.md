# 桌面窗口

Message Board 本体是网页，但你可以把它当成一个**独立桌面窗口**用：双击即弹窗，无边框、无地址栏、无标签页、独立任务栏图标。

这里提供两种外壳，按需取用：

| 方案 | 需要什么 | 适用 |
| --- | --- | --- |
| **A. 应用窗口启动器**（推荐，零依赖） | 本机已装 Chrome / Edge（Chromium 内核） | 所有平台，立刻可用 |
| **B. WPF + WebView2 外壳**（Windows 原生 exe，**无边框**） | .NET 8 SDK 构建 + WebView2 运行时（Win10/11 自带 Edge 即有） | 想要一个真正的 exe、可发快捷方式 |

---

## A. 应用窗口启动器

```powershell
# 双击（无控制台窗口）
desktop\MessageBoard.vbs

# 或手动运行（会显示日志）
powershell -ExecutionPolicy Bypass -File desktop\start-board.ps1
```

行为：

1. 探测 `http://127.0.0.1:8787/api/health`；
2. 未运行则**隐藏**启动 `node server/index.js`（不带控制台窗口），最多等 12 秒；
3. 用 `chrome/msedge --app=http://127.0.0.1:8787` 打开独立窗口，使用专用配置目录 `%LOCALAPPDATA%\MessageBoard\app-window`，不与你日常浏览器混在一起。

参数：

```powershell
desktop\start-board.ps1 -Port 8899        # 换端口
desktop\start-board.ps1 -BrowserTab       # 退回普通浏览器标签页
```

## B. WPF + WebView2 外壳

```powershell
cd desktop\shell
dotnet build -c Release
# 产物：bin\Release\net8.0-windows\MessageBoard.Shell.exe
```

行为：

1. 先探活；未运行则从项目根目录启动 `node server/index.js`（无窗口）；
2. 等黑板就绪后在窗口内用 WebView2 显示黑板；
3. 窗口**无边框**：`WindowStyle=None` + 自绘标题栏（拖动、最小化、最大化、关闭），标题栏配色跟随黑板主题自动切换（页面通过 `chrome.webview.postMessage` 告知主题），边缘仍可拖拽缩放；
4. 找不到项目根目录时读环境变量 `MESSAGE_BOARD_ROOT`，端口可用 `MESSAGE_BOARD_PORT` 覆盖。

> **关闭窗口不会停止服务**：避免把其他正在使用黑板的成员一起切断。要停服务请关掉对应的 node 进程，或用 `tools/mb.js` 之外的方式显式结束。

## 桌面快捷方式

```powershell
powershell -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1
```

会在桌面创建 `Message Board.lnk`：已构建 WPF 外壳时指向 exe，否则指向 `MessageBoard.vbs`。
