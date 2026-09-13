using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace Hive.Shell;

/// <summary>
/// 桌面外壳：负责"把面板开起来"，其余一律交给 Web 界面。
///   1. 面板已经在跑 → 直接连过去（不重复起一个）
///   2. 没在跑 → 起 node server/index.js，等它就绪
///   3. 关窗口 → 只停自己起的那个进程
///
/// 另外有一层保险：有些环境里 WebView2 的渲染输出是"冻结"的（DOM 与 JS 全正常，
/// 但画面不变，看上去就是白屏）。这里会做一次"改背景色再截图"的实验来判定，
/// 一旦判定冻结就自动改用 Edge 应用模式，保证界面一定能显示出来。
/// 全程写 %LOCALAPPDATA%\Hive\shell.log。
/// </summary>
public partial class MainWindow : Window
{
    private const int Port = 8787;
    private static readonly string BaseUrl = $"http://127.0.0.1:{Port}";

    private static readonly string LogDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Hive");
    private static readonly string LogFile = Path.Combine(LogDir, "shell.log");
    /// <summary>上次判定 WebView2 渲染不出来时留下这个标记，下次直接走 Edge，省掉一轮等待。</summary>
    private static readonly string EdgeModeFlag = Path.Combine(LogDir, "use-edge-mode");

    private Process? _server;
    private bool _startedByUs;

    public MainWindow()
    {
        Log("=== 外壳启动 ===");
        InitializeComponent();
        Loaded += OnLoadedAsync;
        Closing += OnClosing;
    }

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

    private async void OnLoadedAsync(object sender, RoutedEventArgs e)
    {
        // 上次已经判定过 WebView2 画不出来，这次就别再等了
        var useEdge = File.Exists(EdgeModeFlag);

        if (!useEdge)
        {
            try
            {
                var userData = Path.Combine(LogDir, "WebView2");
                Directory.CreateDirectory(userData);
                var options = new CoreWebView2EnvironmentOptions
                {
                    AdditionalBrowserArguments =
                        "--disable-gpu --disable-gpu-compositing --disable-features=CalculateNativeWinOcclusion",
                };
                var environment = await CoreWebView2Environment.CreateAsync(null, userData, options);
                await Web.EnsureCoreWebView2Async(environment);
                Log($"WebView2 就绪，内核 {environment.BrowserVersionString}");
                Web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                Web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            }
            catch (Exception error)
            {
                Log($"WebView2 初始化失败：{error}");
                useEdge = true;
            }
        }
        else
        {
            Log("上次判定 WebView2 渲染不可用，直接用 Edge 模式");
        }

        var ready = await IsBoardAliveAsync();
        if (!ready)
        {
            SplashText.Text = "正在启动面板…";
            _startedByUs = StartServer();
            Log($"启动服务器：{(_startedByUs ? "已发起" : "失败")}");
            ready = await WaitForBoardAsync(TimeSpan.FromSeconds(45));
        }
        if (!ready)
        {
            ShowFailure("面板没能起来。请确认已安装 Node.js（≥18），或在项目目录手动运行 npm start 看报错。");
            return;
        }
        Log("面板就绪");

        if (useEdge)
        {
            await FallbackToEdgeAsync("已用 Edge 打开面板（功能与内嵌完全一样）。");
            return;
        }

        try
        {
            Web.CoreWebView2.Navigate(BaseUrl);
            Log("已发起导航，等首屏");
            await Task.Delay(2200);
            Log("开始渲染检测");

            if (await IsRenderFrozenAsync())
            {
                Log("判定 WebView2 渲染冻结 → 记住该结论，改用 Edge 应用模式");
                try
                {
                    File.WriteAllText(EdgeModeFlag, DateTime.Now.ToString("O"));
                }
                catch
                {
                    /* 写不了标记只是下次多等一轮 */
                }
                await FallbackToEdgeAsync("这个环境的 WebView2 渲染不出来，已改用 Edge 打开（功能完全一样）。");
                return;
            }

            Log("渲染正常，显示内嵌界面");
            Splash.Visibility = Visibility.Collapsed;
            Web.Visibility = Visibility.Visible;
        }
        catch (Exception error)
        {
            Log($"导航或检测出错：{error}");
            await FallbackToEdgeAsync($"内嵌界面出错：{error.Message}");
        }
    }

    /// <summary>
    /// 判定渲染是否"冻结"：把 body 背景刷成红色再截一张，两张完全一样就说明
    /// 画面根本没跟着变（DOM 在动、像素不动），也就是白屏的根因。
    /// 截图/脚本调用一旦超时也按"渲染有问题"处理 —— 宁可降级，也不要卡在半路。
    /// </summary>
    private async Task<bool> IsRenderFrozenAsync()
    {
        var before = await CaptureAsync();
        Log($"第一张截图：{before.Length} 字节");
        if (before.Length == 0)
        {
            Log("首次截图就失败/超时 → 判定渲染异常");
            return true;
        }

        var painted = await RunScriptAsync("document.body.style.background='#ff0000'");
        if (!painted)
        {
            Log("执行脚本超时 → 判定渲染异常");
            return true;
        }
        await Task.Delay(900);

        var after = await CaptureAsync();
        Log($"第二张截图：{after.Length} 字节");
        await RunScriptAsync("document.body.style.background=''");

        if (after.Length == 0) return true;
        return before.SequenceEqual(after);
    }

