using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Forms = System.Windows.Forms;
using Drawing = System.Drawing;

namespace Hive.Shell;

/// <summary>
/// 桌面外壳 · 原生界面版。
///
/// 为什么不内嵌浏览器：这台机器上 WebView2 与 WPF 的窗口内容都画不出来（DOM/布局正常、
/// 像素不动），只有独立窗口能渲染。所以这里直接用 WPF 原生控件画界面，
/// 数据全部走已有的本地服务端 API（/api/state、/api/thread、/api/message …）。
/// </summary>
public partial class MainWindow : Window
{
    private const int Port = 8787;
    private static readonly string BaseUrl = $"http://127.0.0.1:{Port}";
    private static readonly string LogDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Hive");
    private static readonly string LogFile = Path.Combine(LogDir, "shell.log");

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };

    private Process? _server;
    private bool _startedByUs;
    private Forms.NotifyIcon? _tray;
    private bool _reallyExit;

    private readonly HashSet<string> _expandedDepartments = new();
    private string _mode = "";
    private string _threadId = "";

    private List<DepartmentInfo> _departments = new();
    private List<EmployeeInfo> _employees = new();
    private List<ProjectInfo> _projects = new();
    private bool _hasKey;

    private DispatcherTimer? _timer;
    private int _mentionStart = -1;
    private bool _suppressMention;
    private List<EmployeeInfo> _mentionPeople = new();
    private bool _altEnterToSend;
    private bool _darkTheme;
    private string _dataDir = "";
    private string _baseUrl = "";
    private string _model = "";
    private string _reasoning = "default";
    // 按职级分配的模型通道（P3 经理 / P2 项目负责人 / P1 普通员工）
    private Dictionary<string, LevelChannelInfo> _levelChannels = new();

    /// <summary>三个职级：P3 最高（经理）→ P2（项目负责人）→ P1（普通员工）。</summary>
    private static readonly (string Label, string Value)[] LevelOptions =
    {
        ("P3 · 经理", "manager"),
        ("P2 · 项目负责人", "lead"),
        ("P1 · 普通员工", "worker"),
    };

    private static string LevelValueOf(string label) =>
        LevelOptions.FirstOrDefault(o => o.Label == (label ?? "")).Value ?? "worker";

    private static string LevelLabelOf(string value) =>
        LevelOptions.FirstOrDefault(o => o.Value == (value ?? "")).Label ?? LevelOptions[2].Label;

    private static string LevelRankOf(string value) => value switch
    {
        "manager" => "P3",
        "lead" => "P2",
        _ => "P1",
    };

    public MainWindow()
    {
        Log("=== 外壳启动（原生界面）===");
        InitializeComponent();

        Loaded += OnLoadedAsync;
        Closing += OnClosing;
        InputBox.TextChanged += OnInputChanged;
        LoadPrefs();
        // 图标跟着 Windows 的深/浅色自动换（任务栏、托盘、桌面与固定项的快捷方式）
        WatchSystemTheme();
        UpdateShortcutIcons();
    }

    /* ── 发送方式：Enter 还是 Alt+Enter，点了立刻生效 ─────── */

    private static readonly string PrefsFile = Path.Combine(LogDir, "prefs.json");

    private void LoadPrefs()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(PrefsFile));
            var root = doc.RootElement;
            if (root.TryGetProperty("altEnterToSend", out var a)) _altEnterToSend = a.GetBoolean();
            if (root.TryGetProperty("darkTheme", out var d)) _darkTheme = d.GetBoolean();
            if (root.TryGetProperty("dataDir", out var p)) _dataDir = p.GetString() ?? "";
        }
        catch
        {
            /* 没有偏好文件就用默认 */
        }
        ApplyTheme();
    }

    private void SavePrefs()
    {
        try
        {
            Directory.CreateDirectory(LogDir);
            File.WriteAllText(PrefsFile, JsonSerializer.Serialize(new
            {
                altEnterToSend = _altEnterToSend,
                darkTheme = _darkTheme,
                dataDir = _dataDir,
            }));
        }
        catch
        {
            /* 存不了只是下次回到默认 */
        }
    }

    /* ── 主题：浅色 / 深色 ───────────────────────────────── */

    private static Brush Themed(string key) => (Brush)Application.Current.Resources[key];

    private void ApplyTheme()
    {
        var res = Application.Current.Resources;
        void Set(string key, string light, string dark)
        {
            res[key] = new SolidColorBrush((Color)ColorConverter.ConvertFromString(_darkTheme ? dark : light)!);
        }

        Set("Bg", "#FAF9F7", "#151517");
        Set("Surface", "#FFFFFF", "#1C1C1F");
        Set("Surface2", "#F3F1ED", "#232327");
        Set("Ink", "#1E1E1E", "#F1F0EC");
        Set("Ink2", "#6B7280", "#A2A2A8");
        Set("Ink3", "#A3A29E", "#77777E");
        Set("Line", "#E9E6E1", "#2A2A2F");
        Set("LineStrong", "#DCD8D0", "#38383F");
        Set("Accent", "#3B82F6", "#74A9FF");
        Set("AccentSoft", "#E9F0FE", "#22304A");
        Set("Hover", "#F3F1ED", "#2B2B31");
        Set("CaretBg", "#E9E6E0", "#33333A");
        Set("CaretBgOpen", "#E2E8F2", "#2A3550");
        Set("CaretLine", "#D6D1C9", "#3E3E46");
        Set("CaretInk", "#5A606A", "#C2C2C8");
        Set("BubbleLocal", "#EFF5FF", "#22304A");
        Set("BubbleLocalLine", "#BFD6FB", "#35507F");
        Set("Danger", "#C2554F", "#E0857E");
        Set("DangerLine", "#E3B4B0", "#6B3E3B");

        UpdateBrandIcon();
        ApplyWindowIcon();   // 任务栏按钮图标也跟着任务栏深浅走
    }

    /// <summary>
    /// 深色底用白图标、浅色底用黑图标 —— 不然深色下黑图标根本看不见。
    /// 品牌 logo 与设置按钮图标都跟着主题走。
    /// </summary>
    private void UpdateBrandIcon()
    {
        var brandFile = _darkTheme ? "hive-icon-white.png" : "hive-icon-black.png";
        var brandPath = FindAsset(brandFile) ?? FindAsset("hive-icon-black.png");
        var brandImage = LoadLocalImage(brandPath);
        if (brandImage is not null)
        {
            BrandIcon.Source = brandImage;
            if (TitleIcon is not null) TitleIcon.Source = brandImage;
        }

        var settingsFile = _darkTheme ? "icon-settings-white.png" : "icon-settings-black.png";
        var settingsImage = LoadLocalImage(FindAsset(settingsFile));
        if (settingsImage is not null && SettingsIcon is not null)
        {
            SettingsIcon.Source = settingsImage;
        }
    }

    /// <summary>从本地文件读图（窗口刚构造时服务端还没起，所以不能用 HTTP 取）。</summary>
    private static BitmapImage? LoadLocalImage(string? path)
    {
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;
        try
        {
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.UriSource = new Uri(path);
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch (Exception error)
        {
            Log($"图片加载失败 {path}：{error.Message}");
            return null;
        }
    }

    /// <summary>点发送按钮后面的小箭头：弹出可以选的发送方式，当前那个打勾。</summary>
    private void OnShowSendModeMenu(object sender, RoutedEventArgs e)
    {
        var menu = new ContextMenu();

        var enter = new MenuItem
        {
            Header = "Enter 发送（Shift+Enter 换行）",
            IsCheckable = true,
            IsChecked = !_altEnterToSend,
        };
        enter.Click += (_, _) => SetSendMode(false);

        var altEnter = new MenuItem
        {
            Header = "Alt+Enter 发送（Enter 换行）",
            IsCheckable = true,
            IsChecked = _altEnterToSend,
        };
        altEnter.Click += (_, _) => SetSendMode(true);

        menu.Items.Add(enter);
        menu.Items.Add(altEnter);
        menu.PlacementTarget = SendModeArrow;
        menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
        menu.IsOpen = true;
    }

    /// <summary>切换发送方式：立刻生效，并记住。</summary>
    private void SetSendMode(bool altEnterToSend)
    {
        _altEnterToSend = altEnterToSend;
        SavePrefs();
        InputBox.Focus();
        Log($"发送方式改为 {(_altEnterToSend ? "Alt+Enter" : "Enter")}");
    }

    /* ── @ 提及：列出当前对话里的所有人 ─────────────────── */

    /// <summary>当前面板"包含的所有人"：部门=部门成员，项目=参与部门的人，员工=他本人。</summary>
    private List<EmployeeInfo> PeopleInContext()
    {
        if (_mode == "department")
            return _employees.Where(e => e.DepartmentId == _threadId).ToList();
        if (_mode == "project")
        {
            var project = _projects.FirstOrDefault(p => p.Id == _threadId);
            if (project is null) return new List<EmployeeInfo>();
            var deptIds = project.DepartmentIds.ToHashSet();
            return _employees.Where(e => deptIds.Contains(e.DepartmentId)).ToList();
        }
        return _employees.Where(e => e.Id == _threadId).ToList();
    }

    private void OnInputChanged(object sender, TextChangedEventArgs e)
    {
        if (_suppressMention) return;
        if (_threadId == "") { HideMentions(); return; }

        var caret = InputBox.CaretIndex;
        var text = InputBox.Text;

        // 从光标往前找最近的 @；中间遇到空白就不算提及
        var start = -1;
        for (var i = caret - 1; i >= 0; i--)
        {
            var ch = text[i];
            if (ch == '@') { start = i; break; }
            if (char.IsWhiteSpace(ch)) break;
        }
        if (start < 0 || caret <= start) { HideMentions(); return; }

        var query = text.Substring(start + 1, caret - start - 1);
        var people = PeopleInContext()
            .Where(p => query == ""
                || p.Name.Contains(query, StringComparison.OrdinalIgnoreCase)
                || (p.Title ?? "").Contains(query, StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (people.Count == 0) { HideMentions(); return; }

        _mentionStart = start;
        ShowMentions(people);
    }

    private void ShowMentions(List<EmployeeInfo> people)
    {
        _mentionPeople = people;
        var panel = new StackPanel();
        foreach (var person in people)
        {
            var content = new StackPanel { Orientation = Orientation.Horizontal };
            content.Children.Add(Avatar(person.Name, person.AvatarSeed, person.AvatarFile, person.AvatarHair, 34));
            content.Children.Add(new TextBlock
            {
                Text = person.Name,
                FontSize = 14,
                Foreground = (Brush)FindResource("Ink"),
                Margin = new Thickness(9, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center,
            });
            if (!string.IsNullOrEmpty(person.Title))
            {
                content.Children.Add(new TextBlock
                {
                    Text = person.Title,
                    FontSize = 11.5,
                    Margin = new Thickness(6, 0, 0, 0),
                    Foreground = (Brush)FindResource("Ink3"),
                    VerticalAlignment = VerticalAlignment.Center,
                });
            }

            var row = new Border
            {
                CornerRadius = new CornerRadius(8),
                Padding = new Thickness(8, 6, 8, 6),
                Cursor = Cursors.Hand,
                Background = Brushes.Transparent,
                Child = content,
            };
            var captured = person;
            row.MouseLeftButtonUp += (_, args) =>
            {
                args.Handled = true;
                InsertMention(captured);
            };
            row.MouseEnter += (_, _) => row.Background = Themed("Hover");
            row.MouseLeave += (_, _) => row.Background = Brushes.Transparent;
            panel.Children.Add(row);
        }
        MentionPanel.Children.Clear();
        MentionPanel.Children.Add(panel);
        MentionPopup.IsOpen = true;
    }

    private void InsertMention(EmployeeInfo person)
    {
        var text = InputBox.Text;
        var caret = Math.Min(InputBox.CaretIndex, text.Length);
        var before = text[.._mentionStart];
        var after = text[caret..];
        _suppressMention = true;
        InputBox.Text = $"{before}@{person.Name} {after}";
        InputBox.CaretIndex = before.Length + person.Name.Length + 2;
        _suppressMention = false;
        HideMentions();
        InputBox.Focus();
    }

    private void HideMentions()
    {
        MentionPopup.IsOpen = false;
        _mentionStart = -1;
    }

    /* ── 日志 ───────────────────────────────────────────── */

    private static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(LogDir);
            File.AppendAllText(LogFile, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}  {message}{Environment.NewLine}");
        }
        catch
        {
            /* 日志写不了不能影响使用 */
        }
    }

    /* ── 启动 ───────────────────────────────────────────── */

    private async void OnLoadedAsync(object sender, RoutedEventArgs e)
    {
        SetupTray();
        ShowStatus("正在准备…");

        var ready = await IsBoardAliveAsync();
        if (!ready)
        {
            ShowStatus("正在启动面板服务…");
            _startedByUs = StartServer();
            Log($"启动服务器：{(_startedByUs ? "已发起" : "失败")}");
            ready = await WaitForBoardAsync(TimeSpan.FromSeconds(45));
        }
        if (!ready)
        {
            ShowStatus("面板服务没能起来。请确认已安装 Node.js（≥18），或在项目目录运行 npm start 查看报错。");
            return;
        }
        Log("面板服务就绪");

        await RefreshStateAsync();

        // 首次使用：没有 Key 也没部门，就引导一下
        if (!_hasKey && _departments.Count == 0)
        {
            await OnOpenSettings();
            if (_departments.Count == 0) await OnAddDepartment();
        }

        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        _timer.Tick += async (_, _) =>
        {
            await RefreshThreadAsync();
            await RefreshStateAsync();
        };
        _timer.Start();
    }

    /// <summary>拉起服务端的命令行；带上用户在设置里指定的数据目录。</summary>
    private string ServerArguments()
    {
        var args = $"server/index.js --port {Port} --host 127.0.0.1";
        if (!string.IsNullOrEmpty(_dataDir)) args += $" --data-dir \"{_dataDir}\"";
        return args;
    }

    private bool StartServer()
    {
        var root = FindProjectRoot();
        if (root is null) return false;
        try
        {
            _server = Process.Start(new ProcessStartInfo
            {
                FileName = "node",
                Arguments = ServerArguments(),
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            return _server is not null;
        }
        catch (Exception error)
        {
            Log($"启动 node 失败：{error.Message}");
            return false;
        }
    }

    private static async Task<bool> IsBoardAliveAsync()
    {
        try
        {
            var response = await Http.GetAsync($"{BaseUrl}/api/state");
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private static async Task<bool> WaitForBoardAsync(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (await IsBoardAliveAsync()) return true;
            await Task.Delay(300);
        }
        return false;
    }

    private static string? FindProjectRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 10 && dir is not null; i++)
        {
            if (File.Exists(Path.Combine(dir.FullName, "server", "index.js"))) return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    private static string? FindAsset(string name)
    {
        var root = FindProjectRoot();
        if (root is null) return null;
        var path = Path.Combine(root, "web", "assets", name);
        return File.Exists(path) ? path : null;
    }

    /* ── 数据 ───────────────────────────────────────────── */

    private sealed record DepartmentInfo(string Id, string Name, string Description);
    private sealed record EmployeeInfo(string Id, string Name, string Title, string Level, string DepartmentId, string Model, string BaseUrl, int AvatarSeed, string AvatarFile, string AvatarHair);

    private sealed record ProjectInfo(string Id, string Name, string Description, string[] DepartmentIds);

    private async Task RefreshStateAsync()
    {
        try
        {
            var text = await Http.GetStringAsync($"{BaseUrl}/api/state");
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;

            var settings = root.GetProperty("settings");
            _hasKey = settings.GetProperty("hasKey").GetBoolean();
            _baseUrl = settings.TryGetProperty("baseUrl", out var bu) ? bu.GetString() ?? "" : "";
            _model = settings.TryGetProperty("model", out var md) ? md.GetString() ?? "" : "";
            _reasoning = settings.TryGetProperty("reasoning", out var rz) ? rz.GetString() ?? "default" : "default";
            _levelChannels = new Dictionary<string, LevelChannelInfo>();
            if (settings.TryGetProperty("levelChannels", out var lc) && lc.ValueKind == JsonValueKind.Object)
            {
                foreach (var level in LevelOptions)
                {
                    if (!lc.TryGetProperty(level.Value, out var item) || item.ValueKind != JsonValueKind.Object) continue;
                    var models = item.TryGetProperty("models", out var ms) && ms.ValueKind == JsonValueKind.Array
                        ? ms.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x != "").ToArray()
                        : System.Array.Empty<string>();
                    _levelChannels[level.Value] = new LevelChannelInfo(
                        models,
                        item.TryGetProperty("baseUrl", out var lb) ? lb.GetString() ?? "" : "",
                        item.TryGetProperty("hasKey", out var hk) && hk.ValueKind == JsonValueKind.True);
                }
            }
            _departments = root.GetProperty("departments").EnumerateArray().Select(d => new DepartmentInfo(
                d.GetProperty("id").GetString() ?? "",
                d.GetProperty("name").GetString() ?? "",
                d.TryGetProperty("description", out var desc) ? desc.GetString() ?? "" : "")).ToList();
            _employees = root.GetProperty("employees").EnumerateArray().Select(e => new EmployeeInfo(
                e.GetProperty("id").GetString() ?? "",
                e.GetProperty("name").GetString() ?? "",
                e.TryGetProperty("title", out var t) ? t.GetString() ?? "" : "",
                e.TryGetProperty("level", out var lv) ? lv.GetString() ?? "worker" : "worker",
                e.TryGetProperty("departmentId", out var dp) ? dp.GetString() ?? "" : "",
                e.TryGetProperty("model", out var m) ? m.GetString() ?? "" : "",
                e.TryGetProperty("baseUrl", out var bu) ? bu.GetString() ?? "" : "",
                e.TryGetProperty("avatar", out var av) && av.TryGetProperty("seed", out var sd) ? sd.GetInt32() : 0,
                e.TryGetProperty("avatar", out var av2) && av2.TryGetProperty("file", out var af) ? af.GetString() ?? "" : "",
                e.TryGetProperty("avatar", out var av3) && av3.TryGetProperty("hair", out var ah) ? ah.GetString() ?? "" : "")).ToList();
            _projects = root.GetProperty("projects").EnumerateArray().Select(p => new ProjectInfo(
                p.GetProperty("id").GetString() ?? "",
                p.GetProperty("name").GetString() ?? "",
                p.TryGetProperty("description", out var pd) ? pd.GetString() ?? "" : "",
                p.TryGetProperty("departmentIds", out var ds)
                    ? ds.EnumerateArray().Select(x => x.GetString() ?? "").ToArray()
                    : System.Array.Empty<string>())).ToList();

            RenderSidebar();

            // 上下文失效就退回第一个部门
            if (_threadId != "" && !ContextExists()) SetContext("department", "");
            if (_threadId == "" && _departments.Count > 0) SetContext("department", _departments[0].Id);
            RenderHeader();
        }
        catch (Exception error)
        {
            Log($"读取状态失败：{error.Message}");
        }
    }

    private bool ContextExists() => _mode switch
    {
        "department" => _departments.Any(d => d.Id == _threadId),
        "employee" => _employees.Any(e => e.Id == _threadId),
        "project" => _projects.Any(p => p.Id == _threadId),
        _ => false,
    };

    private async Task RefreshThreadAsync()
    {
        if (_threadId == "") { MessageList.ItemsSource = null; return; }
        try
        {
            var text = await Http.GetStringAsync($"{BaseUrl}/api/thread?mode={_mode}&id={Uri.EscapeDataString(_threadId)}");
            using var doc = JsonDocument.Parse(text);
            var items = new List<MessageVm>();
            foreach (var m in doc.RootElement.GetProperty("messages").EnumerateArray())
            {
                var from = m.GetProperty("from").GetString() ?? "";
                var kind = m.TryGetProperty("kind", out var k) ? k.GetString() ?? "" : "";
                var status = m.TryGetProperty("status", out var s) ? s.GetString() ?? "" : "";
                var model = m.TryGetProperty("model", out var md) ? md.GetString() ?? "" : "";
                var isLocal = from == "local";
                var failed = kind == "notice" && status == "failed";
                // 发言人的头像：员工才有，"你"自己的消息不带头像
                var speaker = isLocal ? null : _employees.FirstOrDefault(e => e.Id == from);
                items.Add(new MessageVm
                {
                    Who = m.TryGetProperty("fromName", out var n) ? n.GetString() ?? from : from,
                    When = ParseTime(m.TryGetProperty("at", out var a) ? a.GetString() : null),
                    Text = m.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "",
                    Model = model == "" ? "" : $"模型：{model}",
                    ModelVisibility = model == "" ? Visibility.Collapsed : Visibility.Visible,
                    Align = isLocal ? HorizontalAlignment.Right : HorizontalAlignment.Left,
                    Bubble = isLocal ? Themed("BubbleLocal") : Themed("Surface"),
                    BubbleLine = failed ? Themed("DangerLine") : isLocal ? Themed("BubbleLocalLine") : Themed("Line"),
                    TextColor = failed ? Themed("Danger") : kind == "ack" ? Themed("Ink2") : Themed("Ink"),
                    Avatar = speaker is null
                        ? null
                        : Avatar(speaker.Name, speaker.AvatarSeed, speaker.AvatarFile, speaker.AvatarHair, 42),
                    AvatarVisibility = speaker is null ? Visibility.Collapsed : Visibility.Visible,
                });
            }
            MessageList.ItemsSource = items;
            StreamScroll.ScrollToEnd();
        }
        catch (Exception error)
        {
            Log($"读取对话失败：{error.Message}");
        }
    }

    private static string ParseTime(string? iso)
    {
        if (string.IsNullOrEmpty(iso)) return "";
        return DateTime.TryParse(iso, out var t) ? t.ToLocalTime().ToString("HH:mm:ss") : "";
    }

    /* ── 渲染 ───────────────────────────────────────────── */

    private void ShowStatus(string message)
    {
        PanelKind.Text = "";
        PanelTitle.Text = message;
        PanelSub.Text = "";
    }

    private void RenderSidebar()
    {
        // 项目
        ProjectList.ItemsSource = _projects.Select(p => ProjectRow(p)).ToList();
        ProjectEmpty.Visibility = _projects.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        var rows = new List<UIElement>();
        foreach (var department in _departments)
        {
            rows.Add(DepartmentRow(department));
            if (!_expandedDepartments.Contains(department.Id)) continue;
            var members = _employees.Where(e => e.DepartmentId == department.Id).ToList();
            if (members.Count == 0)
            {
                rows.Add(new TextBlock
                {
                    Text = "还没有员工",
                    FontSize = 12,
                    Foreground = (Brush)FindResource("Ink3"),
                    Margin = new Thickness(30, 2, 0, 6),
                });
            }
            foreach (var employee in members) rows.Add(EmployeeRow(employee, 26));
        }
        DepartmentList.ItemsSource = rows;

        var orphans = _employees.Where(e => string.IsNullOrEmpty(e.DepartmentId)).ToList();
        var orphanRows = orphans.Select(e => EmployeeRow(e, 6)).ToList();
        OrphanList.ItemsSource = orphanRows;
        OrphanHeader.Visibility = orphans.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        OrphanList.Visibility = orphans.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private Button ProjectRow(ProjectInfo project)
    {
        var active = _mode == "project" && _threadId == project.Id;
        var button = new Button
        {
            Content = new TextBlock { Text = project.Name, TextTrimming = TextTrimming.CharacterEllipsis, Foreground = (Brush)FindResource("Ink"), VerticalAlignment = VerticalAlignment.Center },
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(0, 1, 0, 1),
            Background = active ? Themed("AccentSoft") : Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(8, 7, 8, 7),
        };
        button.Click += (_, _) => SetContext("project", project.Id);
        button.MouseRightButtonUp += (_, _) => ShowProjectMenu(project, button);
        return button;
    }

    /// <summary>部门行：左边一个明显的方块折叠按钮（只管展开/收起），右边点名字切面板。</summary>
    private UIElement DepartmentRow(DepartmentInfo department)
    {
        var open = _expandedDepartments.Contains(department.Id);
        var active = _mode == "department" && _threadId == department.Id;
        var count = _employees.Count(e => e.DepartmentId == department.Id);

        var grid = new Grid { Margin = new Thickness(0, 3, 0, 3) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        // 折叠按钮：给个底色方块，一眼就能看出"这里能点"
        var caret = new Border
        {
            Width = 22,
            Height = 22,
            CornerRadius = new CornerRadius(6),
            Background = (open ? Themed("CaretBgOpen") : Themed("CaretBg")),
            BorderBrush = Themed("CaretLine"),
            BorderThickness = new Thickness(1),
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(2, 0, 0, 0),
            Cursor = Cursors.Hand,
            ToolTip = open ? "收起这个部门" : "展开这个部门",
            Child = new TextBlock
            {
                Text = open ? "▾" : "▸",
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = Themed("CaretInk"),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };
        caret.MouseLeftButtonUp += (_, args) =>
        {
            args.Handled = true;
            if (open) _expandedDepartments.Remove(department.Id);
            else _expandedDepartments.Add(department.Id);
            RenderSidebar();
        };
        Grid.SetColumn(caret, 0);
        grid.Children.Add(caret);

        // 名字区：点它切到部门面板
        var label = new Border
        {
            CornerRadius = new CornerRadius(8),
            Background = active ? Themed("AccentSoft") : Brushes.Transparent,
            Padding = new Thickness(10, 9, 8, 9),
            Margin = new Thickness(4, 0, 0, 0),
            Cursor = Cursors.Hand,
            Child = new TextBlock { Text = department.Name, FontWeight = FontWeights.Medium, VerticalAlignment = VerticalAlignment.Center, Foreground = (Brush)FindResource("Ink") },
        };
        label.MouseLeftButtonUp += (_, args) =>
        {
            args.Handled = true;
            SetContext("department", department.Id);
        };
        label.MouseRightButtonUp += (_, _) => ShowDepartmentMenu(department, label);
        Grid.SetColumn(label, 1);
        grid.Children.Add(label);

        var badge = new TextBlock
        {
            Text = count.ToString(),
            FontSize = 11.5,
            Foreground = (Brush)FindResource("Ink3"),
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(6, 0, 6, 0),
        };
        Grid.SetColumn(badge, 2);
        grid.Children.Add(badge);

        return grid;
    }

    private Button EmployeeRow(EmployeeInfo employee, double indent)
    {
        var active = _mode == "employee" && _threadId == employee.Id;

        var panel = new StackPanel { Orientation = Orientation.Horizontal };
        panel.Children.Add(Avatar(employee.Name, employee.AvatarSeed, employee.AvatarFile, employee.AvatarHair, 44));
        // 职级徽标：P3 / P2 / P1
        panel.Children.Add(new Border
        {
            Background = Themed("AccentSoft"),
            CornerRadius = new CornerRadius(999),
            Padding = new Thickness(7, 2, 7, 3),
            Margin = new Thickness(12, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
            Child = new TextBlock
            {
                Text = LevelRankOf(employee.Level),
                FontSize = 11,
                FontWeight = FontWeights.SemiBold,
                Foreground = Themed("Accent"),
            },
        });
        // 名字稍大、职位跟在后面且颜色更淡
        panel.Children.Add(new TextBlock
        {
            Text = employee.Name,
            FontSize = 15,
            Margin = new Thickness(8, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
            Foreground = (Brush)FindResource("Ink"),
        });
        if (!string.IsNullOrEmpty(employee.Title))
        {
            panel.Children.Add(new TextBlock
            {
                Text = employee.Title,
                FontSize = 12,
                Margin = new Thickness(8, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = (Brush)FindResource("Ink3"),
            });
        }

        var button = new Button
        {
            Content = panel,
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(indent, 4, 0, 4),
            Background = active ? Themed("AccentSoft") : Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(8, 8, 8, 8),
            ToolTip = string.IsNullOrEmpty(employee.Title) ? null : employee.Title,
        };
        button.Click += (_, _) => SetContext("employee", employee.Id);
        button.MouseRightButtonUp += (_, _) => ShowEmployeeMenu(employee, button);
        return button;
    }

    /// <summary>
    /// 头像三层优先：组装式（固定脸型 + 随机发型，两图叠加）→ 现成图片 → 种子色块 + 首字。
    /// 组装规则跟头像库的约定一致：先画脸，再把发型以相同左上角叠加（PNG alpha 合成）。
    /// </summary>
    private static UIElement Avatar(string name, int seed, string file, string hair, double size)
    {
        if (!string.IsNullOrEmpty(hair))
        {
            var face = LoadAvatarImage($"{BaseUrl}/api/avatar/face/base-face-reference.png");
            var hairImage = LoadAvatarImage($"{BaseUrl}/api/avatar/hair/{Uri.EscapeDataString(hair)}");
            if (face is not null && hairImage is not null)
            {
                return WrapAvatar(new[] { face, hairImage }, size);
            }
        }

        if (!string.IsNullOrEmpty(file))
        {
            var image = LoadAvatarImage($"{BaseUrl}/api/avatar/{Uri.EscapeDataString(file)}");
            if (image is not null)
            {
                return WrapAvatar(new[] { image }, size);
            }
        }

        // 兜底：种子色相 + 名字首字
        return new Border
        {
            Width = size,
            Height = size,
            Clip = CircleGeometry(size),
            Background = AvatarBrush(seed),
            VerticalAlignment = VerticalAlignment.Center,
            Child = new TextBlock
            {
                Text = string.IsNullOrEmpty(name) ? "?" : name[..1],
                Foreground = Brushes.White,
                FontSize = size * 0.44,
                FontWeight = FontWeights.SemiBold,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };
    }

    /// <summary>头像统一用正圆裁剪（不再是六边形；六边形只属于品牌 logo）。</summary>
    private static Geometry CircleGeometry(double size)
    {
        var geometry = new EllipseGeometry(new Point(size / 2, size / 2), size / 2, size / 2);
        geometry.Freeze();
        return geometry;
    }

    private static readonly Dictionary<string, BitmapImage> AvatarImages = new();

    /// <summary>把头像图取到本地缓存（图都很小，同步取一次即可）。</summary>
    private static BitmapImage? LoadAvatarImage(string url)
    {
        if (AvatarImages.TryGetValue(url, out var cached)) return cached;
        try
        {
            var bytes = Http.GetByteArrayAsync(url).GetAwaiter().GetResult();
            using var stream = new MemoryStream(bytes);
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.StreamSource = stream;
            image.EndInit();
            image.Freeze();
            AvatarImages[url] = image;
            return image;
        }
        catch (Exception error)
        {
            Log($"头像加载失败 {url}：{error.Message}");
            return null;
        }
    }

    /// <summary>
    /// 把头像图统一包装成"圆形头像"：
    ///   底层  纯白正圆实底（不是线框；黑白线条头像需要一块白底才立得出来）
    ///   中间  头像图层，按画布宽度的 90% 缩放并居中
    /// 缩放系数由素材本身决定：脸 + 发型合成后最远像素约在画布宽度的 0.54 半径处，
    /// 乘 0.9 后落在圆的 0.5 半径内，所以既不会被切边，也不会被拉伸变形。
    /// 顺序：先按原比例摆正、最后才裁剪，比例不会被带偏。
    /// faceShift/hairShift 保留为空参数：库的「组合规则」要求两层以**相同的左上角坐标**
    /// 直接 source-over 叠加、不要裁剪/拉伸/旋转单个图层。
    /// 所以这里两层都按同一个方框、同一个中心摆放，不做任何单独平移。
    /// </summary>
    private static UIElement WrapAvatar(IEnumerable<ImageSource> layers, double size)
    {
        var art = size * 0.92;
        var stack = new Grid { Width = size, Height = size };

        stack.Children.Add(new System.Windows.Shapes.Ellipse
        {
            Width = size,
            Height = size,
            Fill = Brushes.White,
        });

        foreach (var source in layers)
        {
            stack.Children.Add(new Image
            {
                Source = source,
                Width = art,
                Height = art,
                Stretch = Stretch.Uniform,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            });
        }

        return new Border
        {
            Width = size,
            Height = size,
            Clip = CircleGeometry(size),
            VerticalAlignment = VerticalAlignment.Center,
            Child = stack,
        };
    }

    private static Brush AvatarBrush(int seed)
    {
        var hue = Math.Abs(seed) % 360;
        return new SolidColorBrush(HslToRgb(hue, 0.52, 0.56));
    }

    private static Color HslToRgb(double h, double s, double l)
    {
        var c = (1 - Math.Abs(2 * l - 1)) * s;
        var x = c * (1 - Math.Abs((h / 60) % 2 - 1));
        var m = l - c / 2;
        double r, g, b;
        if (h < 60) { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }
        return Color.FromRgb((byte)((r + m) * 255), (byte)((g + m) * 255), (byte)((b + m) * 255));
    }

    private void SetContext(string mode, string id)
    {
        _mode = mode;
        _threadId = id;
        // 注意：这里不强制展开。之前加上"展开"会导致部门永远收不起来——
        // 展开/收起只归左边那个方块按钮管。
        RenderSidebar();
        RenderHeader();
        _ = RefreshThreadAsync();
    }

    private void RenderHeader()
    {
        if (_threadId == "")
        {
            ShowStatus(_departments.Count == 0 ? "先建一个部门，再添加员工" : "在左侧选一个部门或员工");
            return;
        }
        if (_mode == "department")
        {
            var d = _departments.FirstOrDefault(x => x.Id == _threadId);
            PanelKind.Text = "部门";
            PanelTitle.Text = d?.Name ?? "部门";
            var members = _employees.Count(e => e.DepartmentId == _threadId);
            PanelSub.Text = string.IsNullOrEmpty(d?.Description) ? $"{members} 位成员" : $"{d!.Description} · {members} 位成员";
        }
        else if (_mode == "project")
        {
            var p = _projects.FirstOrDefault(x => x.Id == _threadId);
            PanelKind.Text = "项目";
            PanelTitle.Text = p?.Name ?? "项目";
            var depts = (p?.DepartmentIds ?? System.Array.Empty<string>())
                .Select(id => _departments.FirstOrDefault(d => d.Id == id)?.Name)
                .Where(n => !string.IsNullOrEmpty(n));
            var parts = new List<string>();
            if (!string.IsNullOrEmpty(p?.Description)) parts.Add(p!.Description);
            var deptText = string.Join("、", depts);
            if (deptText != "") parts.Add($"参与部门：{deptText}");
            PanelSub.Text = parts.Count > 0 ? string.Join(" · ", parts) : "在这个项目的面板里说任务，@负责人 即可";
        }
        else
        {
            var e = _employees.FirstOrDefault(x => x.Id == _threadId);
            var dept = _departments.FirstOrDefault(d => d.Id == e?.DepartmentId);
            PanelKind.Text = "员工";
            PanelTitle.Text = e?.Name ?? "员工";
            PanelSub.Text = string.Join(" · ", new[] { dept?.Name, e?.Title, e?.Model == "" ? "默认模型" : e?.Model }
                .Where(x => !string.IsNullOrEmpty(x)));
        }
    }

    /* ── 交互 ───────────────────────────────────────────── */

    private async void OnSend(object sender, RoutedEventArgs e) => await SendAsync();

    private async void OnInputKeyDown(object sender, KeyEventArgs e)
    {
        // Alt 组合键在 WPF 里 Key 会变成 System，真实按键在 SystemKey —— 不处理这个
        // 就永远收不到 Alt+Enter。
        var key = e.Key == Key.System ? e.SystemKey : e.Key;

        if (key == Key.Escape && MentionPopup.IsOpen)
        {
            e.Handled = true;
            HideMentions();
            return;
        }
        if (key == Key.Tab && MentionPopup.IsOpen)
        {
            // Tab 补全第一个候选，不用鼠标
            e.Handled = true;
            InsertMention(_mentionPeople[0]);
            return;
        }
        if (key == Key.Enter)
        {
            var modifiers = Keyboard.Modifiers;
            var hasAlt = (modifiers & ModifierKeys.Alt) != 0;
            var hasShift = (modifiers & ModifierKeys.Shift) != 0;
            // 按当前发送方式判断这次回车算不算"发送"；不算就放它正常换行
            var isSend = _altEnterToSend ? hasAlt : !hasShift && !hasAlt;
            if (!isSend) return;

            e.Handled = true;
            // 候选还开着时，先补全第一个，而不是直接发出去
            if (MentionPopup.IsOpen && _mentionPeople.Count > 0)
            {
                InsertMention(_mentionPeople[0]);
                return;
            }
            await SendAsync();
        }
    }

    private async Task SendAsync()
    {
        var text = InputBox.Text.Trim();
        if (text == "" || _threadId == "") return;
        SendButton.IsEnabled = false;
        try
        {
            var body = JsonSerializer.Serialize(new { mode = _mode, threadId = _threadId, text });
            var response = await Http.PostAsync($"{BaseUrl}/api/message",
                new StringContent(body, Encoding.UTF8, "application/json"));
            if (!response.IsSuccessStatusCode)
            {
                Log($"发送失败：{response.StatusCode}");
            }
            InputBox.Text = "";
            await RefreshThreadAsync();
        }
        catch (Exception error)
        {
            Log($"发送异常：{error.Message}");
        }
        finally
        {
            SendButton.IsEnabled = true;
        }
    }

    private async void OnAddDepartment(object sender, RoutedEventArgs e) => await OnAddDepartment();

    private async void OnAddProject(object sender, RoutedEventArgs e)
    {
        var dialog = new FormDialog("新建项目", new[]
        {
            new FormField("name", "项目名字", "例如 官网改版"),
            new FormField("description", "项目说明（可留空）", ""),
        });
        if (dialog.ShowDialog() != true) return;
        var v = dialog.Values;
        try
        {
            var body = JsonSerializer.Serialize(new
            {
                name = v["name"],
                description = v["description"],
                departmentIds = _departments.Select(d => d.Id).ToArray(),
            });
            await Http.PostAsync($"{BaseUrl}/api/project", new StringContent(body, Encoding.UTF8, "application/json"));
            await RefreshStateAsync();
            Log($"已建项目：{v["name"]}");
        }
        catch (Exception error)
        {
            MessageBox.Show($"建项目失败：{error.Message}", "蜂群 HIVE");
        }
    }

    private void ShowProjectMenu(ProjectInfo project, UIElement anchor)
    {
        var menu = new ContextMenu();
        var rename = new MenuItem { Header = "改名 / 改说明…" };
        rename.Click += async (_, _) =>
        {
            var dialog = new FormDialog($"设置 · {project.Name}", new[]
            {
                new FormField("name", "项目名字", "", project.Name),
                new FormField("description", "项目说明", "", project.Description),
            });
            if (dialog.ShowDialog() != true) return;
            var v = dialog.Values;
            await Http.PostAsync($"{BaseUrl}/api/project", new StringContent(
                JsonSerializer.Serialize(new { id = project.Id, name = v["name"], description = v["description"] }),
                Encoding.UTF8, "application/json"));
            await RefreshStateAsync();
        };
        var delete = new MenuItem { Header = "删除项目" };
        delete.Click += async (_, _) =>
        {
            if (MessageBox.Show($"确定删除项目「{project.Name}」？对话会保留。",
                    "蜂群 HIVE", MessageBoxButton.OKCancel) != MessageBoxResult.OK) return;
            await Http.PostAsync($"{BaseUrl}/api/project/delete",
                new StringContent(JsonSerializer.Serialize(new { id = project.Id }), Encoding.UTF8, "application/json"));
            await RefreshStateAsync();
        };
        menu.Items.Add(rename);
        menu.Items.Add(delete);
        menu.PlacementTarget = anchor;
        menu.IsOpen = true;
    }

    private async Task OnAddDepartment()
    {
        var dialog = new FormDialog("新建部门", new[]
        {
            new FormField("name", "部门名字", "例如 研发部"),
            new FormField("description", "部门职责（可留空）", ""),
        });
        if (dialog.ShowDialog() != true) return;
        var values = dialog.Values;
        try
        {
            var body = JsonSerializer.Serialize(new { name = values["name"], description = values["description"] });
            await Http.PostAsync($"{BaseUrl}/api/department", new StringContent(body, Encoding.UTF8, "application/json"));
            await RefreshStateAsync();
            Log($"已建部门：{values["name"]}");
        }
        catch (Exception error)
        {
            MessageBox.Show($"建部门失败：{error.Message}", "蜂群 HIVE");
        }
    }

    private async void OnAddEmployee(object sender, RoutedEventArgs e) => await OnAddEmployee();

    private async Task OnAddEmployee()
    {
        if (_departments.Count == 0)
        {
            MessageBox.Show("请先建一个部门，员工要挂在部门下。", "蜂群 HIVE");
            return;
        }
        var departmentOptions = _departments.ToDictionary(d => d.Name, d => d.Id);
        var dialog = new FormDialog("添加员工", new[]
        {
            new FormField("name", "名字", "例如 李四"),
            new FormField("title", "职能", "例如 后端工程师"),
            new FormField("level", "职级（P3 最高）", "", "P1 · 普通员工",
                LevelOptions.Select(o => o.Label).ToArray()),
            new FormField("department", "所属部门", "", _departments[0].Name, _departments.Select(d => d.Name).ToArray()),
            new FormField("description", "职责描述（可留空）", ""),
            new FormField("model", "模型（留空用全局默认）", ""),
            new FormField("apiKey", "API Key（留空用全局的）", "", "", null, true),
        });
        if (dialog.ShowDialog() != true) return;
        var v = dialog.Values;
        var level = LevelValueOf(v["level"]);
        try
        {
            var body = JsonSerializer.Serialize(new
            {
                name = v["name"],
                title = v["title"],
                level,
                departmentId = departmentOptions.TryGetValue(v["department"], out var id) ? id : "",
                description = v["description"],
                model = v["model"],
                apiKey = v["apiKey"],
            });
            var response = await Http.PostAsync($"{BaseUrl}/api/employee",
                new StringContent(body, Encoding.UTF8, "application/json"));
            if (!response.IsSuccessStatusCode)
            {
                MessageBox.Show($"添加失败：{await response.Content.ReadAsStringAsync()}", "蜂群 HIVE");
                return;
            }
            await RefreshStateAsync();
            Log($"已加员工：{v["name"]}");
        }
        catch (Exception error)
        {
            MessageBox.Show($"添加失败：{error.Message}", "蜂群 HIVE");
        }
    }

    private void OnToggleOrphans(object sender, RoutedEventArgs e)
    {
        OrphanList.Visibility = OrphanList.Visibility == Visibility.Visible
            ? Visibility.Collapsed
            : Visibility.Visible;
    }

    /* ── 应用设置：主题 / 开机启动 / 存储位置 / 全局 API ──── */

    private async void OnOpenAppSettings(object sender, RoutedEventArgs e)
    {
        var autoStart = IsAutoStart();
        var dialog = new SettingsWindow(
            _darkTheme,
            autoStart,
            _dataDir,
            _hasKey,
            string.IsNullOrEmpty(_baseUrl) ? "https://api.deepseek.com" : _baseUrl,
            string.IsNullOrEmpty(_model) ? "deepseek-chat" : _model,
            string.IsNullOrEmpty(_reasoning) ? "default" : _reasoning,
            _levelChannels)
        {
            Owner = this,
        };
        if (dialog.ShowDialog() != true) return;

        // 主题：立刻生效
        var wantDark = dialog.DarkTheme;
        if (wantDark != _darkTheme)
        {
            _darkTheme = wantDark;
            ApplyTheme();
            RenderSidebar();
            RenderHeader();
            await RefreshThreadAsync();
            Log($"面板风格切换为{(_darkTheme ? "深色" : "浅色")}");
        }

        // 开机启动：写当前用户的 Run 键
        var wantStartup = dialog.AutoStart;
        if (wantStartup != autoStart) SetAutoStart(wantStartup);

        // 存储位置：换了就重启服务端，让新位置立刻生效（所有数据都跟着走）
        var dir = dialog.DataDirValue;
        var newDir = dir.Contains("默认") ? "" : dir;
        var dirChanged = !string.Equals(newDir, _dataDir, StringComparison.OrdinalIgnoreCase);
        _dataDir = newDir;
        SavePrefs();

        if (dirChanged)
        {
            var label = string.IsNullOrEmpty(_dataDir) ? "默认 data 目录" : _dataDir;
            if (_startedByUs && _server is { HasExited: false })
            {
                Log($"存储位置改为「{label}」，重启面板服务");
                try
                {
                    _server.Kill(entireProcessTree: true);
                }
                catch
                {
                    /* 忽略 */
                }
                await Task.Delay(900);
                _startedByUs = StartServer();
                var ready = await WaitForBoardAsync(TimeSpan.FromSeconds(25));
                Log($"按新目录重启：{(ready ? "就绪" : "超时")}");
                await RefreshStateAsync();
            }
            else
            {
                MessageBox.Show(
                    "存储位置已记录，但当前面板服务不是由这个窗口启动的（可能是别处已在运行）。\n\n" +
                    "退出那个服务再打开本窗口，新位置就会生效。",
                    "蜂群 HIVE");
            }
        }

        // 全局 API
        var payload = new Dictionary<string, object>
        {
            ["baseUrl"] = dialog.BaseUrlValue,
            ["model"] = dialog.ModelValue,
            ["reasoning"] = dialog.ReasoningValue,
            ["levelChannels"] = dialog.LevelChannelsValue(),
            ["onboarded"] = true,
        };
        if (!string.IsNullOrEmpty(dialog.ApiKeyValue)) payload["apiKey"] = dialog.ApiKeyValue;
        try
        {
            await Http.PostAsync($"{BaseUrl}/api/settings",
                new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"));
            await RefreshStateAsync();
            Log("设置已保存");
        }
        catch (Exception error)
        {
            Log($"保存全局设置失败：{error.Message}");
            MessageBox.Show($"保存全局设置失败：{error.Message}", "蜂群 HIVE");
        }
    }

    private static bool IsAutoStart()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run");
            return key?.GetValue("HiveShell") is not null;
        }
        catch
        {
            return false;
        }
    }

    private static void SetAutoStart(bool enabled)
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run", true);
            if (key is null) return;
            if (enabled)
            {
                key.SetValue("HiveShell", $"\"{Environment.ProcessPath}\"");
                Log("已开启开机启动");
            }
            else
            {
                key.DeleteValue("HiveShell", false);
                Log("已关闭开机启动");
            }
        }
        catch (Exception error)
        {
            Log($"设置开机启动失败：{error.Message}");
        }
    }

    private async void OnOpenSettings(object sender, RoutedEventArgs e) => await OnOpenSettings();

    private async Task OnOpenSettings()
    {
        var dialog = new FormDialog("全局设置",
            new[]
            {
                new FormField("apiKey", _hasKey ? "API Key（已设置，留空则不改）" : "API Key", "sk-…", "", null, true),
                new FormField("baseUrl", "接口地址", "https://api.deepseek.com", "https://api.deepseek.com"),
                new FormField("model", "默认模型", "deepseek-chat", "deepseek-chat"),
            },
            "这里填的是默认通道：没有单独配 API 的员工都用它。");
        if (dialog.ShowDialog() != true) return;
        var v = dialog.Values;
        try
        {
            var payload = new Dictionary<string, object>
            {
                ["baseUrl"] = v["baseUrl"],
                ["model"] = v["model"],
                ["onboarded"] = true,
            };
            if (!string.IsNullOrEmpty(v["apiKey"])) payload["apiKey"] = v["apiKey"];
            var body = JsonSerializer.Serialize(payload);
            await Http.PostAsync($"{BaseUrl}/api/settings", new StringContent(body, Encoding.UTF8, "application/json"));
            await RefreshStateAsync();
            Log("全局设置已保存");
        }
        catch (Exception error)
        {
            MessageBox.Show($"保存失败：{error.Message}", "蜂群 HIVE");
        }
    }

    private void ShowDepartmentMenu(DepartmentInfo department, UIElement anchor)
    {
        var menu = new ContextMenu();
        var addItem = new MenuItem { Header = "添加员工…" };
        addItem.Click += async (_, _) =>
        {
            await OnAddEmployee();
        };
        var deleteItem = new MenuItem { Header = "删除部门" };
        deleteItem.Click += async (_, _) =>
        {
            if (MessageBox.Show($"确定删除部门「{department.Name}」？员工不会被删除，只会变成未分配。",
                    "蜂群 HIVE", MessageBoxButton.OKCancel) != MessageBoxResult.OK) return;
            await Http.PostAsync($"{BaseUrl}/api/department/delete",
                new StringContent(JsonSerializer.Serialize(new { id = department.Id }), Encoding.UTF8, "application/json"));
            await RefreshStateAsync();
        };
        menu.Items.Add(addItem);
        menu.Items.Add(deleteItem);
        menu.PlacementTarget = anchor;
        menu.IsOpen = true;
    }

    private void ShowEmployeeMenu(EmployeeInfo employee, UIElement anchor)
    {
        var menu = new ContextMenu();
        var editItem = new MenuItem { Header = "设置（职级 / 模型 / API）…" };
        editItem.Click += async (_, _) =>
        {
            var dialog = new FormDialog($"设置 · {employee.Name}", new[]
            {
                new FormField("title", "职能", "", employee.Title),
                new FormField("level", "职级（P3 最高，决定用哪个模型）", "", LevelLabelOf(employee.Level),
                    LevelOptions.Select(o => o.Label).ToArray()),
                new FormField("model", "自己指定模型（留空 = 按职级分配）", "例如 deepseek-chat", employee.Model),
                new FormField("baseUrl", "接口地址（留空用全局默认）", "https://api.deepseek.com", employee.BaseUrl),
                new FormField("apiKey", "API Key（留空保持不变）", "", "", null, true),
            }, "职级决定模型：P3 经理 / P2 项目负责人 / P1 普通员工，三档在「全局设置 → API 设置」里配。");
            if (dialog.ShowDialog() != true) return;
            var v = dialog.Values;
            var payload = new Dictionary<string, object>
            {
                ["id"] = employee.Id,
                ["name"] = employee.Name,
                ["title"] = v["title"],
                ["level"] = LevelValueOf(v["level"]),
                ["departmentId"] = employee.DepartmentId,
                ["model"] = v["model"],
                ["baseUrl"] = v["baseUrl"],
            };
            if (!string.IsNullOrEmpty(v["apiKey"])) payload["apiKey"] = v["apiKey"];
            await Http.PostAsync($"{BaseUrl}/api/employee",
                new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"));
            await RefreshStateAsync();
        };
        var avatarItem = new MenuItem { Header = "重新生成头像" };
        avatarItem.Click += async (_, _) => await RegenerateAvatar(employee);

        var deleteItem = new MenuItem { Header = "删除员工" };
        deleteItem.Click += async (_, _) =>
        {
            if (MessageBox.Show($"确定删除「{employee.Name}」？他的对话会保留。",
                    "蜂群 HIVE", MessageBoxButton.OKCancel) != MessageBoxResult.OK) return;
            await Http.PostAsync($"{BaseUrl}/api/employee/delete",
                new StringContent(JsonSerializer.Serialize(new { id = employee.Id }), Encoding.UTF8, "application/json"));
            await RefreshStateAsync();
        };
        menu.Items.Add(editItem);
        menu.Items.Add(avatarItem);
        menu.Items.Add(deleteItem);
        menu.PlacementTarget = anchor;
        menu.IsOpen = true;
    }

    /// <summary>重新生成头像：传 avatar:null 让服务端重挑一个（优先挑别人没用过的）。</summary>
    private async Task RegenerateAvatar(EmployeeInfo employee)
    {
        try
        {
            var payload = new Dictionary<string, object?>
            {
                ["id"] = employee.Id,
                ["name"] = employee.Name,
                ["title"] = employee.Title,
                ["level"] = employee.Level,
                ["departmentId"] = employee.DepartmentId,
                ["model"] = employee.Model,
                ["baseUrl"] = employee.BaseUrl,
                // 不传 managerId / description / apiKey：服务端会沿用原有值
                ["avatar"] = null, // 清掉旧头像 → 服务端重新挑一个
            };
            var response = await Http.PostAsync($"{BaseUrl}/api/employee",
                new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"));
            if (!response.IsSuccessStatusCode)
            {
                MessageBox.Show($"换头像失败：{await response.Content.ReadAsStringAsync()}", "蜂群 HIVE");
                return;
            }
            AvatarImages.Clear(); // 丢掉本地图片缓存，确保拿到的是新分配的那张
            await RefreshStateAsync();
            Log($"已为 {employee.Name} 重新生成头像");
        }
        catch (Exception error)
        {
            Log($"换头像出错：{error.Message}");
            MessageBox.Show($"换头像出错：{error.Message}", "蜂群 HIVE");
        }
    }

    /* ── 窗口控制（无边框，标题栏自己画）──────────────────── */

    private void OnTitleBarMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            ToggleMaximize();
            return;
        }
        if (e.ButtonState != MouseButtonState.Pressed) return;
        try
        {
            DragMove();
        }
        catch
        {
            /* 拖动过程中松开鼠标会抛，忽略 */
        }
    }

    private void OnMinimizeWindow(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void OnToggleMaximize(object sender, RoutedEventArgs e) => ToggleMaximize();

    private void ToggleMaximize()
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        if (MaximizeButton is not null)
        {
            MaximizeButton.Content = WindowState == WindowState.Maximized ? "❐" : "□";
        }
    }

    /// <summary>点关闭不是退出：走 OnClosing 那条路收进托盘。</summary>
    private void OnCloseWindow(object sender, RoutedEventArgs e) => Close();

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        // 点关闭不是退出，而是收进托盘继续在后台跑（服务器也跟着活着）
        if (!_reallyExit)
        {
            e.Cancel = true;
            Hide();
            Log("窗口收进托盘，后台继续运行");
            try
            {
                _tray?.ShowBalloonTip(2000, "蜂群 HIVE", "已在后台运行。双击托盘图标可以重新打开面板。",
                    Forms.ToolTipIcon.Info);
            }
            catch
            {
                /* 气泡提示失败不影响 */
            }
            return;
        }

        Log("=== 外壳退出 ===");
        _timer?.Stop();
        _tray?.Dispose();
        _tray = null;
        if (!_startedByUs || _server is not { HasExited: false }) return;
        try
        {
            _server.Kill(entireProcessTree: true);
        }
        catch
        {
            /* 关不掉就算了 */
        }
    }

    /* ── 托盘 ───────────────────────────────────────────── */

    private void SetupTray()
    {
        try
        {
            var menu = new Forms.ContextMenuStrip();
            menu.Items.Add("打开面板", null, (_, _) => RestoreWindow());
            menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add("退出", null, (_, _) =>
            {
                _reallyExit = true;
                Close();
            });

            _tray = new Forms.NotifyIcon
            {
                Icon = LoadTrayIcon(),
                Text = "蜂群 HIVE · AI 员工面板",
                Visible = true,
                ContextMenuStrip = menu,
            };
            _tray.DoubleClick += (_, _) => RestoreWindow();
            Log("托盘图标已就绪");
        }
        catch (Exception error)
        {
            Log($"托盘创建失败：{error.Message}");
        }
    }

    /// <summary>
    /// 托盘图标：任务栏底色通常是深的，所以用白色版 desktop/hive-white.ico；
    /// 找不到就退回 exe 自带图标，保证不会没有图标。
    /// </summary>
    /// <summary>系统任务栏是不是浅色（Windows 个人化设置里的"系统模式"）。</summary>
    private static bool TaskbarIsLight()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("SystemUsesLightTheme") is int value && value == 1;
        }
        catch
        {
            return false; // 查不到就按深色任务栏处理（Windows 默认）
        }
    }

    private static Drawing.Icon LoadTrayIcon()
    {
        var root = FindProjectRoot();
        // 任务栏是浅色的用黑图标、深色的用白图标，两种设置下都看得清
        var fileName = TaskbarIsLight() ? "hive-black.ico" : "hive-white.ico";
        var candidate = root is null ? null : Path.Combine(root, "desktop", fileName);
        if (candidate is not null && File.Exists(candidate))
        {
            try
            {
                return new Drawing.Icon(candidate);
            }
            catch (Exception error)
            {
                Log($"托盘图标加载失败，改用 exe 图标：{error.Message}");
            }
        }
        return Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? Drawing.SystemIcons.Application;
    }

    /// <summary>
    /// 任务栏按钮图标：跟托盘同一套规则 —— 任务栏是深色就用白色 logo、浅色用黑色 logo。
    /// exe 内嵌的图标运行时改不了，但窗口图标（任务栏按钮用它）可以随时换。
    /// </summary>
    private void ApplyWindowIcon()
    {
        var root = FindProjectRoot();
        var fileName = TaskbarIsLight() ? "hive-black.ico" : "hive-white.ico";
        var candidate = root is null ? null : Path.Combine(root, "desktop", fileName);
        if (candidate is null || !File.Exists(candidate)) return;
        try
        {
            using var stream = File.OpenRead(candidate);
            var decoder = new IconBitmapDecoder(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
            // 任务栏按钮大约 32px，挑最接近的一帧最清楚
            var frame = decoder.Frames.OrderBy(f => Math.Abs(f.PixelWidth - 32)).First();
            Icon = frame;
            Log($"任务栏图标：{fileName}（{frame.PixelWidth}px）");
        }
        catch (Exception error)
        {
            Log($"任务栏图标加载失败：{error.Message}");
        }
    }

    /// <summary>
    /// 订阅系统主题变化：Windows 在深/浅色之间切换时，任务栏按钮、托盘、
    /// 以及桌面/固定项里指向本程序的快捷方式图标，全部自动换成对应那版。
    /// </summary>
    private void WatchSystemTheme()
    {
        try
        {
            Microsoft.Win32.SystemEvents.UserPreferenceChanged += (_, args) =>
            {
                if (args.Category != Microsoft.Win32.UserPreferenceCategory.General &&
                    args.Category != Microsoft.Win32.UserPreferenceCategory.VisualStyle)
                {
                    return;
                }
                Dispatcher.BeginInvoke(() =>
                {
                    ApplyWindowIcon();
                    if (_tray is not null) _tray.Icon = LoadTrayIcon();
                    UpdateShortcutIcons();
                    Log($"系统主题已切换 → 图标换成{(TaskbarIsLight() ? "黑色版" : "白色版")}");
                });
            };
        }
        catch (Exception error)
        {
            Log($"订阅系统主题变化失败：{error.Message}");
        }
    }

    /// <summary>
    /// 桌面 / 任务栏固定项 / 开始菜单里，凡是目标指向本 exe 的快捷方式，
    /// 图标都改成当前主题对应的 .ico（exe 自身内嵌的图标改不了，快捷方式可以指定）。
    /// </summary>
    private static void UpdateShortcutIcons()
    {
        var root = FindProjectRoot();
        var fileName = TaskbarIsLight() ? "hive-black.ico" : "hive-white.ico";
        var iconPath = root is null ? null : Path.Combine(root, "desktop", fileName);
        if (iconPath is null || !File.Exists(iconPath)) return;
        var wanted = $"{iconPath},0";
        var exe = Environment.ProcessPath ?? "";
        var folders = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "Microsoft", "Windows", "Start Menu", "Programs"),
        };
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType is null) return;
        var changed = false;
        foreach (var folder in folders)
        {
            if (!Directory.Exists(folder)) continue;
            foreach (var file in Directory.EnumerateFiles(folder, "*.lnk"))
            {
                try
                {
                    dynamic shell = Activator.CreateInstance(shellType)!;
                    dynamic shortcut = shell.CreateShortcut(file);
                    var target = (shortcut.TargetPath as string) ?? "";
                    if (!target.Equals(exe, StringComparison.OrdinalIgnoreCase)) continue;
                    if (string.Equals((shortcut.IconLocation as string) ?? "", wanted, StringComparison.OrdinalIgnoreCase)) continue;
                    shortcut.IconLocation = wanted;
                    shortcut.Save();
                    changed = true;
                    Log($"快捷方式图标已更新：{Path.GetFileName(file)}");
                }
                catch (Exception error)
                {
                    Log($"改快捷方式图标失败（{Path.GetFileName(file)}）：{error.Message}");
                }
            }
        }
        if (changed) RefreshIconCache();
    }

    /// <summary>让资源管理器 / 任务栏立刻重读图标，不然要等缓存过期。</summary>
    private static void RefreshIconCache()
    {
        try
        {
            SHChangeNotify(0x08000000, 0x1000, IntPtr.Zero, IntPtr.Zero);   // SHCNE_ASSOCCHANGED | SHCNF_FLUSH
        }
        catch (Exception error)
        {
            Log($"刷新图标缓存失败：{error.Message}");
        }
    }

    [System.Runtime.InteropServices.DllImport("shell32.dll")]
    private static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);

    private void RestoreWindow()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
        Topmost = true;
        Topmost = false;
    }

    /* ── 消息视图模型 ───────────────────────────────────── */

    private sealed class MessageVm
    {
        public string Who { get; init; } = "";
        public string When { get; init; } = "";
        public string Text { get; init; } = "";
        public string Model { get; init; } = "";
        public Visibility ModelVisibility { get; init; }
        public HorizontalAlignment Align { get; init; }
        public Brush Bubble { get; init; } = Brushes.White;
        public Brush BubbleLine { get; init; } = Brushes.Transparent;
        public Brush TextColor { get; init; } = Brushes.Black;
        public UIElement? Avatar { get; init; }
        public Visibility AvatarVisibility { get; init; } = Visibility.Collapsed;
    }
}

