using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.Collections.ObjectModel;
using System.IO;
using System.Net.Http;
using MingxingSchool.Desktop.Controls;
using MingxingSchool.Desktop.Models;
using MingxingSchool.Desktop.Services;

namespace MingxingSchool.Desktop.Views.Pages;

/// <summary>
/// 明星幸运转盘：按网页端样式还原（左侧大转盘 + 操作按钮，右侧转盘选择列）。
/// </summary>
public partial class RoulettePage : UserControl
{
    /// <summary>服务端返回的全部转盘</summary>
    private readonly List<WheelDto> _wheels = new();
    /// <summary>右侧列表显示的转盘（经搜索过滤后）</summary>
    private readonly ObservableCollection<WheelDto> _visible = new();
    /// <summary>当前转盘的可打乱选项副本（顺序即显示顺序）</summary>
    private readonly List<string> _shuffled = new();
    /// <summary>当前选中的转盘</summary>
    private WheelDto? _current;
    /// <summary>主转盘累计旋转角（度）</summary>
    private double _angle;
    /// <summary>主转盘是否正在旋转</summary>
    private bool _spinning;
    /// <summary>独立页面转盘是否正在旋转</summary>
    private bool _standaloneSpinning;
    /// <summary>当前搜索关键词</summary>
    private string _keyword = string.Empty;
    /// <summary>初始化标记：避免首次加载重复触发</summary>
    private bool _initialized;
    /// <summary>未指定配色时的默认色板（与网页端 fallbackColors 一致）</summary>
    private static readonly string[] DefaultPalette =
    {
        "#FFB84D", "#FFD966", "#FFA64D", "#FFE699", "#FF9933", "#FFEB99",
    };

    /// <summary>构造函数：绑定列表数据源并在首次加载时拉取转盘。</summary>
    public RoulettePage()
    {
        InitializeComponent();
        WheelList.ItemsSource = _visible;
        WheelList.DisplayMemberPath = "Name";
        WheelList.PreviewMouseRightButtonDown += WheelList_PreviewMouseRightButtonDown;
        PreviewKeyDown += RoulettePage_PreviewKeyDown;

        Loaded += async (_, _) =>
        {
            if (_initialized)
            {
                return;
            }
            _initialized = true;
            await LoadWheelsAsync();
        };
    }

    /// <summary>加载转盘列表，默认选中第一个。</summary>
    private async Task LoadWheelsAsync(string? selectId = null)
    {
        try
        {
            var list = await AppServices.Api.SendAsync<List<WheelDto>>(HttpMethod.Get, "/roulette/api/wheels");
            _wheels.Clear();
            _wheels.AddRange(list ?? new List<WheelDto>());
            ApplyFilter();

            var target = selectId is null
                ? _visible.FirstOrDefault()
                : _visible.FirstOrDefault(w => w.Id == selectId);
            if (target is not null)
            {
                WheelList.SelectedItem = target;
                SelectWheel(target);
            }
            else
            {
                _current = null;
                _shuffled.Clear();
                Wheel.Options = Array.Empty<string>();
                Wheel.InvalidateVisual();
                ApplyBackground(null);
            }
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>按搜索关键词过滤右侧列表，并更新空状态提示。</summary>
    private void ApplyFilter()
    {
        _visible.Clear();
        var matched = string.IsNullOrWhiteSpace(_keyword)
            ? _wheels
            : _wheels.Where(w => w.Name.Contains(_keyword, StringComparison.OrdinalIgnoreCase)).ToList();
        foreach (var wheel in matched)
        {
            _visible.Add(wheel);
        }

        EmptyText.Text = string.IsNullOrWhiteSpace(_keyword) ? "暂无转盘" : "没有匹配的转盘";
        EmptyText.Visibility = _visible.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>搜索框输入：实时过滤列表。</summary>
    private void Search_TextChanged(object sender, TextChangedEventArgs e)
    {
        _keyword = SearchBox.Text.Trim();
        ApplyFilter();
    }

    /// <summary>列表选中项变化：切换到对应转盘。</summary>
    private void WheelList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (WheelList.SelectedItem is WheelDto wheel && wheel != _current)
        {
            SelectWheel(wheel);
        }
    }

    /// <summary>右键点击列表项：先选中该项，再弹出操作菜单。</summary>
    private void WheelList_PreviewMouseRightButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.OriginalSource is DependencyObject source)
        {
            var container = ItemsControl.ContainerFromElement(WheelList, source) as ListBoxItem;
            if (container is not null)
            {
                container.IsSelected = true;
            }
        }
    }

