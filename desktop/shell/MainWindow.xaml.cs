using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace Hive.Shell;

/// <summary>
/// 桌面外壳：负责"把面板开起来"，其余一律交给 Web 界面。
///   1. 面板已经在跑 → 直接连过去（不重复起一个）
///   2. 没在跑 → 起 node server/index.js，等它就绪
///   3. 关闭窗口 → 只停自己起的那个进程
/// </summary>
public partial class MainWindow : Window
{
    private const int Port = 8787;
    private static readonly string BaseUrl = $"http://127.0.0.1:{Port}";

    private Process? _server;
    private bool _startedByUs;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoadedAsync;
        Closing += OnClosing;
    }

    private async void OnLoadedAsync(object sender, RoutedEventArgs e)
    {
        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Hive", "WebView2");
            Directory.CreateDirectory(userData);
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await Web.EnsureCoreWebView2Async(environment);
            Web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            Web.CoreWebView2.Settings.IsStatusBarEnabled = false;
        }
        catch (Exception error)
        {
            SplashText.Text = $"WebView2 初始化失败：{error.Message}\n请安装 Microsoft Edge WebView2 运行时。";
            return;
        }

        var ready = await IsBoardAliveAsync();
        if (!ready)
        {
            SplashText.Text = "正在启动面板…";
            _startedByUs = StartServer();
            ready = await WaitForBoardAsync(TimeSpan.FromSeconds(45));
        }

        if (!ready)
        {
            SplashText.Text = "面板没能起来。\n请确认已安装 Node.js（≥18），或在项目目录手动运行 npm start 查看报错。";
            return;
        }

        Web.CoreWebView2.NavigationCompleted += (_, _) =>
        {
            Splash.Visibility = Visibility.Collapsed;
            Web.Visibility = Visibility.Visible;
        };
        Web.CoreWebView2.Navigate(BaseUrl);
    }

    private static async Task<bool> IsBoardAliveAsync()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var response = await http.GetAsync($"{BaseUrl}/api/state");
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

    private bool StartServer()
    {
        var root = FindProjectRoot();
        if (root is null) return false;

        var startInfo = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = $"server/index.js --port {Port} --host 127.0.0.1",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        try
        {
            _server = Process.Start(startInfo);
            return _server is not null;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>从 exe 所在目录向上找含 server/index.js 的项目根。</summary>
    private static string? FindProjectRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir is not null; i++)
        {
            if (File.Exists(Path.Combine(dir.FullName, "server", "index.js"))) return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (!_startedByUs || _server is not { HasExited: false }) return;
        try
        {
            _server.Kill(entireProcessTree: true);
        }
        catch
        {
            /* 关不掉就算了，别因为一个残留进程卡住关闭 */
        }
    }
}
