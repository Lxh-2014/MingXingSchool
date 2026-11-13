using System.Net.Http;
using MingxingSchool.Desktop.Models;

namespace MingxingSchool.Desktop.Services;

/// <summary>
/// 全局应用容器：持有唯一的 API 客户端、用户会话、设置与主题，供所有页面访问。
/// </summary>
public static class AppServices
{
    /// <summary>默认服务器地址（局域网服务器），可被本地设置覆盖</summary>
    public const string DefaultBaseUrl = "http://192.168.0.138";

    /// <summary>唯一 API 客户端（进程内单例）</summary>
    public static ApiClient Api { get; private set; } = new(DefaultBaseUrl);

    /// <summary>本地设置对象</summary>
    public static AppSettings Settings { get; private set; } = new();

    /// <summary>当前登录用户（null 表示未登录）</summary>
    public static MeDto? CurrentUser { get; private set; }

    /// <summary>登录结果中的原始头像地址（登录响应与 /api/me 结构略有差异）</summary>
    public static string? LoginAvatar { get; private set; }

    /// <summary>当前是否已登录</summary>
    public static bool IsLoggedIn => CurrentUser is { LoggedIn: true };

    /// <summary>当前用户是否管理员</summary>
    public static bool IsAdmin => CurrentUser?.IsAdmin == true;

    /// <summary>当前服务端地址（供图片 URL 拼接的转换器使用）</summary>
    public static string BaseUrl => Api.BaseUrl;

    /// <summary>登录状态变化事件（登录或登出时触发）</summary>
    public static event Action? AuthChanged;

    /// <summary>
    /// 初始化全局容器：从磁盘加载设置并建立 API 连接，应用主题偏好。
    /// </summary>
    public static void Initialize()
    {
        Settings = SettingsStore.Load();

        // 旧版本默认地址是 localhost，这里统一迁移到局域网服务器地址
        var savedUrl = Settings.BaseUrl ?? string.Empty;   // 反序列化后可能为 null
        if (string.IsNullOrWhiteSpace(savedUrl) || savedUrl.Contains("localhost") || savedUrl.Contains("127.0.0.1"))
        {
            Settings.BaseUrl = DefaultBaseUrl;
            SettingsStore.Save(Settings);
        }

        Api = new ApiClient(Settings.BaseUrl);
        ThemeManager.Apply(Settings.DarkMode);
    }

    /// <summary>
    /// 更新服务器地址并持久化。
    /// </summary>
    public static void ApplyBaseUrl(string baseUrl)
    {
        Settings.BaseUrl = ApiClient.Normalize(baseUrl);
        SettingsStore.Save(Settings);
        Api.SetBaseUrl(Settings.BaseUrl);
    }

    /// <summary>
    /// 登录：调用后端并保存会话与用户信息，触发 AuthChanged。
    /// </summary>
    /// <returns>返回后端中文提示；登录成功后为「登录成功」</returns>
    public static async Task<string> LoginAsync(string username, string password)
    {
        var result = await Api.SendAsync<LoginResultDto>(
            HttpMethod.Post,
            "/api/auth/login",
            new { username, password });

        if (result is null || !result.Success)
        {
            return result?.Message ?? "登录失败";
        }

        // 保存 Bearer token 供后续请求鉴权
        Api.SetToken(result.Token);
        LoginAvatar = result.Avatar;

        // 再拉取一次完整信息（含积分）
        try
        {
            CurrentUser = await Api.SendAsync<MeDto>(HttpMethod.Get, "/api/me");
        }
        catch
        {
            // 拉取失败时用登录响应兜底
            CurrentUser = new MeDto
            {
                LoggedIn = true,
                UserId = result.UserId,
                Name = result.Username,
                IsAdmin = result.IsAdmin,
                Points = "0",
                Avatar = result.Avatar,
            };
        }

        Settings.Username = result.Username;
        Settings.Token = result.Token ?? string.Empty;   // 保存令牌，供下次启动自动登录
        SettingsStore.Save(Settings);
        AuthChanged?.Invoke();
        return result.Message;
    }

    /// <summary>
    /// 尝试用本地保存的令牌自动登录。
    /// 令牌仍有效则恢复用户信息并返回 true；失效则清空令牌返回 false。
    /// </summary>
    public static async Task<bool> TryAutoLoginAsync()
    {
        if (string.IsNullOrWhiteSpace(Settings.Token))
        {
            return false;
        }

        Api.SetToken(Settings.Token);   // 先带上保存的令牌
        try
        {
            var me = await Api.SendAsync<MeDto>(HttpMethod.Get, "/api/me");
            if (me is { LoggedIn: true })
            {
                CurrentUser = me;
                AuthChanged?.Invoke();
                return true;
            }
        }
        catch
        {
            // 网络异常或令牌过期：走失败分支，回到登录页
        }

        Api.SetToken(null);              // 令牌已不可用，清理本地保存
        Settings.Token = string.Empty;
        SettingsStore.Save(Settings);
        return false;
    }

    /// <summary>
    /// 登出：调用后端销毁会话并清空本地状态。
    /// </summary>
    public static async Task LogoutAsync()
    {
        try
        {
            await Api.SendNoContentAsync(HttpMethod.Post, "/api/logout");
        }
        catch
        {
            // 后端不可达也强制本地登出
        }
        Api.SetToken(null);
        CurrentUser = null;
        LoginAvatar = null;
        Settings.Token = string.Empty;   // 主动登出后不再自动登录
        SettingsStore.Save(Settings);
        AuthChanged?.Invoke();
    }

    /// <summary>
    /// 刷新当前登录用户信息（下单/改分后重新拉取积分）。
    /// </summary>
    public static async Task RefreshMeAsync()
    {
        try
        {
            CurrentUser = await Api.SendAsync<MeDto>(HttpMethod.Get, "/api/me");
        }
        catch
        {
            // 刷新失败保留旧值，不影响主流程
        }
    }

    /// <summary>
    /// 切换深色模式并持久化。
    /// </summary>
    public static void SetDarkMode(bool dark)
    {
        Settings.DarkMode = dark;
        SettingsStore.Save(Settings);
        ThemeManager.Apply(dark);
    }
}