/// <summary>一个字段：关键字、标签、占位、默认值、可选下拉项、是否密码、是否是目录选择。</summary>
public sealed record FormField(
    string Key, string Label, string Placeholder = "", string Value = "",
    string[]? Options = null, bool IsSecret = false, bool IsFolder = false);

/// <summary>某个职级配的模型通道：models 可以多个（同职级轮着用），baseUrl 留空 = 用全局默认通道。</summary>
public sealed record LevelChannelInfo(string[] Models, string BaseUrl, bool HasKey);

/// <summary>设置窗口：分组呈现；「API 设置」单独一块，点标题才展开。</summary>
public sealed class SettingsWindow : Window
{
    private readonly ComboBox _theme;
    private readonly ComboBox _startup;
    private readonly ComboBox _reasoning;
    private readonly TextBox _dataDir;
    private readonly TextBox _apiKey;
    private readonly TextBox _baseUrl;
    private readonly TextBox _model;
    // 三个职级的模型通道：模型 / 接口地址 / API Key
    private readonly TextBox[] _levelModels = new TextBox[3];
    private readonly TextBox[] _levelBaseUrls = new TextBox[3];
    private readonly TextBox[] _levelKeys = new TextBox[3];

    private static readonly (string Label, string Value)[] LevelRows =
    {
        ("P3 · 经理（最费、最强）", "manager"),
        ("P2 · 项目负责人（中等）", "lead"),
        ("P1 · 普通员工（最省，可填免费模型）", "worker"),
    };

