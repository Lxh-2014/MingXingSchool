using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Net.Http;
using MingxingSchool.Desktop.Models;
using MingxingSchool.Desktop.Services;

namespace MingxingSchool.Desktop.Views.Pages;

/// <summary>
/// 邮件中心：管理 SMTP 配置、发送测试邮件与处罚邮件。
/// </summary>
public partial class MailPage : UserControl
{
    /// <summary>学生下拉数据源</summary>
    private readonly ObservableCollection<StudentOption> _students = new();

    /// <summary>构造函数：初始化并加载配置与学生。</summary>
    public MailPage()
    {
        InitializeComponent();
        StudentCombo.ItemsSource = _students;
        DateBox.SelectedDate = DateTime.Today;
        Loaded += async (_, _) =>
        {
            await LoadConfigAsync();
            await LoadStudentsAsync();
        };
    }

    /// <summary>
    /// 读取并回填邮件服务器配置。
    /// </summary>
    private async Task LoadConfigAsync()
    {
        try
        {
            var res = await AppServices.Api.SendAsync<MailConfigResponse>(HttpMethod.Get, "/api/mail/config");
            if (res.Config is null) return;
            HostBox.Text = res.Config.Host;
            PortBox.Text = res.Config.Port.ToString();
            SecureBox.IsChecked = res.Config.Secure;
            UserBox.Text = res.Config.User;
            FromNameBox.Text = res.Config.FromName;
            FromAddressBox.Text = res.Config.FromAddress;
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>
    /// 拉取可接收处罚邮件的学生列表。
    /// </summary>
    private async Task LoadStudentsAsync()
    {
        try
        {
            var res = await AppServices.Api.SendAsync<MailStudentsResponse>(HttpMethod.Get, "/api/mail/students");
            _students.Clear();
            foreach (var s in res.Students)
            {
                _students.Add(new StudentOption(s.UserId, s.Name, s.Email));
            }
            if (_students.Count > 0)
            {
                StudentCombo.SelectedIndex = 0;
            }
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>保存邮件服务器配置。</summary>
    private async void SaveConfig_Click(object sender, RoutedEventArgs e)
    {
        var port = int.TryParse(PortBox.Text.Trim(), out var p) ? p : 465;
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Put, "/api/mail/config", new
            {
                host = HostBox.Text.Trim(),
                port,
                secure = SecureBox.IsChecked == true,
                user = UserBox.Text.Trim(),
                pass = PassBox.Password,
                fromName = FromNameBox.Text.Trim(),
                fromAddress = FromAddressBox.Text.Trim(),
            });
            ToastService.Show("邮件配置已保存", ToastKind.Success);
            PassBox.Password = string.Empty;
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>发送测试邮件到指定地址。</summary>
    private async void Test_Click(object sender, RoutedEventArgs e)
    {
        var to = DialogService.Prompt("发送测试邮件", "输入测试收件人邮箱", placeholder: "收件人邮箱");
        if (to is null) return;
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Post, "/api/mail/test", new { to = to.Trim() });
            ToastService.Show("测试邮件已发送，请查收", ToastKind.Success);
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>发送处罚邮件。</summary>
    private async void Send_Click(object sender, RoutedEventArgs e)
    {
        var student = StudentCombo.SelectedItem as StudentOption;
        if (student is null)
        {
            ToastService.Show("请先选择学生", ToastKind.Warning);
            return;
        }
        var reason = ReasonBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(reason))
        {
            ToastService.Show("请填写违纪原因", ToastKind.Warning);
            return;
        }
        var punishments = PunishBox.Text
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .Where(l => l.Length > 0)
            .ToList();
        if (punishments.Count == 0)
        {
            ToastService.Show("请至少填写一条处理决定", ToastKind.Warning);
            return;
        }
        if (!DialogService.Confirm("发送处罚邮件", $"确认向「{student.Name}」发送处罚邮件？", "发送", danger: true))
        {
            return;
        }

        SendButton.IsEnabled = false;
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Post, "/api/mail/discipline", new
            {
                userId = student.UserId,
                date = (DateBox.SelectedDate ?? DateTime.Today).ToString("yyyy-MM-dd"),
                reason,
                punishments,
                grade = string.IsNullOrWhiteSpace(GradeBox.Text) ? null : GradeBox.Text.Trim(),
                className = string.IsNullOrWhiteSpace(ClassBox.Text) ? null : ClassBox.Text.Trim(),
            });
            ToastService.Show("处罚邮件已发送", ToastKind.Success);
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
        finally { SendButton.IsEnabled = true; }
    }
}

/// <summary>
/// 处罚邮件收件学生选项。
/// </summary>
public sealed class StudentOption
{
    /// <summary>用户 ID</summary>
    public string UserId { get; init; } = string.Empty;
    /// <summary>姓名</summary>
    public string Name { get; init; } = string.Empty;
    /// <summary>邮箱</summary>
    public string Email { get; init; } = string.Empty;

    /// <summary>
    /// 构造选项。
    /// </summary>
    public StudentOption(string userId, string name, string email)
    {
        UserId = userId;
        Name = name;
        Email = email;
    }
}