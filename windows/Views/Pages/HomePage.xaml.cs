using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using MingxingSchool.Desktop.Services;

namespace MingxingSchool.Desktop.Views.Pages;

/// <summary>
/// 首页（桌面平铺）：按网页端门户样式展示应用图标，站内应用切换页面，外链用默认浏览器打开。
/// </summary>
public partial class HomePage : UserControl
{
    /// <summary>单个应用入口定义（图标为项目内嵌的 PNG 资源路径）</summary>
    private sealed record AppEntry(string Name, string IconPath, string Target, bool IsExternal, bool AdminOnly = false);

    /// <summary>首页应用列表（站内应用 + 外链），顺序与网页端门户一致；AdminOnly 项仅管理员可见</summary>
    private static readonly AppEntry[] Apps =
    {
        new("明星云网盘", "Assets/Home/drive.png",     "NavDrive",    false),
        new("明星转盘",   "Assets/Home/roulette.png",  "NavRoulette", false),
        new("明星广播器", "Assets/Home/broadcast.png", "NavBroadcast", false),
        new("明星直播",   "Assets/Home/live.png",      "NavLive",     false),
        new("明星商店",   "Assets/Home/shop.png",      "NavShop",     false),
        new("QQ",         "Assets/Home/qq.png",        "https://pd.qq.com/g/MingXing233",                 true),
        new("成绩",       "Assets/Home/grade.png",     "https://www.kdocs.cn/etapps/query/q/MzRYzQLE", true),
    };

    /// <summary>构造函数：动态生成平铺图标网格。</summary>
    public HomePage()
    {
        InitializeComponent();
        BuildAppGrid();
    }

    /// <summary>
    /// 按应用列表生成平铺图标入口（55x55 图标 + 白色名称，与网页端 .app-item 一致）。
    /// </summary>
    private void BuildAppGrid()
    {
        foreach (var app in Apps)
        {
            // 管理员专属入口对普通用户隐藏（当前所有入口对所有用户可见）
            if (app.AdminOnly && !AppServices.IsAdmin)
            {
                continue;
            }

            // 图标：保持比例居中显示，略小于网页端 55px，观感更柔和
            var icon = new Image
            {
                Width = 52,
                Height = 52,
                Stretch = Stretch.Uniform,
                HorizontalAlignment = HorizontalAlignment.Center,
            };
            // 高质量缩放避免图标边缘出现硬锯齿，整体观感更柔和
            RenderOptions.SetBitmapScalingMode(icon, BitmapScalingMode.HighQuality);
            try
            {
                icon.Source = new System.Windows.Media.Imaging.BitmapImage(
                    new Uri($"pack://application:,,,/{app.IconPath}"));
            }
            catch
            {
                // 资源缺失时降级为纯文字入口，避免首页构造失败导致主界面打不开
                icon.Visibility = Visibility.Collapsed;
            }

            // 名称：白色文字 + 阴影，保证在浅蓝桌面上清晰可读
            var label = new TextBlock
            {
                Text = app.Name,
                Foreground = Brushes.White,
                FontSize = 14,
                MaxWidth = 90,
                HorizontalAlignment = HorizontalAlignment.Center,
                TextAlignment = TextAlignment.Center,
                TextTrimming = TextTrimming.CharacterEllipsis,
                Margin = new Thickness(0, 8, 0, 0),
                Effect = new DropShadowEffect
                {
                    Color = Colors.Black,
                    BlurRadius = 2,
                    ShadowDepth = 1,
                    Direction = 270,
                    Opacity = 0.25,
                },
            };

            // 单个入口：纵向排列，固定宽度保证网格整齐
            var content = new StackPanel
            {
                Width = 84,
                VerticalAlignment = VerticalAlignment.Top,
            };
            content.Children.Add(icon);
            content.Children.Add(label);

            var button = new Button
            {
                Style = (Style)FindResource("AppCard"),
                Content = content,
                Margin = new Thickness(0, 0, 30, 28),   // 横向 30、纵向 28 间距对齐网页 gap
                Tag = app,
            };
            button.Click += AppCard_Click;
            AppGrid.Children.Add(button);
        }
    }

    /// <summary>
    /// 应用入口点击：站内切换页面，外链打开浏览器。
    /// </summary>
    private void AppCard_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: AppEntry app })
        {
            return;
        }
        if (app.IsExternal)
        {
            try
            {
                Process.Start(new ProcessStartInfo(app.Target) { UseShellExecute = true });
            }
            catch
            {
                ToastService.Show("无法打开外部链接", ToastKind.Error);
            }
            return;
        }

        if (Window.GetWindow(this) is MainWindow main)
        {
            main.NavigateTo(app.Target);
        }
    }
}
