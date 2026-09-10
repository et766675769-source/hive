using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace MessageBoard.Shell
{
    /// <summary>
    /// 桌面外壳（无边框）：确保本机黑板在运行，然后用 WebView2 显示黑板页面。
    ///
    /// 纪律：关闭窗口不停止服务 —— 黑板是多方共用的，本窗口只是其中一个观察点，
    /// 关掉它不应把其他正在使用的成员一起切断。
    /// </summary>
    public partial class MainWindow : Window
    {
        private readonly int _port;
        private readonly string _baseUrl;
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };

        private System.Windows.Forms.NotifyIcon? _tray;
        private bool _trayHintShown;

        private static readonly string LogPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MessageBoard",
            "shell.log");

        /** 外壳自己的日志：托盘是否建起来、服务是否拉起，都能事后核对。 */
        private static void Log(string message)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
                File.AppendAllText(LogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
            catch
            {
                /* 日志失败不影响运行 */
            }
        }

        public MainWindow()
        {
            InitializeComponent();

            _port = 8787;
            var portText = Environment.GetEnvironmentVariable("MESSAGE_BOARD_PORT");
            if (int.TryParse(portText, out var port) && port > 0) _port = port;

            _baseUrl = $"http://127.0.0.1:{_port}";
            ApplyTheme(IsSystemLightTheme() ? "light" : "dark");
            Log($"shell started (port {_port}, {(IsSystemLightTheme() ? "light" : "dark")} theme)");
            SetupTray();

            Loaded += async (_, __) =>
            {
                // 从脚本/隐藏控制台启动时，窗口可能继承「最小化」的启动状态，这里兜底还原。
                if (WindowState == WindowState.Minimized)
                {
                    WindowState = WindowState.Normal;
                    Activate();
                }
                await BootAsync();
            };
        }

        /* ── 托盘图标：最小化之后还能找回来 ───────────────────── */

        private static System.Drawing.Icon LoadAppIcon()
        {
            try
            {
                var stream = System.Windows.Application.GetResourceStream(new Uri("app.ico", UriKind.Relative))?.Stream;
                if (stream != null) return new System.Drawing.Icon(stream);
                Log("tray: app.ico resource not found, falling back to system icon");
            }
            catch (Exception ex)
            {
                Log("tray: icon load failed: " + ex.Message);
            }
            return System.Drawing.SystemIcons.Application;
        }

        private void SetupTray()
        {
            try
            {
                var menu = new System.Windows.Forms.ContextMenuStrip();
                menu.Items.Add("显示 Message Board", null, (_, __) => RestoreWindow());
                menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
                menu.Items.Add("退出 Message Board", null, (_, __) => Quit());
                menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
                menu.Items.Add("打开黑板网页", null, (_, __) => Process.Start(new ProcessStartInfo(_baseUrl) { UseShellExecute = true }));

                _tray = new System.Windows.Forms.NotifyIcon
                {
                    Icon = LoadAppIcon(),
                    Text = "Message Board · 留言板",
                    Visible = true,
                    ContextMenuStrip = menu,
                };
                _tray.DoubleClick += (_, __) => RestoreWindow();
                Log("tray: icon created");
            }
            catch (Exception ex)
            {
                Log("tray: creation failed: " + ex.Message);
            }
        }

        private void RestoreWindow()
        {
            Show();
            if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
            Activate();
            Topmost = true;
            Topmost = false;
        }

        private void Quit()
        {
            Log("quit requested");
            try
            {
                if (_tray != null)
                {
                    _tray.Visible = false;
                    _tray.Dispose();
                    _tray = null;
                }
            }
            catch
            {
                /* 忽略 */
            }
            Close();
        }

        protected override void OnClosed(EventArgs e)
        {
            try
            {
                if (_tray != null)
                {
                    _tray.Visible = false;
                    _tray.Dispose();
                    _tray = null;
                }
            }
            catch
            {
                /* 忽略 */
            }
            base.OnClosed(e);
        }

        /* ── 无边框标题栏 ─────────────────────────────────────── */

        /// <summary>关闭键：最小化到任务栏，不结束进程（黑板仍是多方共用的）。</summary>
        private void Close_Click(object sender, RoutedEventArgs e)
        {
            WindowState = WindowState.Minimized;
            Log("minimized to taskbar (not exited)");
            if (_tray != null && !_trayHintShown)
            {
                _trayHintShown = true;
                try
                {
                    _tray.ShowBalloonTip(4000, "Message Board", "已最小化到任务栏。双击托盘图标可恢复窗口，右键可退出。", System.Windows.Forms.ToolTipIcon.Info);
                }
                catch
                {
                    /* 部分系统禁用气泡提示，忽略 */
                }
            }
        }

        /// <summary>真正的退出：托盘右键菜单 / 标题栏右键菜单；Alt+F4 与任务栏「关闭窗口」同样有效。</summary>
        private void Quit_Click(object sender, RoutedEventArgs e) => Quit();

        private void Min_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

        private void Max_Click(object sender, RoutedEventArgs e) =>
            WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

        /* ── 主题：与黑板页面保持一致 ─────────────────────────── */

        private static bool IsSystemLightTheme()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
                return key?.GetValue("AppsUseLightTheme") is int value ? value != 0 : true;
            }
            catch
            {
                return true;
            }
        }

        private static Color ColorOf(string hex) => (Color)ColorConverter.ConvertFromString(hex);

        /// <summary>页面通过 window.chrome.webview.postMessage 告知当前主题，标题栏随之变色。</summary>
        private void ApplyTheme(string theme)
        {
            var dark = string.Equals(theme, "dark", StringComparison.OrdinalIgnoreCase);

            var bar = dark ? "#1C1C1F" : "#FAF9F7";
            var line = dark ? "#2A2A2F" : "#E9E6E1";
            var ink = dark ? "#A2A2A8" : "#6B7280";
            var hover = dark ? "#26262B" : "#EFEDE9";
            var page = dark ? "#151517" : "#FAF9F7";

            TitleBar.Background = new SolidColorBrush(ColorOf(bar));
            Resources["CaptionLineBrush"] = new SolidColorBrush(ColorOf(line));
            Resources["CaptionHoverBrush"] = new SolidColorBrush(ColorOf(hover));

            var inkBrush = new SolidColorBrush(ColorOf(ink));
            TitleText.Foreground = inkBrush;
            MinButton.Foreground = inkBrush;
            MaxButton.Foreground = inkBrush;
            CloseButton.Foreground = inkBrush;

            Background = new SolidColorBrush(ColorOf(page));
            Splash.Background = new SolidColorBrush(ColorOf(page));
        }

        /* ── 启动流程 ─────────────────────────────────────────── */

        /// <summary>定位仓库根目录（含 server/index.js 的目录）。</summary>
        private static string FindRepoRoot()
        {
            var fromEnv = Environment.GetEnvironmentVariable("MESSAGE_BOARD_ROOT");
            if (!string.IsNullOrWhiteSpace(fromEnv) && File.Exists(Path.Combine(fromEnv, "server", "index.js")))
            {
                return fromEnv;
            }

            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            for (var i = 0; i < 8 && dir != null; i++, dir = dir.Parent)
            {
                if (File.Exists(Path.Combine(dir.FullName, "server", "index.js"))) return dir.FullName;
            }
            return string.Empty;
        }

        private async Task<bool> IsBoardUpAsync()
        {
            try
            {
                var response = await Http.GetAsync(_baseUrl + "/api/health");
                return response.IsSuccessStatusCode;
            }
            catch
            {
                return false;
            }
        }

        private void StartServer(string root)
        {
            var entry = Path.Combine(root, "server", "index.js");
            var psi = new ProcessStartInfo("node", $"\"{entry}\" --port {_port}")
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            Process.Start(psi);
        }

        private async Task BootAsync()
        {
            if (!await IsBoardUpAsync())
            {
                Status.Text = "正在启动黑板服务…";
                var root = FindRepoRoot();
                if (root.Length == 0)
                {
                    Status.Text = "找不到 server/index.js；请设置 MESSAGE_BOARD_ROOT 环境变量";
                    return;
                }

                try
                {
                    StartServer(root);
                }
                catch (Exception ex)
                {
                    Status.Text = "启动服务失败：" + ex.Message;
                    return;
                }

                for (var i = 0; i < 60 && !await IsBoardUpAsync(); i++) await Task.Delay(400);
            }

            if (!await IsBoardUpAsync())
            {
                Status.Text = $"黑板未能在预期时间内启动：{_baseUrl}";
                return;
            }

            try
            {
                Status.Text = "正在加载界面…";
                var userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "MessageBoard",
                    "WebView2");
                Directory.CreateDirectory(userData);

                var environment = await CoreWebView2Environment.CreateAsync(null, userData);
                await View.EnsureCoreWebView2Async(environment);
                View.CoreWebView2.WebMessageReceived += OnWebMessage;
                View.Source = new Uri(_baseUrl);
                Splash.Visibility = Visibility.Collapsed;
            }
            catch (Exception ex)
            {
                Status.Text = "加载界面失败：" + ex.Message;
            }
        }

        private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                var message = e.TryGetWebMessageAsString();
                if (string.IsNullOrWhiteSpace(message)) return;
                using var doc = JsonDocument.Parse(message);
                if (doc.RootElement.TryGetProperty("theme", out var theme))
                {
                    ApplyTheme(theme.GetString() ?? "light");
                }
            }
            catch
            {
                /* 页面消息异常不影响外壳 */
            }
        }
    }
}
