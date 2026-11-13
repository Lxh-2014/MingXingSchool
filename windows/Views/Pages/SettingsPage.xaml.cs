using System.Windows;
using System.Windows.Controls;
using System.Net.Http;
using MingxingSchool.Desktop.Models;
using MingxingSchool.Desktop.Services;
using MingxingSchool.Desktop.Views;

namespace MingxingSchool.Desktop.Views.Pages;

/// <summary>
/// 设置页：账号邮箱绑定、修改密码、深色模式切换与关于信息。
/// </summary>
public partial class SettingsPage : UserControl
{
    /// <summary>构造函数：初始化控件并读取当前状态。</summary>
    public SettingsPage()
    {
        InitializeComponent();
        DarkBox.IsChecked = ThemeManager.IsDark;
        ServerText.Text = "服务器：" + AppServices.BaseUrl + "　|　用户 ID：" + (AppServices.CurrentUser?.UserId ?? "—");
        Loaded += async (_, _) => await LoadBindingAsync();
    }

    /// <summary>
    /// 读取当前用户绑定的邮箱并回填。
    /// </summary>
    private async Task LoadBindingAsync()
    {
        try
        {
            var res = await AppServices.Api.SendAsync<MailBindingResponse>(HttpMethod.Get, "/api/mail/me");
            var email = res.Binding?.Email ?? string.Empty;
            EmailText.Text = string.IsNullOrWhiteSpace(email) ? "尚未绑定邮箱" : email;
            EmailText.Foreground = string.IsNullOrWhiteSpace(email)
                ? (System.Windows.Media.Brush)FindResource("TextSecondaryBrush")
                : (System.Windows.Media.Brush)FindResource("TextPrimaryBrush");
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>绑定 / 修改 / 解绑邮箱。</summary>
    private async void BindEmail_Click(object sender, RoutedEventArgs e)
    {
        var current = EmailText.Text;
        if (current == "尚未绑定邮箱") current = string.Empty;
        var desc = string.IsNullOrWhiteSpace(current)
            ? "绑定邮箱后，管理员可向你发送通知邮件。"
            : $"当前绑定：{current}。输入新邮箱可修改，清空即解绑。";
        var email = DialogService.Prompt("绑定邮箱", desc, current, placeholder: "邮箱地址");
        if (email is null) return;
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Put, "/api/mail/me", new { email = email.Trim() });
            ToastService.Show(string.IsNullOrWhiteSpace(email) ? "已解绑邮箱" : "邮箱已保存", ToastKind.Success);
            await LoadBindingAsync();
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>修改登录密码（验证旧密码）。</summary>
    private async void ChangePwd_Click(object sender, RoutedEventArgs e)
    {
        var result = DialogService.Form("修改密码", "验证旧密码后设置新密码（长度不少于 4 位）", new List<FormField>
        {
            new() { Key = "old", Label = "旧密码", IsPassword = true },
            new() { Key = "new", Label = "新密码", IsPassword = true },
        });
        if (result is null) return;

        var old = result.TryGetValue("old", out var o) ? o : string.Empty;
        var newPwd = result.TryGetValue("new", out var n) ? n : string.Empty;
        if (string.IsNullOrWhiteSpace(old) || string.IsNullOrWhiteSpace(newPwd))
        {
            ToastService.Show("请填写旧密码和新密码", ToastKind.Warning);
            return;
        }
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Post, "/api/profile/password", new
            {
                oldPassword = old,
                newPassword = newPwd,
            });
            ToastService.Show("密码修改成功", ToastKind.Success);
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>切换深色模式并即时生效。</summary>
    private void DarkBox_Changed(object sender, RoutedEventArgs e)
    {
        if (DarkBox.IsChecked.HasValue)
        {
            AppServices.SetDarkMode(DarkBox.IsChecked.Value);
        }
    }
}