    /// <summary>把三个职级的输入拼成 /api/settings 要的 levelChannels。</summary>
    public Dictionary<string, object> LevelChannelsValue()
    {
        var result = new Dictionary<string, object>();
        for (var i = 0; i < LevelRows.Length; i++)
        {
            var models = _levelModels[i].Text
                .Split(new[] { ',', '，', ';', '；', ' ' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(x => x.Trim())
                .Where(x => x != "")
                .Take(5)
                .ToArray();
            var entry = new Dictionary<string, object>
            {
                ["models"] = models,
                ["baseUrl"] = _levelBaseUrls[i].Text.Trim(),
            };
            // 留空 = 不改（服务端保留原来的 Key）
            if (!string.IsNullOrEmpty(_levelKeys[i].Text.Trim())) entry["apiKey"] = _levelKeys[i].Text.Trim();
            result[LevelRows[i].Value] = entry;
        }
        return result;
    }

    /// <summary>推理等级的中文名 ↔ 服务端取值。</summary>
    private static readonly (string Label, string Value)[] ReasoningOptions =
    {
        ("默认（接口自带）", "default"),
        ("关闭思考", "off"),
        ("低（快）", "low"),
        ("高（默认档）", "high"),
        ("最高（最慢最准）", "max"),
    };

    public bool DarkTheme => _theme.SelectedItem?.ToString() == "深色";
    public bool AutoStart => _startup.SelectedItem?.ToString() == "开启";
    public string DataDirValue => _dataDir.Text.Trim();
    public string ApiKeyValue => _apiKey.Text.Trim();
    public string BaseUrlValue => _baseUrl.Text.Trim();
    public string ModelValue => _model.Text.Trim();
    public string ReasoningValue => _reasoning.SelectedItem?.ToString() is { } label
        ? ReasoningOptions.FirstOrDefault(o => o.Label == label).Value ?? "default"
        : "default";

    public SettingsWindow(bool darkTheme, bool autoStart, string dataDir, bool hasKey, string baseUrl, string model, string reasoning = "default",
        Dictionary<string, LevelChannelInfo>? levelChannels = null)
    {
        Title = "设置";
        Width = 470;
        SizeToContent = SizeToContent.Height;
        MaxHeight = 780;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = (Brush)Application.Current.Resources["Bg"];
        Foreground = (Brush)Application.Current.Resources["Ink"];
        FontFamily = new FontFamily("Microsoft YaHei UI, Segoe UI");
        FontSize = 13;

        var ink2 = (Brush)Application.Current.Resources["Ink2"];
        var line = (Brush)Application.Current.Resources["Line"];
        var surface = (Brush)Application.Current.Resources["Surface"];
        var accent = (Brush)Application.Current.Resources["Accent"];
        var stack = new StackPanel { Margin = new Thickness(20, 18, 20, 16) };

        /* 外观 */
        stack.Children.Add(Caption("面板风格", ink2));
        _theme = Combo(new[] { "浅色", "深色" }, darkTheme ? "深色" : "浅色");
        stack.Children.Add(_theme);

        stack.Children.Add(Caption("开机自动启动", ink2));
        _startup = Combo(new[] { "关闭", "开启" }, autoStart ? "开启" : "关闭");
        stack.Children.Add(_startup);

        /* 存储位置 */
        stack.Children.Add(Caption("数据存储位置", ink2));
        _dataDir = new TextBox { Text = dataDir, Padding = new Thickness(8, 6, 8, 6) };
        var browse = new Button
        {
            Content = "浏览…",
            Width = 80,
            Margin = new Thickness(8, 0, 0, 0),
            Padding = new Thickness(0, 6, 0, 6),
            Cursor = Cursors.Hand,
        };
        browse.Click += (_, _) =>
        {
            using var picker = new Forms.FolderBrowserDialog
            {
                Description = "选择数据存储位置（部门、员工、项目、全部对话都会存在这里）",
                UseDescriptionForTitle = true,
                ShowNewFolderButton = true,
            };
            if (!string.IsNullOrEmpty(_dataDir.Text) && Directory.Exists(_dataDir.Text))
            {
                picker.SelectedPath = _dataDir.Text;
            }
            if (picker.ShowDialog() == Forms.DialogResult.OK) _dataDir.Text = picker.SelectedPath;
        };
        var dirRow = new DockPanel { Margin = new Thickness(0, 0, 0, 6) };
        DockPanel.SetDock(browse, Dock.Right);
        dirRow.Children.Add(browse);
        dirRow.Children.Add(_dataDir);
        stack.Children.Add(dirRow);
        stack.Children.Add(new TextBlock
        {
            Text = "留空 = 项目内的 data 目录。切换后会重启面板服务，所有数据都改存到新位置。",
            FontSize = 11.5,
            Foreground = ink2,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 14),
        });

        /* API 设置：单独一块，折叠着，点标题才展开 */
        var apiPanel = new StackPanel();
        apiPanel.Children.Add(Caption(hasKey ? "API Key（已设置，留空不改）" : "API Key", ink2));
        _apiKey = new TextBox { Padding = new Thickness(8, 6, 8, 6), Margin = new Thickness(0, 0, 0, 10) };
        apiPanel.Children.Add(_apiKey);
        apiPanel.Children.Add(Caption("接口地址", ink2));
        _baseUrl = new TextBox { Text = baseUrl, Padding = new Thickness(8, 6, 8, 6), Margin = new Thickness(0, 0, 0, 10) };
        apiPanel.Children.Add(_baseUrl);
        apiPanel.Children.Add(Caption("默认模型", ink2));
        _model = new TextBox { Text = model, Padding = new Thickness(8, 6, 8, 6) };
        apiPanel.Children.Add(_model);
        apiPanel.Children.Add(Caption("推理等级", ink2));
        _reasoning = Combo(ReasoningOptions.Select(o => o.Label).ToArray(),
            ReasoningOptions.FirstOrDefault(o => o.Value == (reasoning ?? "default")).Label ?? ReasoningOptions[0].Label);
        _reasoning.Margin = new Thickness(0, 0, 0, 4);
        apiPanel.Children.Add(_reasoning);
        apiPanel.Children.Add(new TextBlock
        {
            Text = "思考模式会先推理再回答，更准但更慢、也更费 token；关闭思考最快。",
            FontSize = 11.5,
            Foreground = ink2,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 10),
        });

        /* 按职级分配模型：P3 经理 / P2 项目负责人 / P1 普通员工 */
        apiPanel.Children.Add(new TextBlock
        {
            Text = "按职级分配模型（P3 最高）",
            FontSize = 12.5,
            FontWeight = FontWeights.SemiBold,
            Foreground = (Brush)Application.Current.Resources["Ink"],
            Margin = new Thickness(0, 6, 0, 2),
        });
        for (var i = 0; i < LevelRows.Length; i++)
        {
            var (label, value) = LevelRows[i];
            LevelChannelInfo? current = null;
            levelChannels?.TryGetValue(value, out current);
            apiPanel.Children.Add(new TextBlock
            {
                Text = label,
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = (Brush)Application.Current.Resources["Ink"],
                Margin = new Thickness(0, 12, 0, 2),
            });

            apiPanel.Children.Add(new TextBlock
            {
                Text = "① 模型名 —— 可填多个，逗号分隔（同职级的人轮着用）；留空 = 用上面的默认模型",
                FontSize = 11.5,
                Foreground = ink2,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 6, 0, 3),
            });
            _levelModels[i] = new TextBox
            {
                Text = current is null ? "" : string.Join(", ", current.Models),
                Padding = new Thickness(8, 5, 8, 5),
                Margin = new Thickness(0, 0, 0, 8),
                ToolTip = "例如 deepseek-v4-pro，或 P1 填 glm-4-flash, glm-4.7-flash",
            };
            apiPanel.Children.Add(_levelModels[i]);

            apiPanel.Children.Add(new TextBlock
            {
                Text = "② 接口地址 —— 留空 = 用上面的默认地址（P1 填免费厂商的地址）",
                FontSize = 11.5,
                Foreground = ink2,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 3),
            });
            _levelBaseUrls[i] = new TextBox
            {
                Text = current?.BaseUrl ?? "",
                Padding = new Thickness(8, 5, 8, 5),
                Margin = new Thickness(0, 0, 0, 8),
                ToolTip = "例如 P1 填 https://open.bigmodel.cn/api/paas/v4（智谱）或 https://api.siliconflow.cn/v1（硅基流动）",
            };
            apiPanel.Children.Add(_levelBaseUrls[i]);