    /// <summary>切换到指定转盘：更新转盘绘制与页面背景。</summary>
    private void SelectWheel(WheelDto wheel)
    {
        _current = wheel;
        _shuffled.Clear();
        _shuffled.AddRange(wheel.Options);
        ApplyWheel(Wheel, wheel, _shuffled);
        ResetMainAngle();
        ApplyBackground(wheel);
    }

    /// <summary>把转盘数据写入绘制控件（选项、配色）并重绘。</summary>
    private static void ApplyWheel(WheelView view, WheelDto wheel, IReadOnlyList<string> options)
    {
        view.Options = options.ToArray();
        view.SliceColors = ResolveColors(wheel, options.Count);
        view.InvalidateVisual();
    }

    /// <summary>解析转盘配色：优先用户自定义，缺失时循环补齐默认色板。</summary>
    private static List<Color> ResolveColors(WheelDto wheel, int count)
    {
        var result = new List<Color>(count);
        var custom = wheel.Colors ?? new List<string>();
        for (var i = 0; i < count; i++)
        {
            var raw = custom.Count > 0 ? custom[i % custom.Count] : DefaultPalette[i % DefaultPalette.Length];
            result.Add(ParseColor(raw) ?? ParseColor(DefaultPalette[i % DefaultPalette.Length])!.Value);
        }
        return result;
    }

