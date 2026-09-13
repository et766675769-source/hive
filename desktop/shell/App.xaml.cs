using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace Hive.Shell;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // 某些环境（远程桌面 / 虚拟显卡 / 老驱动）下 GPU 合成不正常，
        // 会让 WPF 自身的界面和 WebView2 一起白屏。整体退回软件渲染最稳。
        try
        {
            RenderOptions.ProcessRenderMode = RenderMode.SoftwareOnly;
        }
        catch
        {
            /* 设置不了就按默认来 */
        }
        base.OnStartup(e);
    }
}
