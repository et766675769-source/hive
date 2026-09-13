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

## 五、头像合成：严格按库的规则来，不许自己平移图层

头像库（`D:\随机头像库`，可用 `HIVE_AVATAR_DIR` 覆盖）的规则写在库的 `README.md` 里，就三条：

1. 先画 `face/base-face-reference.png`，再以**相同的左上角坐标**画任意一个 `hair/hair-XX.png`；
2. 用 PNG 的 alpha 通道做 source-over 合成，**不要裁剪、拉伸或旋转单个图层**；
3. 两个 PNG 必须保持 256×256、**左上角坐标一致**；显示尺寸可以统一缩放。

**App 侧一律照做，不给任何一层加单独的平移/缩放。** 桌面端是 `WrapAvatar()` 把两层放进同一个
`Grid`（同一尺寸、同一中心），网页端是 `.avatar--pic` 里两张 `img` 用同一套 `inset/width`。

已用库自己的预览图对过账：纯叠加的结果缩到预览格子尺寸后，跟 `preview/hair-catalog-100.png`
逐像素比，深色形状 IoU 平均 **0.966**、平均亮度差 **2.7/255** —— 也就是说 App 画出来的就是库的预览。

> 顺带记一笔现状：`server/align.js` 会量每张发型图的"发帘位置 / 发块质心"（只读 PNG 的 alpha，
> 零依赖），结果挂在 `/api/state` 每位员工的 `align` 上。**它只是诊断数据，App 不套用**。
> 量出来的事实是：100 张发型图的发帘下沿分布在 `y=18~193`，而"对齐好的库"应该是同一个值
> （旧库实测中位 19px 间距），因此约 1/3 的发型会把眼睛盖住 —— 这是库素材的问题，
> 要修应该重裁库里的发型图，而不是让 App 偷偷平移图层。已经这么修了：`node tools/fix-avatar-library.mjs`
> 会把每张发型图整幅平移回正确位置（原图备份在库的 `source/hair-original/`，预览图一并重生成），
> 之后 App 依旧是纯叠加。

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
