using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Net.Http;
using MingxingSchool.Desktop.Models;
using MingxingSchool.Desktop.Services;

namespace MingxingSchool.Desktop.Views.Pages;

/// <summary>
/// 用户管理页：列出全部用户并提供增删改查及邮箱绑定操作（仅管理员）。
/// </summary>
public partial class UsersPage : UserControl
{
    /// <summary>邮箱绑定缓存：userId → email</summary>
    private readonly Dictionary<string, string> _bindings = new(StringComparer.Ordinal);

    /// <summary>表格数据源</summary>
    private readonly ObservableCollection<UserRow> _users = new();

    /// <summary>构造函数：初始化并加载数据。</summary>
    public UsersPage()
    {
        InitializeComponent();
        UserGrid.ItemsSource = _users;
        Loaded += async (_, _) => await LoadUsersAsync();
    }

    /// <summary>
    /// 拉取用户列表与邮箱绑定并填充表格。
    /// </summary>
    private async Task LoadUsersAsync()
    {
        try
        {
            var list = await AppServices.Api.SendAsync<UserListResponse>(HttpMethod.Get, "/api/users");
            var bindings = await AppServices.Api.SendAsync<MailBindingsResponse>(HttpMethod.Get, "/api/mail/bindings");

            _bindings.Clear();
            foreach (var b in bindings.Bindings)
            {
                _bindings[b.UserId] = b.Email;
            }

            _users.Clear();
            foreach (var u in list.Users)
            {
                var email = _bindings.TryGetValue(u.Id, out var e) ? e : string.Empty;
                _users.Add(new UserRow
                {
                    Id = u.Id,
                    Name = u.Name,
                    Points = u.Points ?? "0",
                    Email = string.IsNullOrWhiteSpace(email) ? "—" : email,
                    IsAdminRow = u.Role == "admin",
                });
            }
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>从按钮的 DataContext 取出所在行。</summary>
    private static UserRow? RowOf(object sender)
        => (sender as Button)?.DataContext as UserRow;

    /// <summary>新建用户（三步：姓名 → 学号 → 自定义 ID）。</summary>
    private async void Create_Click(object sender, RoutedEventArgs e)
    {
        var name = DialogService.Prompt("新建用户", "第一步：输入姓名（全局唯一）", placeholder: "姓名");
        if (name is null) return;
        var password = DialogService.Prompt("新建用户", "第二步：设置初始学号", placeholder: "学号", isPassword: true);
        if (password is null) return;
        var cid = DialogService.Prompt("新建用户", "第三步：自定义 ID（留空自动生成）", placeholder: "ID（可选）");
        if (cid is null) return;

        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Post, "/api/users", new
            {
                name = name.Trim(),
                password,
                id = string.IsNullOrWhiteSpace(cid) ? null : cid.Trim(),
            });
            ToastService.Show("用户创建成功", ToastKind.Success);
            await LoadUsersAsync();
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>重置某用户的学号。</summary>
    private async void ResetPwd_Click(object sender, RoutedEventArgs e)
    {
        var row = RowOf(sender);
        if (row is null) return;
        var password = DialogService.Prompt($"重置学号 · {row.Name}", $"为「{row.Name}」设置新学号", placeholder: "新学号", isPassword: true);
        if (password is null) return;
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Patch, $"/api/users/{Uri.EscapeDataString(row.Id)}", new { password });
            ToastService.Show("学号重置成功", ToastKind.Success);
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>重命名用户。</summary>
    private async void Rename_Click(object sender, RoutedEventArgs e)
    {
        var row = RowOf(sender);
        if (row is null) return;
        var name = DialogService.Prompt($"重命名 · {row.Name}", "输入新的姓名", row.Name, placeholder: "新姓名");
        if (name is null) return;
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Patch, $"/api/users/{Uri.EscapeDataString(row.Id)}", new { name = name.Trim() });
            ToastService.Show("姓名已更新", ToastKind.Success);
            await LoadUsersAsync();
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>设置用户积分。</summary>
    private async void Points_Click(object sender, RoutedEventArgs e)
    {
        var row = RowOf(sender);
        if (row is null) return;
        var val = DialogService.Prompt($"设置积分 · {row.Name}", "输入积分数值（整数，可带负号）", row.Points, placeholder: "积分");
        if (val is null) return;
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Patch, $"/api/users/{Uri.EscapeDataString(row.Id)}", new { points = val.Trim() });
            ToastService.Show("积分已更新", ToastKind.Success);
            await LoadUsersAsync();
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>为某用户绑定 / 修改 / 解绑邮箱。</summary>
    private async void BindMail_Click(object sender, RoutedEventArgs e)
    {
        var row = RowOf(sender);
        if (row is null) return;
        var current = _bindings.TryGetValue(row.Id, out var e0) ? e0 : string.Empty;
        var desc = string.IsNullOrWhiteSpace(current)
            ? $"「{row.Name}」尚未绑定邮箱。绑定后管理员可向其发送通知邮件。"
            : $"当前绑定：{current}。输入新邮箱可修改，清空即解绑。";
        var email = DialogService.Prompt($"绑定邮箱 · {row.Name}", desc, current, placeholder: "邮箱地址");
        if (email is null) return;
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Put, $"/api/mail/bindings/{Uri.EscapeDataString(row.Id)}", new { email = email.Trim() });
            ToastService.Show(string.IsNullOrWhiteSpace(email) ? "已解绑邮箱" : "邮箱已保存", ToastKind.Success);
            await LoadUsersAsync();
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>修改用户 ID。</summary>
    private async void ChangeId_Click(object sender, RoutedEventArgs e)
    {
        var row = RowOf(sender);
        if (row is null) return;
        var newId = DialogService.Prompt($"改 ID · {row.Name}", $"将「{row.Name}」的 ID 由 {row.Id} 改为", row.Id, placeholder: "新 ID");
        if (newId is null) return;
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Patch, $"/api/users/{Uri.EscapeDataString(row.Id)}", new { id = newId.Trim() });
            ToastService.Show("ID 修改成功", ToastKind.Success);
            await LoadUsersAsync();
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>切换权限组（普通用户 / 管理员）。</summary>
    private async void ChangeRole_Click(object sender, RoutedEventArgs e)
    {
        var row = RowOf(sender);
        if (row is null) return;
        var target = row.IsAdminRow ? "user" : "admin";
        var toText = target == "admin" ? "管理员" : "普通用户";
        if (!DialogService.Confirm("切换权限组", $"将「{row.Name}」设为「{toText}」？", "确认切换", danger: false))
        {
            return;
        }
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Patch, $"/api/users/{Uri.EscapeDataString(row.Id)}", new { role = target });
            ToastService.Show($"已设为{toText}", ToastKind.Success);
            await LoadUsersAsync();
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>删除用户（不可恢复）。</summary>
    private async void Delete_Click(object sender, RoutedEventArgs e)
    {
        var row = RowOf(sender);
        if (row is null) return;
        if (!DialogService.Confirm($"删除用户 · {row.Name}", $"确定删除「{row.Name}」？该操作不可恢复！", "删除", danger: true))
        {
            return;
        }
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Delete, $"/api/users/{Uri.EscapeDataString(row.Id)}");
            ToastService.Show("用户已删除", ToastKind.Success);
            await LoadUsersAsync();
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }
}

/// <summary>
/// 用户管理表格行模型。
/// </summary>
public sealed class UserRow
{
    /// <summary>用户 ID</summary>
    public string Id { get; init; } = string.Empty;
    /// <summary>姓名</summary>
    public string Name { get; init; } = string.Empty;
    /// <summary>积分（服务端可能返回超大数字字符串）</summary>
    public string Points { get; init; } = "0";
    /// <summary>邮箱展示文本（未绑定为 —）</summary>
    public string Email { get; init; } = "—";
    /// <summary>是否为管理员行</summary>
    public bool IsAdminRow { get; init; }
    /// <summary>角色中文名</summary>
    public string RoleText => IsAdminRow ? "管理员" : "用户";
    /// <summary>头像首字符</summary>
    public string AvatarText => string.IsNullOrWhiteSpace(Name) ? "?" : Name[..1];
}