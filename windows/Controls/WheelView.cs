using System.Globalization;
using System.Windows;
using System.Windows.Media;

namespace MingxingSchool.Desktop.Controls;

/// <summary>
/// 转盘绘制控件：按网页端 spin-wheel.js 的绘制规则还原
/// （白色分隔线、橙色外圈、中心白圆 + 橙色内圆、沿半径竖排文字）。
/// </summary>
public sealed class WheelView : FrameworkElement
{
    /// <summary>旋转用的角度变换（由页面动画驱动）</summary>
    private readonly RotateTransform _rotate = new();

    /// <summary>选项文字列表（为空时不绘制扇形）</summary>
    public IReadOnlyList<string> Options { get; set; } = Array.Empty<string>();

    /// <summary>每个扇形的填充色（按顺序循环使用）</summary>
    public IReadOnlyList<Color> SliceColors { get; set; } = Array.Empty<Color>();

    /// <summary>外圈描边色（网页端固定橙色）</summary>
    private static readonly Color RingColor = Color.FromRgb(0xFF, 0xB8, 0x4D);

    /// <summary>文字颜色（网页端为黑色）</summary>
    private static readonly Color TextColor = Colors.Black;

    /// <summary>构造函数：挂上旋转变换，原点设在控件中心。</summary>
    public WheelView()
    {
        RenderTransform = _rotate;
        RenderTransformOrigin = new Point(0.5, 0.5);
    }

    /// <summary>当前旋转角度（度），供页面做动画驱动。</summary>
    public double Angle
    {
        get => _rotate.Angle;
        set => _rotate.Angle = value;
    }

    /// <summary>重绘转盘。</summary>
    protected override void OnRender(DrawingContext dc)
    {
        var size = Math.Min(ActualWidth, ActualHeight);
        if (size <= 0)
        {
            return;
        }

        // 绘制尺寸与网页端一致：半径 = 尺寸/2 - 20
        var radius = size / 2 - 20;
        var count = Options.Count;

        dc.PushTransform(new TranslateTransform(size / 2, size / 2));
        dc.PushTransform(new RotateTransform(-90));   // 第一个选项从正上方开始

        if (count > 0)
        {
            var anglePer = 2 * Math.PI / count;
            var borderPen = new Pen(Brushes.White, 4);
            borderPen.Freeze();

            for (var i = 0; i < count; i++)
            {
                var start = i * anglePer;
                var end = start + anglePer;

                // 扇形：圆心 → 直线到弧起点 → 沿圆弧到弧终点
                var geometry = new StreamGeometry();
                using (var ctx = geometry.Open())
                {
                    ctx.BeginFigure(new Point(0, 0), true, true);
                    ctx.LineTo(new Point(radius * Math.Cos(start), radius * Math.Sin(start)), true, false);
                    ctx.ArcTo(
                        new Point(radius * Math.Cos(end), radius * Math.Sin(end)),
                        new Size(radius, radius),
                        0, false, SweepDirection.Clockwise, true, false);
                }
                geometry.Freeze();

                var fill = new SolidColorBrush(SliceColors.Count > 0 ? SliceColors[i % SliceColors.Count] : RingColor);
                fill.Freeze();
                dc.DrawGeometry(fill, borderPen, geometry);

                DrawLabel(dc, Options[i], start + anglePer / 2, radius);
            }

            // 外圈描边
            var ringPen = new Pen(new SolidColorBrush(RingColor), 8);
            ringPen.Freeze();
            dc.DrawEllipse(null, ringPen, new Point(0, 0), radius, radius);

            // 中心白圆 + 橙色描边
            var hubPen = new Pen(new SolidColorBrush(RingColor), 6);
            hubPen.Freeze();
            dc.DrawEllipse(Brushes.White, hubPen, new Point(0, 0), 40, 40);

            // 中心小橙圆
            var hubFill = new SolidColorBrush(RingColor);
            hubFill.Freeze();
            dc.DrawEllipse(hubFill, null, new Point(0, 0), 20, 20);
        }

        dc.Pop();
        dc.Pop();
    }

    /// <summary>
    /// 绘制沿半径方向竖排的选项文字（逐字符，字号 14、行距 16，与网页端一致）。
    /// </summary>
    /// <param name="dc">绘图上下文</param>
    /// <param name="text">选项文字</param>
    /// <param name="midAngle">该扇形中线的角度（弧度）</param>
    /// <param name="radius">转盘半径</param>
    private void DrawLabel(DrawingContext dc, string text, double midAngle, double radius)
    {
        const double fontSize = 14;
        const double charSpacing = 16;
        var pixelsPerDip = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        var typeface = new Typeface(new FontFamily("Arial, Microsoft YaHei UI"), FontStyles.Normal,
            FontWeights.Bold, FontStretches.Normal);

        dc.PushTransform(new RotateTransform(midAngle * 180 / Math.PI));
        dc.PushTransform(new TranslateTransform(radius * 0.65, 0));
        dc.PushTransform(new RotateTransform(90));   // 文字竖排：字头朝外

        var chars = text?.ToCharArray() ?? Array.Empty<char>();
        var startY = -(chars.Length - 1) * charSpacing / 2.0;
        var brush = new SolidColorBrush(TextColor);
        brush.Freeze();

        for (var i = 0; i < chars.Length; i++)
        {
            var ft = new FormattedText(
                chars[i].ToString(),
                CultureInfo.CurrentUICulture,
                FlowDirection.LeftToRight,
                typeface,
                fontSize,
                brush,
                pixelsPerDip);
            dc.DrawText(ft, new Point(-ft.Width / 2, startY + i * charSpacing - ft.Height / 2));
        }

        dc.Pop();
        dc.Pop();
        dc.Pop();
    }
}
