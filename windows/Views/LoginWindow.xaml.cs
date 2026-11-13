using System.Windows;
using System.Windows.Input;
using MingxingSchool.Desktop.Services;

namespace MingxingSchool.Desktop.Views;

/// <summary>
/// 登录窗口：输入姓名与学号，登录成功后切换到主窗口。
/// </summary>
public partial class LoginWindow : Window
{
    /// <summary>
    /// 构造窗口并回填上次登录的姓名。
    /// </summary>
    public LoginWindow()
    {
        InitializeComponent();
        UserBox.Text = AppServices.Settings.Username;   // 回填上次登录姓名
        Loaded += (_, _) =>
        {
            if (string.IsNullOrWhiteSpace(UserBox.Text)) UserBox.Focus();
            else PassBox.Focus();
        };
    }

    /// <summary>
    /// 处理登录按钮点击。
    /// </summary>
    private async void Login_Click(object sender, RoutedEventArgs e)
    {
        var username = UserBox.Text.Trim();
        var password = PassBox.Password;
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
        {
            ShowError("请输入姓名和学号");
            return;
        }

        SetBusy(true);
        try
        {
            // 服务器地址统一由本地设置决定，登录页不再提供选择
            var message = await AppServices.LoginAsync(username, password);
            if (AppServices.IsLoggedIn)
            {
                DialogResult = true;
                Close();
            }
            else
            {
                ShowError(message);
            }
        }
        catch (Exception ex)
        {
            ShowError(ex.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    /// <summary>
    /// 密码框回车直接提交。
    /// </summary>
    private void PassBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) Login_Click(sender, new RoutedEventArgs());
    }

    /// <summary>
    /// 按住标题区域拖动无边框窗口。
    /// </summary>
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.LeftButton == MouseButtonState.Pressed)
        {
            DragMove();
        }
    }

    /// <summary>
    /// 点击自绘关闭按钮：取消登录并退出应用。
    /// </summary>
    private void Close_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;   // ShowDialog 返回 false，App 会随之退出
        Close();
    }

    /// <summary>
    /// 显示错误提示。
    /// </summary>
    private void ShowError(string text)
    {
        ErrorText.Text = text;
        ErrorText.Visibility = Visibility.Visible;
    }

    /// <summary>
    /// 设置忙碌状态（登录按钮禁用、提示隐藏）。
    /// </summary>
    private void SetBusy(bool busy)
    {
        LoginButton.IsEnabled = !busy;
        LoginButton.Content = busy ? "登录中…" : "登 录";
        if (busy) ErrorText.Visibility = Visibility.Collapsed;
    }
}