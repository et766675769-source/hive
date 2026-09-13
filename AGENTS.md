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

## 五、头像：优先用库里的「完整头像」

头像库（默认 `D:\随机头像库`，可用 `HIVE_AVATAR_DIR` 覆盖）现在有两种形态，
`server/index.js` 的 `avatarLibrary()` 按下面优先级自动识别：

| 形态 | 判断依据 | 运行时怎么画 |
| --- | --- | --- |
| **complete**（当前库的形态） | `manifest.mode = "complete-avatar"`，或存在 `avatars/` 目录 | 直接把 `avatars/avatar-XX.png` 当完整头像画，**不再叠图层** |
| composed（老形态） | 有 `face/base-face-reference.png` + `hair/hair-XX.png` | 按库的「组合规则」两层同左上角叠加 |
| flat | 根目录直接放一堆图 | 当完整头像画 |

库的规则要点（见库的 `README.md` 与 `manifest.json`）：

- 完整头像**已经是合成好的**；`face/`、`hair/`、`source/` 只是设计源文件，运行时不要去读；
- 库会声明 `removedAvatarIds`（当前 8 个），这些编号跳过，概率按剩下的个数均分（当前 1/92）；
- 保持 1:1 比例，显示尺寸可统一缩放；透明区域必须保留。

App 侧实现：识别到 complete/flat 时给员工存 `avatar.file`（相对库根的路径，如
`avatars/avatar-63.png`），桌面端与网页端都走「单图 + 白底圆 + 圆形裁剪」那条路；
识别到 composed 时存 `avatar.hair`，走两图叠加那条路。

> **换库形态必须迁移存量员工**：服务器启动时 `migrateAvatarStyle()` 会把还存着 `hair`
> （两层引用）的员工重新分配成完整头像并落盘，否则面板会一直画老形态的图。
> 实测：库换成 92 张完整头像后，13 位员工一次迁移完成且互不撞脸。

> 历史备查：老库是「1 固定脸 + 100 发型」两层叠加，且发型图裁得参差不齐（发帘下沿散布
> `y=18~193`，约 1/3 会盖住眼睛）。当时的结论是**不能靠 App 偷偷平移图层去补**，
> 要修就修库素材 —— 库后来直接重做成了完整头像，这件事就算结了。
> `server/align.js`（量发帘/质心）与 `tools/fix-avatar-library.mjs`（重裁老库发型图）
> 都只对 composed 形态有意义，留作诊断与再生成用。

## 六、其它

- 服务端**零依赖**，只用 Node 内置模块
- 数据全部存在 `data/`，或用户在「设置 → 数据存储位置」里指定的目录
- **图标跟着 Windows 的深浅色自动切换**：窗口/任务栏图标（`Window.Icon`）、托盘图标、
  以及桌面 · 任务栏固定项 · 开始菜单里指向本 exe 的快捷方式图标，都按
  `SystemUsesLightTheme` 选 `desktop/hive-white.ico` 或 `hive-black.ico`；
  启动时算一次，之后由 `SystemEvents.UserPreferenceChanged` 监听系统主题变化再换，
  改完调 `SHChangeNotify` 让资源管理器立刻重读图标
  （exe 自身内嵌的图标运行时改不了，所以快捷方式统一指到 .ico 文件）
- 桌面端**不内嵌浏览器**：本机 WebView2 与 WPF 窗口内容都渲染不出来，已改为 WPF 原生控件直连服务端 API