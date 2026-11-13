using System.Windows;

namespace MingxingSchool.Desktop.Services;

/// <summary>
/// 提示类型，决定 Toast 左侧强调色。
/// </summary>
public enum ToastKind
{
    /// <summary>普通信息</summary>
    Info,
    /// <summary>成功</summary>
    Success,
    /// <summary>警告</summary>
    Warning,
    /// <summary>错误</summary>
    Error,
}

/// <summary>
/// 一条 Toast 消息。
/// </summary>
public sealed record ToastMessage(string Text, ToastKind Kind, DateTime Time);

/// <summary>
/// 全局轻提示：页面发消息，主窗口负责展示。
/// </summary>
public static class ToastService
{
    /// <summary>主窗口订阅该事件展示 Toast</summary>
    public static event Action<ToastMessage>? Requested;

    /// <summary>
    /// 显示一条提示；确保在 UI 线程触发。
    /// </summary>
    public static void Show(string text, ToastKind kind = ToastKind.Info)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        var app = Application.Current;
        if (app is not null && !app.Dispatcher.CheckAccess())
        {
            app.Dispatcher.Invoke(() => Show(text, kind));
            return;
        }
        Requested?.Invoke(new ToastMessage(text, kind, DateTime.Now));
    }
}
