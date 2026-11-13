using System.Windows;
using MingxingSchool.Desktop.Views;

namespace MingxingSchool.Desktop.Services;

/// <summary>
/// 弹窗服务：统一处理输入、确认与表单三类对话框。
/// </summary>
public static class DialogService
{
    /// <summary>
    /// 取当前活动窗口作为对话框 Owner。
    /// </summary>
    private static Window? GetOwner()
    {
        var app = Application.Current;
        if (app is null)
        {
            return null;
        }
        return app.Windows.OfType<Window>().FirstOrDefault(w => w.IsActive) ?? app.MainWindow;
    }

    /// <summary>
    /// 显示输入弹窗，返回用户输入；取消返回 null。
    /// </summary>
    public static string? Prompt(string title, string message, string initial = "", string placeholder = "",
        bool isPassword = false, bool multiline = false, string okText = "确定")
    {
        var dialog = new PromptDialog(title, message, initial, placeholder, isPassword, multiline, okText)
        {
            Owner = GetOwner(),
        };
        return dialog.ShowDialog() == true ? dialog.Result : null;
    }

    /// <summary>
    /// 显示确认弹窗。
    /// </summary>
    public static bool Confirm(string title, string message, string okText = "确定", bool danger = true)
    {
        var dialog = new ConfirmDialog(title, message, okText, danger)
        {
            Owner = GetOwner(),
        };
        return dialog.ShowDialog() == true;
    }

    /// <summary>
    /// 显示动态表单，返回字段键值；取消返回 null。
    /// </summary>
    public static Dictionary<string, string>? Form(string title, string message, IReadOnlyList<FormField> fields, string okText = "保存")
    {
        var dialog = new FormDialog(title, message, fields, okText)
        {
            Owner = GetOwner(),
        };
        return dialog.ShowDialog() == true ? dialog.Result : null;
    }
}