            apiPanel.Children.Add(new TextBlock
            {
                Text = current?.HasKey == true
                    ? "③ API Key —— 已设置，留空则不改"
                    : "③ API Key —— 这一档专用的 Key；留空 = 用上面的全局 Key",
                FontSize = 11.5,
                Foreground = ink2,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 3),
            });
            _levelKeys[i] = new TextBox
            {
                Padding = new Thickness(8, 5, 8, 5),
                Margin = new Thickness(0, 0, 0, 2),
                ToolTip = "只存在本机 data/settings.json，不会回传给前端",
            };
            apiPanel.Children.Add(_levelKeys[i]);
        }
        apiPanel.Children.Add(new TextBlock
        {
            Text = "例：P1 想用免费小模型 —— ① 填 glm-4-flash, glm-4.7-flash  ② 填 https://open.bigmodel.cn/api/paas/v4  ③ 粘智谱的 Key。",
            FontSize = 11.5,
            Foreground = ink2,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 8, 0, 10),
        });
        apiPanel.Children.Add(new TextBlock
        {
            Text = "这是「默认通道」：没有单独配 Key 的员工都用它。",
            FontSize = 11.5,
            Foreground = ink2,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 8, 0, 0),
        });

        var expander = new Expander
        {
            Header = "API 设置（默认通道）",
            IsExpanded = false,
            Content = apiPanel,
            Padding = new Thickness(12, 10, 12, 12),
            Margin = new Thickness(0, 0, 0, 16),
            Background = surface,
            BorderBrush = line,
            BorderThickness = new Thickness(1),
        };
        stack.Children.Add(expander);

        /* 按钮 */
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        var cancel = new Button { Content = "取消", Width = 84, Margin = new Thickness(0, 0, 8, 0), Cursor = Cursors.Hand };
        cancel.Click += (_, _) => { DialogResult = false; Close(); };
        var ok = new Button
        {
            Content = "保存",
            Width = 84,
            Background = accent,
            Foreground = Brushes.White,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(0, 7, 0, 7),
            Cursor = Cursors.Hand,
        };
        ok.Click += (_, _) => { DialogResult = true; Close(); };
        buttons.Children.Add(cancel);
        buttons.Children.Add(ok);
        stack.Children.Add(buttons);

        Content = new ScrollViewer { Content = stack, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    private static TextBlock Caption(string text, Brush brush) => new()
    {
        Text = text,
        FontSize = 12,
        Foreground = brush,
        Margin = new Thickness(0, 0, 0, 4),
    };

    private static ComboBox Combo(string[] options, string selected)
    {
        var combo = new ComboBox { Margin = new Thickness(0, 0, 0, 12) };
        foreach (var option in options) combo.Items.Add(option);
        combo.SelectedItem = selected;
        return combo;
    }
}