    private async Task<byte[]> CaptureAsync(int timeoutMs = 4000)
    {
        try
        {
            // 必须在 UI 线程上调（WebView2 是 UI 线程对象），超时交给 WhenAny，
            // 因为渲染冻结时 CapturePreviewAsync 会一直不返回。
            var stream = new MemoryStream();
            var task = Web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
            var finished = await Task.WhenAny(task, Task.Delay(timeoutMs));
            if (finished != task)
            {
                Log("截图超时");
                return Array.Empty<byte>();
            }
            await task;
            return stream.ToArray();
        }
        catch (Exception error)
        {
            Log($"截图失败：{error.Message}");
            return Array.Empty<byte>();
        }
    }

    private async Task<bool> RunScriptAsync(string script, int timeoutMs = 4000)
    {
        try
        {
            var task = Web.CoreWebView2.ExecuteScriptAsync(script);
            var finished = await Task.WhenAny(task, Task.Delay(timeoutMs));
            if (finished != task)
            {
                Log("脚本执行超时");
                return false;
            }
            await task;
            return true;
        }
        catch (Exception error)
        {
            Log($"脚本执行失败：{error.Message}");
            return false;
        }
    }

    /// <summary>改用 Edge 应用模式打开面板：外观就是独立窗口，渲染用 Edge 自己的管线。</summary>
    private async Task FallbackToEdgeAsync(string reason)
    {
        var edge = FindEdge();
        if (edge is null)
        {
            ShowFailure($"{reason}\n但没有找到 Edge 浏览器，可以点下面按钮用默认浏览器打开。");
            return;
        }
        try
        {
            var profile = Path.Combine(LogDir, "EdgeProfile");
            Process.Start(new ProcessStartInfo(edge)
            {
                UseShellExecute = false,
                Arguments = $"--app={BaseUrl} --window-size=1320,860 --user-data-dir=\"{profile}\" --no-first-run",
            });
            Log("已用 Edge 打开面板");

            // 外壳退到后台：窗口藏起来，但进程留着托管服务器。
            // 注意不能监听 msedge 进程退出 —— 它会把活儿转交给已有实例后自己先退出，
            // 监听它会导致"Edge 窗口刚开就被连带关掉"。
            Hide();
            _ = WatchEdgeAsync();
        }
        catch (Exception error)
        {
            Log($"启动 Edge 失败：{error.Message}");
            ShowFailure($"{reason}\n启动 Edge 也失败了：{error.Message}");
        }
        await Task.CompletedTask;
    }

    /// <summary>盯着那个 Edge 应用窗口：它关了，就说明用户不用了，外壳跟着退并停掉服务器。</summary>
    private async Task WatchEdgeAsync()
    {
        await Task.Delay(8000); // 给它启动时间
        for (; ; )
        {
            await Task.Delay(3000);
            if (IsHiveEdgeWindowOpen()) continue;
            Log("Edge 面板窗口已关闭 → 外壳退出");
            Close();
            return;
        }
    }

    /// <summary>面板窗口还在不在（按窗口标题判断，比看进程可靠）。</summary>
    private static bool IsHiveEdgeWindowOpen()
    {
        try
        {
            foreach (var process in Process.GetProcessesByName("msedge"))
            {
                try
                {
                    var title = process.MainWindowTitle ?? string.Empty;
                    if (title.Contains("HIVE") || title.Contains("蜂群")) return true;
                }
                finally
                {
                    process.Dispose();
                }
            }
        }
        catch
        {
            return true; // 查不出来就别乱退
        }
        return false;
    }

    private static string? FindEdge()
    {
        string[] candidates =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Microsoft", "Edge", "Application", "msedge.exe"),
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    /// <summary>把失败原因和"用浏览器打开"的出路一起摆出来，别让人对着白屏猜。</summary>
    private void ShowFailure(string message)
    {
        Show();
        Splash.Visibility = Visibility.Visible;
        Web.Visibility = Visibility.Collapsed;
        SplashText.Text = message;
        OpenInBrowser.Visibility = Visibility.Visible;
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
        Log($"项目根：{root ?? "(没找到)"}");
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
        catch (Exception error)
        {
            Log($"启动 node 失败：{error.Message}");
            return false;
        }
    }

    /// <summary>从 exe 所在目录向上找含 server/index.js 的项目根。</summary>
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

    private void OnOpenInBrowser(object sender, RoutedEventArgs e)
    {
        try
        {
            Process.Start(new ProcessStartInfo(BaseUrl) { UseShellExecute = true });
        }
        catch (Exception error)
        {
            Log($"打开浏览器失败：{error.Message}");
        }
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        Log("=== 外壳关闭 ===");
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
