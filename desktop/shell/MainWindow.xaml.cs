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

    public MainWindow()
    {
        Log("=== 外壳启动（原生界面）===");
        InitializeComponent();

        var iconPath = FindAsset("hive-icon-black.png");
        if (iconPath is not null)
        {
            BrandIcon.Source = new BitmapImage(new Uri(iconPath));
        }

        Loaded += OnLoadedAsync;
        Closing += OnClosing;
        InputBox.TextChanged += OnInputChanged;
        LoadPrefs();
        UpdateSendModeButton();
    }

    /* ── 发送方式：Enter 还是 Alt+Enter，点了立刻生效 ─────── */

    private static readonly string PrefsFile = Path.Combine(LogDir, "prefs.json");

    private void LoadPrefs()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(PrefsFile));
            if (doc.RootElement.TryGetProperty("altEnterToSend", out var value)) _altEnterToSend = value.GetBoolean();
        }
        catch
        {
            /* 没有偏好文件就用默认（Enter 发送） */
        }
    }

    private void SavePrefs()
    {
        try
        {
            Directory.CreateDirectory(LogDir);
            File.WriteAllText(PrefsFile, JsonSerializer.Serialize(new { altEnterToSend = _altEnterToSend }));
        }
        catch
        {
            /* 存不了只是下次回到默认 */
        }
    }

    private void OnToggleSendMode(object sender, RoutedEventArgs e)
    {
        _altEnterToSend = !_altEnterToSend;
        UpdateSendModeButton();
        SavePrefs();
        InputBox.Focus();
    }

    private void UpdateSendModeButton()
    {
        SendModeButton.Content = _altEnterToSend ? "Alt+Enter 发送" : "Enter 发送";
        SendModeButton.ToolTip = _altEnterToSend
            ? "当前：Alt+Enter 发送，Enter 换行。点一下改成 Enter 发送。"
            : "当前：Enter 发送，Shift+Enter 换行。点一下改成 Alt+Enter 发送。";
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
            content.Children.Add(Avatar(person.Name, person.AvatarSeed, person.AvatarFile, 24));
            content.Children.Add(new TextBlock
            {
                Text = person.Name,
                FontSize = 14,
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
            row.MouseEnter += (_, _) => row.Background = new SolidColorBrush(Color.FromRgb(243, 241, 237));
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

    private bool StartServer()
    {
        var root = FindProjectRoot();
        if (root is null) return false;
        try
        {
            _server = Process.Start(new ProcessStartInfo
            {
                FileName = "node",
                Arguments = $"server/index.js --port {Port} --host 127.0.0.1",
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
    private sealed record EmployeeInfo(string Id, string Name, string Title, string Level, string DepartmentId, string Model, string BaseUrl, int AvatarSeed, string AvatarFile);
    private sealed record ProjectInfo(string Id, string Name, string Description, string[] DepartmentIds);

    private async Task RefreshStateAsync()
    {
        try
        {
            var text = await Http.GetStringAsync($"{BaseUrl}/api/state");
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;

            _hasKey = root.GetProperty("settings").GetProperty("hasKey").GetBoolean();
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
                e.TryGetProperty("avatar", out var av2) && av2.TryGetProperty("file", out var af) ? af.GetString() ?? "" : "")).ToList();
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
                items.Add(new MessageVm
                {
                    Who = m.TryGetProperty("fromName", out var n) ? n.GetString() ?? from : from,
                    When = ParseTime(m.TryGetProperty("at", out var a) ? a.GetString() : null),
                    Text = m.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : "",
                    Model = model == "" ? "" : $"模型：{model}",
                    ModelVisibility = model == "" ? Visibility.Collapsed : Visibility.Visible,
                    Align = isLocal ? HorizontalAlignment.Right : HorizontalAlignment.Left,
                    Bubble = isLocal ? "#EFF5FF" : kind == "ack" ? "#FFFFFF" : "#FFFFFF",
                    BubbleLine = failed ? "#E3B4B0" : isLocal ? "#BFD6FB" : "#E9E6E1",
                    TextColor = failed ? "#C2554F" : kind == "ack" ? "#6B7280" : "#1E1E1E",
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
            Content = new TextBlock { Text = project.Name, TextTrimming = TextTrimming.CharacterEllipsis },
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(0, 1, 0, 1),
            Background = active ? new SolidColorBrush(Color.FromRgb(233, 240, 254)) : Brushes.Transparent,
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

        var grid = new Grid { Margin = new Thickness(0, 1, 0, 1) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        // 折叠按钮：给个底色方块，一眼就能看出"这里能点"
        var caret = new Border
        {
            Width = 22,
            Height = 22,
            CornerRadius = new CornerRadius(6),
            Background = new SolidColorBrush(open ? Color.FromRgb(226, 232, 242) : Color.FromRgb(233, 230, 224)),
            BorderBrush = new SolidColorBrush(Color.FromRgb(214, 209, 201)),
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
                Foreground = new SolidColorBrush(Color.FromRgb(90, 96, 106)),
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
            Background = active ? new SolidColorBrush(Color.FromRgb(233, 240, 254)) : Brushes.Transparent,
            Padding = new Thickness(9, 6, 8, 6),
            Margin = new Thickness(4, 0, 0, 0),
            Cursor = Cursors.Hand,
            Child = new TextBlock { Text = department.Name, FontWeight = FontWeights.Medium, VerticalAlignment = VerticalAlignment.Center },
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
        panel.Children.Add(Avatar(employee.Name, employee.AvatarSeed, employee.AvatarFile, 26));
        // 名字稍大、职位跟在后面且颜色更淡
        panel.Children.Add(new TextBlock
        {
            Text = employee.Name,
            FontSize = 14.5,
            Margin = new Thickness(9, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center,
            Foreground = (Brush)FindResource("Ink"),
        });
        if (!string.IsNullOrEmpty(employee.Title))
        {
            panel.Children.Add(new TextBlock
            {
                Text = employee.Title,
                FontSize = 11.5,
                Margin = new Thickness(6, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = (Brush)FindResource("Ink3"),
            });
        }

        var button = new Button
        {
            Content = panel,
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(indent, 1, 0, 1),
            Background = active ? new SolidColorBrush(Color.FromRgb(233, 240, 254)) : Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(8, 5, 8, 5),
            ToolTip = string.IsNullOrEmpty(employee.Title) ? null : employee.Title,
        };
        button.Click += (_, _) => SetContext("employee", employee.Id);
        button.MouseRightButtonUp += (_, _) => ShowEmployeeMenu(employee, button);
        return button;
    }

    /// <summary>头像：头像库里有图就用图（圆形裁剪），没有就退回"种子 → 色相 + 首字"。</summary>
    private static UIElement Avatar(string name, int seed, string file, double size)
    {
        if (!string.IsNullOrEmpty(file))
        {
            try
            {
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.UriSource = new Uri($"{BaseUrl}/api/avatar/{Uri.EscapeDataString(file)}");
                image.EndInit();
                return new System.Windows.Shapes.Ellipse
                {
                    Width = size,
                    Height = size,
                    Fill = new ImageBrush(image) { Stretch = Stretch.UniformToFill },
                    VerticalAlignment = VerticalAlignment.Center,
                };
            }
            catch (Exception error)
            {
                Log($"头像加载失败（{file}）：{error.Message}");
            }
        }
        return new Border
        {
            Width = size,
            Height = size,
            CornerRadius = new CornerRadius(size / 2),
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
            new FormField("level", "层级", "部门经理 / 项目负责人 / 执行人员", "执行人员",
                new[] { "部门经理", "项目负责人", "执行人员" }),
            new FormField("department", "所属部门", "", _departments[0].Name, _departments.Select(d => d.Name).ToArray()),
            new FormField("description", "职责描述（可留空）", ""),
            new FormField("model", "模型（留空用全局默认）", ""),
            new FormField("apiKey", "API Key（留空用全局的）", "", "", null, true),
        });
        if (dialog.ShowDialog() != true) return;
        var v = dialog.Values;
        var level = v["level"] switch
        {
            "部门经理" => "manager",
            "项目负责人" => "lead",
            _ => "worker",
        };
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
        var editItem = new MenuItem { Header = "设置（模型 / API）…" };
        editItem.Click += async (_, _) =>
        {
            var dialog = new FormDialog($"设置 · {employee.Name}", new[]
            {
                new FormField("title", "职能", "", employee.Title),
                new FormField("model", "调用模型（留空用全局默认）", "例如 deepseek-chat", employee.Model),
                new FormField("baseUrl", "接口地址（留空用全局默认）", "https://api.deepseek.com", employee.BaseUrl),
                new FormField("apiKey", "API Key（留空保持不变）", "", "", null, true),
            }, "这位员工可以单独用自己的一套 API 与模型——留空就跟随全局设置。");
            if (dialog.ShowDialog() != true) return;
            var v = dialog.Values;
            var payload = new Dictionary<string, object>
            {
                ["id"] = employee.Id,
                ["name"] = employee.Name,
                ["title"] = v["title"],
                ["level"] = employee.Level,
                ["departmentId"] = employee.DepartmentId,
                ["model"] = v["model"],
                ["baseUrl"] = v["baseUrl"],
            };
            if (!string.IsNullOrEmpty(v["apiKey"])) payload["apiKey"] = v["apiKey"];
            await Http.PostAsync($"{BaseUrl}/api/employee",
                new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"));
            await RefreshStateAsync();
        };
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
        menu.Items.Add(deleteItem);
        menu.PlacementTarget = anchor;
        menu.IsOpen = true;
    }

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
                Icon = Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? Drawing.SystemIcons.Application,
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
        public string Bubble { get; init; } = "#FFFFFF";
        public string BubbleLine { get; init; } = "#E9E6E1";
        public string TextColor { get; init; } = "#1E1E1E";
    }
}

/// <summary>一个字段：关键字、标签、占位、默认值、可选下拉项、是否密码。</summary>
public sealed record FormField(
    string Key, string Label, string Placeholder = "", string Value = "",
    string[]? Options = null, bool IsSecret = false);

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
        Background = new SolidColorBrush(Color.FromRgb(250, 249, 247));
        FontFamily = new FontFamily("Microsoft YaHei UI, Segoe UI");
        FontSize = 13;

        var stack = new StackPanel { Margin = new Thickness(20, 18, 20, 16) };
        if (note is not null)
        {
            stack.Children.Add(new TextBlock
            {
                Text = note,
                TextWrapping = TextWrapping.Wrap,
                Foreground = new SolidColorBrush(Color.FromRgb(107, 114, 128)),
                Margin = new Thickness(0, 0, 0, 12),
            });
        }

        foreach (var field in fields)
        {
            stack.Children.Add(new TextBlock
            {
                Text = field.Label,
                Foreground = new SolidColorBrush(Color.FromRgb(107, 114, 128)),
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
                    Margin = new Thickness(0, 0, 0, 12),
                    Padding = new Thickness(8, 6, 8, 6),
                };
                if (field.Placeholder != "") box.ToolTip = field.Placeholder;
                if (field.IsSecret) box.FontFamily = new FontFamily("Consolas");
                _boxes[field.Key] = box;
                stack.Children.Add(box);
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
            Background = new SolidColorBrush(Color.FromRgb(59, 130, 246)),
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
