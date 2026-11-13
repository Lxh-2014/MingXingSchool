using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Data;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using MingxingSchool.Desktop.Services;

namespace MingxingSchool.Desktop.Converters;

/// <summary>
/// 取反布尔值：用于“加载中”时禁用某些交互的绑定。
/// </summary>
public sealed class InverseBoolConverter : IValueConverter
{
    /// <summary>
    /// 将布尔值取反；非布尔值按 false 处理。
    /// </summary>
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => value is bool b && !b;

    /// <summary>
    /// 反向转换，同样取反。
    /// </summary>
    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => value is bool b && !b;
}

/// <summary>
/// 布尔值取反后再转 Visibility：true 隐藏，false 显示。
/// </summary>
public sealed class InverseBooleanToVisibilityConverter : IValueConverter
{
    /// <summary>
    /// true 返回 Collapsed，false 返回 Visible。
    /// </summary>
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => value is bool b && b ? Visibility.Collapsed : Visibility.Visible;

    /// <summary>
    /// 反向转换暂不支持。
    /// </summary>
    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

/// <summary>
/// null / 空字符串返回 Collapsed，否则 Visible，用于“空状态”提示。
/// </summary>
public sealed class NullToVisibilityConverter : IValueConverter
{
    /// <summary>
    /// 判断值是否为空并返回对应可见性。
    /// </summary>
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        var isEmpty = value is null || (value is string s && string.IsNullOrWhiteSpace(s));
        return isEmpty ? Visibility.Collapsed : Visibility.Visible;
    }

    /// <summary>
    /// 反向转换暂不支持。
    /// </summary>
    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

/// <summary>
/// 将图片 URL（相对或绝对）转换为 WPF 可用的 ImageSource。
/// </summary>
public sealed class ImageUrlConverter : IValueConverter
{
    /// <summary>
    /// 已缓存的对象，避免同一 URL 重复解码。
    /// </summary>
    private static readonly Dictionary<string, BitmapImage?> Cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// 把 URL 解析为 BitmapImage；空值或解析失败时返回 null。
    /// </summary>
    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is not string url || string.IsNullOrWhiteSpace(url))
        {
            return null;
        }

        if (Cache.TryGetValue(url, out var cached))
        {
            return cached;
        }

        BitmapImage? image = null;
        try
        {
            var absolute = url.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                ? url
                : new Uri(new Uri(AppServices.BaseUrl.TrimEnd('/') + "/"), url.TrimStart('/')).ToString();

            image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
            image.UriSource = new Uri(absolute, UriKind.Absolute);
            image.EndInit();
            image.Freeze();
        }
        catch (Exception ex) when (ex is UriFormatException or IOException or NotSupportedException)
        {
            image = null;
        }

        Cache[url] = image;
        return image;
    }

    /// <summary>
    /// 反向转换暂不支持。
    /// </summary>
    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}

/// <summary>
/// 根据会议/公告状态返回不同颜色，保证浅色和深色主题下都可读。
/// </summary>
public sealed class StatusToBrushConverter : IValueConverter
{
    /// <summary>
    /// 将状态文本映射为画刷；未知状态返回次要文字色。
    /// </summary>
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        var status = value as string ?? string.Empty;
        var key = status switch
        {
            "待审批" or "待处理" or "待审核" or "待确认" or "待取货" or "退款审核中" => "WarningBrush",
            "已通过" or "已批准" or "正常" or "在售" or "已完成" or "已退款" => "SuccessBrush",
            "已拒绝" or "已驳回" or "禁用" or "已取消" or "退款已拒绝" => "DangerBrush",
            _ => "InfoBrush",
        };
        return Application.Current.TryFindResource(key) as Brush ?? Brushes.Gray;
    }

    /// <summary>
    /// 反向转换暂不支持。
    /// </summary>
    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}
