# 蜂群 HIVE · 开发约定

> 这份文件是给后续改动（人也好、AI 也好）看的硬约定。改界面之前先读它。

## 一、界面：一切以圆角为主

**不出现直角块。** 任何新增或修改的界面元素都必须圆角。改动界面时按下表取值：

| 元素 | 圆角 | 说明 |
| --- | --- | --- |
| 按钮 / 输入框 / 下拉框 | **9** | 走 ControlTemplate |
| 小图标按钮（齿轮、箭头） | **8** | |
| 卡片 / 面板 / 弹层 | **12** | |
| 消息气泡 | **12** | |
| 菜单 / 右键菜单 / 菜单项 | **10 / 7** | 外层 10，每项 7 |
| 折叠块（Expander） | **10** | |
| 头像 | **全圆**（size ÷ 2） | |
| 滚动条滑块 / 轨道 | **全圆** | |
| 折叠按钮方块 | **6** | |
| 徽标 / 胶囊（部门人数等） | **999**（胶囊） | |

**实现方式（WPF）**

- 全局样式集中在 `desktop/shell/App.xaml` 的 `Application.Resources`：
  `Button`、`TextBox`、`ComboBox`、`ComboBoxItem`、`ContextMenu`、`MenuItem`、`Expander`、`ScrollBar`
- 页面级样式在 `desktop/shell/MainWindow.xaml` 的 `Window.Resources`（如 `Primary`、`IconButton`）
- 代码里动态创建的控件（部门行、员工行、@ 候选、消息气泡）也必须带 `CornerRadius`
- **不允许**为了图省事直接用控件默认模板——默认模板全是直角

## 二、配色：只走主题资源

所有颜色必须用 `DynamicResource` 引用主题键，**不允许写死颜色值**：

```
Bg  Surface  Surface2
Ink  Ink2  Ink3
Line  LineStrong
Accent  AccentSoft  Hover
CaretBg  CaretBgOpen  CaretLine  CaretInk
BubbleLocal  BubbleLocalLine
Danger  DangerLine
```

浅色与深色两套值定义在 `MainWindow.ApplyTheme()` 里，切换时整屏立刻跟着变（用 `DynamicResource` 才能做到，`StaticResource` 不行）。

## 三、交互约定

- **发送方式**可选 `Enter` 或 `Alt+Enter`，点发送按钮后面的小箭头切换，选择记在 `%LOCALAPPDATA%\Hive\prefs.json`
- 键盘处理挂在 **`PreviewKeyDown`**（挂在 `KeyDown` 会被 TextBox 的类处理器先吃掉）
- **Alt 组合键**在 WPF 里 `e.Key` 是 `Key.System`，真实按键在 `e.SystemKey`
- 输入 `@` 弹出当前对话里的所有人员名单

## 四、员工协作约定

- 员工之间派活**必须**用这一行格式：

  ```
  【派活】@名字：要做什么、交付什么
  ```

- **普通提到名字不触发任何事**。这一点是必须的：经理回答「介绍一下你自己」时会列出下属名字，若按普通 `@` 触发，一开口就把整组叫起来了（实测踩过）
- 链条深度 ≤ 3，且同一条链上不重复派给同一人
- 员工的「职责描述」就是他的提示词，写在 `server/worker.js` 的 `#system()` 里

## 五、其它

- 服务端**零依赖**，只用 Node 内置模块
- 数据全部存在 `data/`，或用户在「设置 → 数据存储位置」里指定的目录
- 桌面端**不内嵌浏览器**：本机 WebView2 与 WPF 窗口内容都渲染不出来，已改为 WPF 原生控件直连服务端 API