    /// <summary>把 #RRGGBB / #RGB 字符串解析为 Color，失败返回 null。</summary>
    private static Color? ParseColor(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }
        try
        {
            return (Color)ColorConverter.ConvertFromString(value.Trim());
        }
        catch (FormatException)
        {
            return null;
        }
        catch (NotSupportedException)
        {
            return null;
        }
    }

    /// <summary>重置主转盘的旋转角与按钮状态。</summary>
    private void ResetMainAngle()
    {
        _angle = 0;
        Wheel.Angle = 0;
        SpinButton.Content = "开始转动";
        SpinButton.IsEnabled = true;
        _spinning = false;
    }

    /// <summary>应用转盘背景色 / 背景图到页面（失败时保持默认）。</summary>
    private async void ApplyBackground(WheelDto? wheel)
    {
        var color = ParseColor(wheel?.BackgroundColor);
        RootGrid.Background = color is null ? Brushes.Transparent : new SolidColorBrush(color.Value);

        var image = wheel?.BackgroundImage;
        if (string.IsNullOrWhiteSpace(image))
        {
            RootGrid.OpacityMask = null;
            return;
        }

        try
        {
            BitmapImage bitmap;
            if (image.StartsWith('/'))
            {
                var bytes = await AppServices.Api.GetBytesAsync(image);
                bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.StreamSource = new MemoryStream(bytes);
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.EndInit();
                bitmap.Freeze();
            }
            else
            {
                bitmap = new BitmapImage(new Uri(image));
            }

            // 背景图铺满 + 半透明白色蒙层，保证转盘与按钮可读（与网页端遮罩效果一致）
            var brush = new ImageBrush(bitmap) { Stretch = Stretch.UniformToFill };
            var overlay = new SolidColorBrush(Color.FromArgb(0xB0, 0xFF, 0xFF, 0xFF));
            var group = new DrawingGroup();
            using (var ctx = group.Open())
            {
                ctx.DrawRectangle(brush, null, new Rect(0, 0, 1, 1));
                ctx.DrawRectangle(overlay, null, new Rect(0, 0, 1, 1));
            }
            group.Freeze();
            RootGrid.Background = new DrawingBrush(group)
            {
                Stretch = Stretch.Fill,
                Viewport = new Rect(0, 0, 1, 1),
                ViewportUnits = BrushMappingMode.RelativeToBoundingBox,
            };
        }
        catch
        {
            // 背景图加载失败不阻塞主流程，保留纯色背景
        }
    }

    /// <summary>按回车/空格转动转盘（输入框内除外）。</summary>
    private void RoulettePage_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Space)
        {
            return;
        }
        if (Keyboard.FocusedElement is TextBox)
        {
            return;
        }
        e.Handled = true;
        if (StandaloneOverlay.Visibility == Visibility.Visible)
        {
            StandaloneSpin_Click(this, new RoutedEventArgs());
        }
        else
        {
            Spin_Click(this, new RoutedEventArgs());
        }
    }

    /// <summary>点击「开始转动」：随机抽取结果并播放 5 秒缓动旋转。</summary>
    private void Spin_Click(object sender, RoutedEventArgs e)
    {
        if (_spinning)
        {
            return;
        }
        var options = _shuffled.Count > 0 ? _shuffled : _current?.Options ?? new List<string>();
        if (_current is null || options.Count == 0)
        {
            ToastService.Show("请先在右侧选择一个转盘", ToastKind.Info);
            return;
        }

        _spinning = true;
        SpinButton.IsEnabled = false;
        SpinButton.Content = "转动中...";

        var index = Random.Shared.Next(options.Count);
        var step = 360.0 / options.Count;
        var target = index * step + step / 2;                       // 目标扇形中线
        var finalRotation = 1800 + Random.Shared.NextDouble() * 360 + (360 - target);

        Animate(Wheel, _angle + finalRotation, () =>
        {
            _angle += finalRotation;
            Wheel.Angle = _angle;
            _spinning = false;
            SpinButton.IsEnabled = true;
            SpinButton.Content = "开始转动";
            ToastService.Show($"结果：{options[index]}", ToastKind.Success);
        });
    }

    /// <summary>打乱当前转盘的选项顺序。</summary>
    private void Shuffle_Click(object sender, RoutedEventArgs e)
    {
        if (_current is null || _shuffled.Count == 0)
        {
            ToastService.Show("请先在右侧选择一个转盘", ToastKind.Info);
            return;
        }
        for (var i = _shuffled.Count - 1; i > 0; i--)
        {
            var j = Random.Shared.Next(i + 1);
            (_shuffled[i], _shuffled[j]) = (_shuffled[j], _shuffled[i]);
        }
        ApplyWheel(Wheel, _current, _shuffled);
        ResetMainAngle();
        ToastService.Show("选项已打乱", ToastKind.Success);
    }

    /// <summary>打开独立页面（全屏遮罩中的大转盘）。</summary>
    private void Standalone_Click(object sender, RoutedEventArgs e)
    {
        if (_current is null)
        {
            ToastService.Show("请先在右侧选择一个转盘", ToastKind.Info);
            return;
        }
        StandaloneTitle.Text = _current.Name;
        StandaloneWheel.Options = Wheel.Options;
        StandaloneWheel.SliceColors = Wheel.SliceColors;
        StandaloneWheel.Angle = 0;
        StandaloneWheel.InvalidateVisual();
        StandaloneSpinButton.Content = "开始转动";
        StandaloneSpinButton.IsEnabled = true;
        _standaloneSpinning = false;
        StandaloneOverlay.Visibility = Visibility.Visible;
    }

    /// <summary>关闭独立页面。</summary>
    private void CloseStandalone_Click(object sender, RoutedEventArgs e)
    {
        StandaloneOverlay.Visibility = Visibility.Collapsed;
    }

    /// <summary>独立页面中的转动按钮。</summary>
    private void StandaloneSpin_Click(object sender, RoutedEventArgs e)
    {
        if (_standaloneSpinning)
        {
            return;
        }
        var options = Wheel.Options;
        if (options.Count == 0)
        {
            return;
        }

        _standaloneSpinning = true;
        StandaloneSpinButton.IsEnabled = false;
        StandaloneSpinButton.Content = "转动中...";

        var index = Random.Shared.Next(options.Count);
        var step = 360.0 / options.Count;
        var target = index * step + step / 2;
        var finalRotation = 1800 + Random.Shared.NextDouble() * 360 + (360 - target);
        var from = StandaloneWheel.Angle;
        var to = from + finalRotation;

        Animate(StandaloneWheel, to, () =>
        {
            StandaloneWheel.Angle = to;
            _standaloneSpinning = false;
            StandaloneSpinButton.IsEnabled = true;
            StandaloneSpinButton.Content = "开始转动";
            ToastService.Show($"结果：{options[index]}", ToastKind.Success);
        });
    }

    /// <summary>
    /// 以网页端相同的缓动（cubic-bezier(0.17,0.67,0.12,0.99)）在 5 秒内旋转到目标角度。
    /// </summary>
    /// <param name="view">要旋转的转盘控件</param>
    /// <param name="toAngle">目标累计角度（度）</param>
    /// <param name="onDone">旋转结束后的回调（在 UI 线程执行）</param>
    private static void Animate(WheelView view, double toAngle, Action onDone)
    {
        var transform = (RotateTransform)view.RenderTransform;
        var animation = new DoubleAnimation(view.Angle, toAngle, TimeSpan.FromSeconds(5))
        {
            EasingFunction = new CubicBezierEase { EasingMode = EasingMode.EaseIn },
            FillBehavior = FillBehavior.Stop,
        };
        animation.Completed += (_, _) =>
        {
            transform.BeginAnimation(RotateTransform.AngleProperty, null);
            onDone();
        };
        transform.BeginAnimation(RotateTransform.AngleProperty, animation);
    }

    /// <summary>点击「新建转盘」：填写名称与选项后提交。</summary>
    private async void Create_Click(object sender, RoutedEventArgs e)
    {
        var values = DialogService.Form("新建转盘", "填写转盘名称，选项每行一个",
            new List<FormField>
            {
                new() { Key = "name", Label = "转盘名称", Placeholder = "例如：今天吃什么" },
                new() { Key = "options", Label = "选项（每行一个）", Placeholder = "选项一\n选项二", Multiline = true },
            }, "创建");
        if (values is null)
        {
            return;
        }

        var name = values.GetValueOrDefault("name", string.Empty).Trim();
        var options = SplitOptions(values.GetValueOrDefault("options", string.Empty));
        if (string.IsNullOrWhiteSpace(name) || options.Count < 2)
        {
            ToastService.Show("名称不能为空，且至少需要 2 个选项", ToastKind.Warning);
            return;
        }

        try
        {
            var res = await AppServices.Api.SendAsync<WheelDto>(HttpMethod.Post, "/roulette/api/wheels",
                new { name, options });
            ApplyFilter();
            await LoadWheelsAsync(res?.Id);
            ToastService.Show("转盘已创建", ToastKind.Success);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>右键菜单「编辑选项」：修改当前转盘名称与选项。</summary>
    private async void Edit_Click(object sender, RoutedEventArgs e)
    {
        if (_current is null)
        {
            return;
        }
        var values = DialogService.Form("编辑转盘", "修改名称或选项（每行一个）",
            new List<FormField>
            {
                new() { Key = "name", Label = "转盘名称", Value = _current.Name },
                new() { Key = "options", Label = "选项（每行一个）", Value = string.Join("\n", _current.Options), Multiline = true },
            }, "保存");
        if (values is null)
        {
            return;
        }

        var name = values.GetValueOrDefault("name", string.Empty).Trim();
        var options = SplitOptions(values.GetValueOrDefault("options", string.Empty));
        if (string.IsNullOrWhiteSpace(name) || options.Count < 2)
        {
            ToastService.Show("名称不能为空，且至少需要 2 个选项", ToastKind.Warning);
            return;
        }

        try
        {
            await AppServices.Api.SendAsync<WheelDto>(HttpMethod.Patch,
                "/roulette/api/wheels/" + Uri.EscapeDataString(_current.Id), new { name, options });
            await LoadWheelsAsync(_current.Id);
            ToastService.Show("转盘已保存", ToastKind.Success);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>右键菜单「删除转盘」。</summary>
    private async void Delete_Click(object sender, RoutedEventArgs e)
    {
        if (_current is null)
        {
            return;
        }
        if (!DialogService.Confirm("删除转盘", $"确定删除「{_current.Name}」吗？该操作不可恢复。", "删除"))
        {
            return;
        }

        try
        {
            await AppServices.Api.SendNoContentAsync(HttpMethod.Delete,
                "/roulette/api/wheels/" + Uri.EscapeDataString(_current.Id));
            _current = null;
            await LoadWheelsAsync();
            ToastService.Show("转盘已删除", ToastKind.Success);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>把多行文本拆成选项数组（去空行、去首尾空格）。</summary>
    private static List<string> SplitOptions(string text)
        => text.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim())
            .Where(line => line.Length > 0)
            .ToList();
}

/// <summary>
/// 三次贝塞尔缓动（对应网页端 cubic-bezier(0.17,0.67,0.12,0.99)），
/// WPF 没有内置对应的 EasingFunction，这里用牛顿迭代求解。
/// </summary>
internal sealed class CubicBezierEase : EasingFunctionBase
{
    /// <summary>P1.x 控制点</summary>
    private const double X1 = 0.17;
    /// <summary>P1.y 控制点</summary>
    private const double Y1 = 0.67;
    /// <summary>P2.x 控制点</summary>
    private const double X2 = 0.12;
    /// <summary>P2.y 控制点</summary>
    private const double Y2 = 0.99;

    /// <summary>
    /// 计算缓动值：先由时间比例反解贝塞尔参数，再取对应 y 值。
    /// </summary>
    protected override double EaseInCore(double normalizedTime)
    {
        var s = normalizedTime;
        for (var i = 0; i < 8; i++)
        {
            var x = Bezier(s, X1, X2);
            var dx = BezierDerivative(s, X1, X2);
            if (Math.Abs(dx) < 1e-6)
            {
                break;
            }
            s -= (x - normalizedTime) / dx;
            s = Math.Clamp(s, 0, 1);
        }
        return Bezier(s, Y1, Y2);
    }

    /// <summary>创建自由对象副本（Freezable 约定）。</summary>
    protected override Freezable CreateInstanceCore() => new CubicBezierEase();

    /// <summary>三次贝塞尔坐标公式（端点 0、1）。</summary>
    private static double Bezier(double t, double p1, double p2)
    {
        var u = 1 - t;
        return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
    }

    /// <summary>三次贝塞尔一阶导数（用于牛顿迭代）。</summary>
    private static double BezierDerivative(double t, double p1, double p2)
    {
        var u = 1 - t;
        return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
    }
}
