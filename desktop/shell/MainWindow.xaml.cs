using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace MessageBoard.Shell
{
    /// <summary>
    /// 桌面外壳：确保本机黑板在运行，然后用 WebView2 显示黑板页面。
    ///
    /// 纪律：关闭窗口不停止服务 —— 黑板是多方共用的，本窗口只是其中一个观察点，
    /// 关掉它不应把其他正在使用的成员一起切断。
    /// </summary>
    public partial class MainWindow : Window
    {
        private readonly int _port;
        private readonly string _baseUrl;
        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };

        public MainWindow()
        {
            InitializeComponent();

            _port = 8787;
            var portText = Environment.GetEnvironmentVariable("MESSAGE_BOARD_PORT");
            if (int.TryParse(portText, out var port) && port > 0) _port = port;

            _baseUrl = $"http://127.0.0.1:{_port}";
            Loaded += async (_, __) => await BootAsync();
        }

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
                View.Source = new Uri(_baseUrl);
                Splash.Visibility = Visibility.Collapsed;
            }
            catch (Exception ex)
            {
                Status.Text = "加载界面失败：" + ex.Message;
            }
        }
    }
}
