using System.IO;
using System.Text.Json;

namespace MingxingSchool.Desktop.Services;

/// <summary>
/// 客户端本地设置：服务器地址、上次登录姓名、会话令牌与主题偏好。
/// 不保存密码；会话令牌用于下次启动免输入自动登录，登出时清除。
/// </summary>
public sealed class AppSettings
{
    /// <summary>服务器地址（可带端口），默认指向局域网服务器</summary>
    public string BaseUrl { get; set; } = "http://192.168.0.138";
    /// <summary>上次登录的姓名，方便下次快速登录</summary>
    public string Username { get; set; } = string.Empty;
    /// <summary>会话令牌（用于下次启动自动登录，登出或失效时清空）</summary>
    public string Token { get; set; } = string.Empty;
    /// <summary>是否启用深色模式</summary>
    public bool DarkMode { get; set; }
}

/// <summary>
/// 设置文件读写：存放在 %APPDATA%\MingxingSchool\settings.json。
/// </summary>
public static class SettingsStore
{
    /// <summary>设置文件完整路径</summary>
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "MingxingSchool",
        "settings.json");

    /// <summary>
    /// 读取设置；文件不存在或损坏时返回默认值。
    /// </summary>
    public static AppSettings Load()
    {
        try
        {
            if (!File.Exists(FilePath))
            {
                return new AppSettings();
            }
            var json = File.ReadAllText(FilePath);
            return JsonSerializer.Deserialize<AppSettings>(json, ApiClient.JsonOptions) ?? new AppSettings();
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return new AppSettings();
        }
    }

    /// <summary>
    /// 保存设置；失败时静默忽略，避免影响主流程。
    /// </summary>
    public static void Save(AppSettings settings)
    {
        try
        {
            var dir = Path.GetDirectoryName(FilePath);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }
            File.WriteAllText(FilePath, JsonSerializer.Serialize(settings, new JsonSerializerOptions
            {
                WriteIndented = true,
            }));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 设置写入失败不影响使用，忽略即可
        }
    }
}