/// <summary>够用就好的原生输入对话框：一列字段 + 确定/取消。</summary>
public sealed class FormDialog : Window
{
    private readonly Dictionary<string, TextBox> _boxes = new();
    private readonly Dictionary<string, ComboBox> _combos = new();

    public Dictionary<string, string> Values { get; } = new();

    public FormDialog(string title, IEnumerable<FormField> fields, string? note = null)
    {
        Title = title;
        Width = 440;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = (Brush)Application.Current.Resources["Bg"];
        FontFamily = new FontFamily("Microsoft YaHei UI, Segoe UI");
        FontSize = 13;

        var stack = new StackPanel { Margin = new Thickness(20, 18, 20, 16) };
        if (note is not null)
        {
            stack.Children.Add(new TextBlock
            {
                Text = note,
                TextWrapping = TextWrapping.Wrap,
                Foreground = (Brush)Application.Current.Resources["Ink2"],
                Margin = new Thickness(0, 0, 0, 12),
            });
        }

        foreach (var field in fields)
        {
            stack.Children.Add(new TextBlock
            {
                Text = field.Label,
                Foreground = (Brush)Application.Current.Resources["Ink2"],
                FontSize = 12,
                Margin = new Thickness(0, 0, 0, 4),
            });
            if (field.Options is { Length: > 0 })
            {
                var combo = new ComboBox { Margin = new Thickness(0, 0, 0, 12) };
                foreach (var option in field.Options) combo.Items.Add(option);
                combo.SelectedItem = field.Options.Contains(field.Value) ? field.Value : field.Options[0];
                _combos[field.Key] = combo;
                stack.Children.Add(combo);
            }
            else
            {
                var box = new TextBox
                {
                    Text = field.Value,
                    Margin = field.IsFolder ? new Thickness(0) : new Thickness(0, 0, 0, 12),
                    Padding = new Thickness(8, 6, 8, 6),
                };
                if (field.Placeholder != "") box.ToolTip = field.Placeholder;
                if (field.IsSecret) box.FontFamily = new FontFamily("Consolas");
                _boxes[field.Key] = box;

                if (field.IsFolder)
                {
                    // 目录字段：右边配一个「浏览…」，点开系统文件夹选择框
                    var capturedBox = box;
                    var browse = new Button
                    {
                        Content = "浏览…",
                        Width = 80,
                        Margin = new Thickness(8, 0, 0, 0),
                        Padding = new Thickness(0, 6, 0, 6),
                        Cursor = Cursors.Hand,
                    };
                    browse.Click += (_, _) =>
                    {
                        using var picker = new Forms.FolderBrowserDialog
                        {
                            Description = "选择数据存储位置（部门、员工、项目、全部对话都会存在这里）",
                            UseDescriptionForTitle = true,
                            ShowNewFolderButton = true,
                        };
                        if (!string.IsNullOrEmpty(capturedBox.Text) && Directory.Exists(capturedBox.Text))
                        {
                            picker.SelectedPath = capturedBox.Text;
                        }
                        if (picker.ShowDialog() == Forms.DialogResult.OK)
                        {
                            capturedBox.Text = picker.SelectedPath;
                        }
                    };

                    var row = new DockPanel { Margin = new Thickness(0, 0, 0, 12) };
                    DockPanel.SetDock(browse, Dock.Right);
                    row.Children.Add(browse);
                    row.Children.Add(box);
                    stack.Children.Add(row);
                }
                else
                {
                    stack.Children.Add(box);
                }
            }
        }

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        var cancel = new Button { Content = "取消", Width = 84, Margin = new Thickness(0, 0, 8, 0) };
        cancel.Click += (_, _) => { DialogResult = false; Close(); };
        var ok = new Button
        {
            Content = "确定",
            Width = 84,
            Background = (Brush)Application.Current.Resources["Accent"],
            Foreground = Brushes.White,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(0, 7, 0, 7),
            Cursor = Cursors.Hand,
        };
        ok.Click += (_, _) =>
        {
            foreach (var (key, box) in _boxes) Values[key] = box.Text.Trim();
            foreach (var (key, combo) in _combos) Values[key] = combo.SelectedItem?.ToString() ?? "";
            DialogResult = true;
            Close();
        };
        buttons.Children.Add(cancel);
        buttons.Children.Add(ok);
        stack.Children.Add(buttons);

        Content = new ScrollViewer { Content = stack, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Loaded += (_, _) =>
        {
            if (_boxes.Count > 0) _boxes.Values.First().Focus();
        };
    }
}
