# 桌面应用（蜂群 HIVE）

一个轻量外壳（WPF + WebView2）：双击就打开面板，不用记命令、不用开浏览器。

## 它做什么

1. 打开时先看面板是不是已经在跑 —— **在跑就直接连过去**，不重复起一个；
2. 没在跑就自动拉起 `node server/index.js`，等它就绪再显示；
3. 关窗口时，**只停自己拉起的那个进程**（你自己另开的服务器不受影响）。

## 怎么用

### 1. 构建一次（需要 .NET 8 SDK）

```bash
cd desktop/shell
dotnet build -c Release
```

产物：`desktop/shell/bin/Release/net8.0-windows/Hive.Shell.exe`

### 2. 打开面板（任选一种）

- 双击 `desktop/Hive.vbs`（无黑框启动）
- 直接双击 `Hive.Shell.exe`
- 运行 `desktop/install-shortcut.vbs` 在桌面创建带图标的快捷方式

## 依赖

| 依赖 | 用途 | 说明 |
| --- | --- | --- |
| **Node.js ≥ 18** | 跑面板本体 | 外壳会去调 `node` 命令 |
| **Edge WebView2 运行时** | 渲染界面 | Win11 自带；Win10 一般也随 Edge 装好 |
| **.NET 8 SDK** | **仅构建时需要** | 只是想用的话，拿到 exe 就行 |

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `shell/` | WPF 外壳源码（C#） |
| `shell/MainWindow.xaml.cs` | 启动与关闭的全部逻辑 |
| `hive.ico` | 应用图标（16/32/48/64/128/256 六个尺寸） |
| `Hive.vbs` | 无黑框启动器 |
| `install-shortcut.vbs` | 在桌面创建快捷方式 |

> `Hive.vbs` / `install-shortcut.vbs` 用 **UTF-16 LE + BOM** 保存。VBScript 按系统 ANSI 读文件，用 UTF-8 存中文会变乱码 —— 改这两个文件时留意别用 UTF-8 覆盖。
