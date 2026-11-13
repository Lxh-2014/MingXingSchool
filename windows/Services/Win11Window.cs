using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace MingxingSchool.Desktop.Services;

/// <summary>
/// Win11 窗口外观辅助：为无边框窗口补回系统圆角与暗色标题栏。
/// 说明：WPF 设置 WindowStyle=None 后会丢失系统圆角，这里通过 DWM 属性补回。
/// </summary>
public static class Win11Window
{
    /// <summary>DWMWA_WINDOW_CORNER_PREFERENCE：窗口圆角偏好属性 ID</summary>
    private const int DwmwaWindowCornerPreference = 33;

    /// <summary>DWMWA_USE_IMMERSIVE_DARK_MODE：暗色标题栏属性 ID</summary>
    private const int DwmwaUseImmersiveDarkMode = 20;

    /// <summary>DWMWCP_ROUND：圆角取值</summary>
    private const int DwmwcpRound = 2;

    /// <summary>
    /// 调用 DWM 设置窗口属性。
    /// </summary>
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>
    /// 为窗口启用 Win11 圆角，并按主题切换标题栏明暗。
    /// 必须在窗口句柄创建后（SourceInitialized 事件）调用。
    /// </summary>
    /// <param name="window">目标窗口</param>
    /// <param name="dark">是否使用暗色标题栏</param>
    public static void ApplyRoundedCorners(Window window, bool dark)
    {
        IntPtr hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        // 圆角偏好：始终使用系统圆角
        int round = DwmwcpRound;
        DwmSetWindowAttribute(hwnd, DwmwaWindowCornerPreference, ref round, sizeof(int));

        // 标题栏明暗：跟随当前主题，避免最大化时顶部出现亮色条
        int darkValue = dark ? 1 : 0;
        DwmSetWindowAttribute(hwnd, DwmwaUseImmersiveDarkMode, ref darkValue, sizeof(int));
    }
}
