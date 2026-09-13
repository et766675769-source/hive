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
| 头像 | **正圆**（六边形只属于品牌 logo，头像不用） | 桌面端 `CircleGeometry()` + 白底圆；网页端 `border-radius:50%`；素材按画布 90% 居中摆放再裁剪 |
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

### 两条硬规矩（都踩过坑，别再犯）

**1. 每一处文字都必须显式写 `Foreground`，不要依赖继承。**

`new TextBlock { Text = ... }` 如果不写 `Foreground`，它会继承控件默认色（**黑**）——深色主题下就是黑字压深底，等于没显示。
本项已经因此漏过三处：**部门名、项目名、@ 候选里的名字**。窗口自身也必须有 `Foreground="{DynamicResource Ink}"` 兜底。

**2. 文字颜色只能从这几个键里取，它们全部随主题切换：**

```
Ink（正文）   Ink2（次要）   Ink3（更淡）   Accent（强调）   Danger（错误）
```

判据很简单：**不允许存在"只在浅色下看得清"的文字**。改完主题一定要切到深色扫一眼。


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

## 五、头像合成：按库的约定，外加一次对齐修正

头像库（`D:\随机头像库`，可用 `HIVE_AVATAR_DIR` 覆盖）的约定是「1 张固定脸 + 1 个发型，
都是 256×256，左上角对齐直接 source-over 叠加」。**这条约定必须遵守**，但光靠它出来是歪的：

- 100 个发型是从 AI 图集里按格子裁出来的，每张图里"头的开口"位置差很多：
  实测发帘下沿在 `y=18~161`、开口中轴在 `x=102~147`
- 脸只有一张，于是约 **1/3 的发型会把眼睛整个盖住**，看着就是"发型太大、错位"

所以 `server/align.js` 会现算一个修正量（只读那几张 PNG 的 alpha 通道，零依赖、按 mtime 缓存）：

- 先挪**发型层**：让发帘正好落在眼睛上方 14px、开口中轴对着画布中线
- 发型挪不动（已经贴着画布边）的余量，交给**脸层**补，两层都保证不出画布
- 修正后实测：眼睛被盖住的比例 中位 0% / 均值 0% / 最大 11%（修正前有 32 个发型 >50%）
- 服务端把结果挂在 `/api/state` 每个员工的 `align.hair` / `align.face` 上，桌面端和网页端都按它平移

## 六、其它

- 服务端**零依赖**，只用 Node 内置模块
- 数据全部存在 `data/`，或用户在「设置 → 数据存储位置」里指定的目录
- 桌面端**不内嵌浏览器**：本机 WebView2 与 WPF 窗口内容都渲染不出来，已改为 WPF 原生控件直连服务端 API
