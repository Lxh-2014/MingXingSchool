using System.Windows;

namespace MingxingSchool.Desktop.Services;

/// <summary>
/// 运行时主题切换：整体替换 Themes/Light.xaml 或 Themes/Dark.xaml。
/// </summary>
public static class ThemeManager
{
    /// <summary>当前是否为深色主题</summary>
    public static bool IsDark { get; private set; }

    /// <summary>
    /// 应用主题；所有使用 DynamicResource 的控件会立即刷新。
    /// </summary>
    public static void Apply(bool dark)
    {
        var app = Application.Current;
        if (app is null)
        {
            return;
        }

        var source = new Uri($"pack://application:,,,/Themes/{(dark ? "Dark" : "Light")}.xaml", UriKind.Absolute);
        var dictionary = new ResourceDictionary { Source = source };
        var merged = app.Resources.MergedDictionaries;

        for (var i = 0; i < merged.Count; i++)
        {
            var current = merged[i].Source?.OriginalString ?? string.Empty;
            if (current.Contains("/Themes/", StringComparison.OrdinalIgnoreCase))
            {
                merged[i] = dictionary;
                IsDark = dark;
                return;
            }
        }

        merged.Add(dictionary);
        IsDark = dark;
    }
}
