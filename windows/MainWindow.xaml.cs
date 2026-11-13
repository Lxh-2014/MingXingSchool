using System.Collections.ObjectModel;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using MingxingSchool.Desktop.Core;
using MingxingSchool.Desktop.Services;
using MingxingSchool.Desktop.Views.Pages;

namespace MingxingSchool.Desktop;

/// <summary>
/// 浏览器式标签页：每个标签独立持有自己的页面实例与导航状态，
/// 切换标签不会影响其他标签已打开的页面。
/// </summary>
public class BrowserTab : ObservableObject
{
    /// <summary>标签标题（随导航变化更新）</summary>
    private string _title = "首页";

    /// <summary>是否为当前选中标签（供标签栏高亮）</summary>
    private bool _isSelected;

    /// <summary>标签显示标题</summary>
    public string Title
    {
        get => _title;
        set => SetProperty(ref _title, value);
    }

    /// <summary>是否为当前选中标签</summary>
    public bool IsSelected
    {
        get => _isSelected;
        set => SetProperty(ref _isSelected, value);
    }

    /// <summary>当前导航项名称（如 NavHome / NavDrive），用于同步侧边栏选中态</summary>
    public string NavName { get; set; } = "NavHome";

    /// <summary>该标签当前承载的页面实例</summary>
    public UserControl? Content { get; set; }
}

/// <summary>
/// 主窗口：左侧图标导航 + 顶部用户栏 + 浏览器式标签栏 + 内容区，负责页面切换与 Toast 展示。
/// </summary>
public partial class MainWindow : Window
{
    /// <summary>全部标签页集合（标签栏数据源）</summary>
    private readonly ObservableCollection<BrowserTab> _tabs = new();

    /// <summary>当前选中的标签页</summary>
    private BrowserTab? _currentTab;

    /// <summary>切换标签同步侧边栏时置真，抑制 Nav_Checked 重复创建页面</summary>
    private bool _suppressNav;

    /// <summary>构造函数：初始化界面、回填用户信息并打开首个首页标签。</summary>
    public MainWindow()
    {
        InitializeComponent();
        ApplyUserInfo();
        ToastService.Requested += OnToastRequested;
        Closed += (_, _) => ToastService.Requested -= OnToastRequested;

        // 无边框窗口：句柄创建后启用系统圆角，并监听状态变化做最大化补偿
        SourceInitialized += (_, _) => Win11Window.ApplyRoundedCorners(this, ThemeManager.IsDark);
        StateChanged += Window_StateChanged;

        TabStrip.ItemsSource = _tabs;   // 标签栏绑定数据源
        NewTab();                       // 启动时默认打开一个首页标签
    }

    /// <summary>
    /// 最小化窗口。
    /// </summary>
    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    /// <summary>
    /// 在最大化与还原之间切换。
    /// </summary>
    private void Maximize_Click(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }

    /// <summary>
    /// 关闭窗口（应用随之退出）。
    /// </summary>
    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    /// <summary>
    /// 窗口状态变化：无边框窗口最大化时会向屏幕外溢出约 8px，
    /// 这里给根容器加同等内边距避免内容被裁切，同时切换最大化按钮图标。
    /// </summary>
    private void Window_StateChanged(object? sender, EventArgs e)
    {
        RootBorder.Margin = WindowState == WindowState.Maximized ? new Thickness(8) : new Thickness(0);
        // 最大化后按钮变为“还原”图标，否则为“最大化”图标
        MaximizeButton.Content = WindowState == WindowState.Maximized ? "\uE923" : "\uE922";
    }

    // ==================== 沉浸全屏 ====================

    /// <summary>是否处于沉浸全屏模式（隐藏侧栏、顶栏与标签栏）</summary>
    private bool _immersive;

    /// <summary>进入沉浸模式前的窗口状态，用于退出时还原</summary>
    private WindowState _stateBeforeImmersive = WindowState.Normal;

    /// <summary>
    /// 切换沉浸全屏：隐藏侧边栏、顶部栏与标签栏，让当前页面铺满整个窗口。
    /// </summary>
    /// <param name="enabled">true 进入全屏，false 退出全屏</param>
    public void SetImmersive(bool enabled)
    {
        if (_immersive == enabled)
        {
            return;
        }
        _immersive = enabled;

        var chromeVisibility = enabled ? Visibility.Collapsed : Visibility.Visible;   // 外壳元素的显隐
        SidebarBar.Visibility = chromeVisibility;
        TopbarBar.Visibility = chromeVisibility;
        TabbarBar.Visibility = chromeVisibility;
        SidebarColumn.Width = enabled ? new GridLength(0) : new GridLength(72);

        // 全屏时内容区跨满整个窗口（侧栏列宽已置 0，列/行仍按原布局约定还原）
        Grid.SetColumn(ContentHost, enabled ? 0 : 1);
        Grid.SetColumnSpan(ContentHost, enabled ? 2 : 1);
        Grid.SetRow(ContentHost, enabled ? 0 : 2);
        Grid.SetRowSpan(ContentHost, enabled ? 3 : 1);

        if (enabled)
        {
            _stateBeforeImmersive = WindowState;
            WindowState = WindowState.Maximized;
        }
        else
        {
            WindowState = _stateBeforeImmersive;
        }
    }

    // ==================== 标签页 ====================

    /// <summary>
    /// 新建一个内容为首页的标签页并切换过去。
    /// </summary>
    private void NewTab()
    {
        var tab = new BrowserTab { NavName = "NavHome", Title = GetTitle("NavHome") };
        tab.Content = CreatePage(tab.NavName);   // 新标签独立创建首页实例
        _tabs.Add(tab);
        SelectTab(tab);
    }

    /// <summary>
    /// 选中指定标签页：高亮标签、同步侧边栏选中态、切换内容区。
    /// </summary>
    /// <param name="tab">要选中的标签页</param>
    private void SelectTab(BrowserTab tab)
    {
        _currentTab = tab;
        foreach (var item in _tabs)
        {
            item.IsSelected = ReferenceEquals(item, tab);
        }

        _suppressNav = true;                     // 同步侧边栏期间不要重建页面
        // 先清空全部导航选中态：当前标签可能是子应用（网盘/转盘/广播/商店），侧边栏不应有高亮
        foreach (var radio in AllNavRadios())
        {
            radio.IsChecked = false;
        }
        var nav = FindNavRadio(tab.NavName);
        if (nav is not null)
        {
            nav.IsChecked = true;
        }
        _suppressNav = false;

        ContentHost.Content = tab.Content;
    }

    /// <summary>
    /// 返回侧边栏全部导航按钮（用于统一清除选中态）。
    /// </summary>
    private IEnumerable<RadioButton> AllNavRadios()
    {
        yield return NavHome;
        yield return NavSettings;
        yield return NavUsers;
        yield return NavMail;
    }

    /// <summary>
    /// 按导航项名称取得左侧导航按钮。
    /// </summary>
    /// <param name="navName">导航项名称，如 NavHome</param>
    /// <returns>对应的单选按钮，未知名称返回 null</returns>
    private RadioButton? FindNavRadio(string navName) => navName switch
    {
        "NavHome" => NavHome,
        "NavMail" => NavMail,
        "NavUsers" => NavUsers,
        "NavSettings" => NavSettings,
        _ => null,
    };

    /// <summary>
    /// 点击标签卡片：切换到该标签。
    /// </summary>
    private void Tab_Click(object sender, MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { DataContext: BrowserTab tab })
        {
            SelectTab(tab);
        }
    }

    /// <summary>
    /// 点击标签上的关闭按钮：移除该标签，全部关闭时自动补一个首页标签。
    /// </summary>
    private void CloseTab_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not FrameworkElement { DataContext: BrowserTab tab })
        {
            return;
        }

        int index = _tabs.IndexOf(tab);   // 记录关闭前的位置，便于选中相邻标签
        _tabs.Remove(tab);

        if (_tabs.Count == 0)
        {
            NewTab();                     // 至少保留一个首页标签
            return;
        }

        if (ReferenceEquals(tab, _currentTab))
        {
            SelectTab(_tabs[Math.Min(index, _tabs.Count - 1)]);
        }
    }

    /// <summary>
    /// 点击“+”按钮：新建首页标签。
    /// </summary>
    private void NewTab_Click(object sender, RoutedEventArgs e) => NewTab();

    /// <summary>
    /// 导航切换：在当前标签内直接覆盖为对应应用页面（与网页端跳转行为一致）。
    /// </summary>
    private void Nav_Checked(object sender, RoutedEventArgs e)
    {
        if (_suppressNav || sender is not RadioButton rb || _currentTab is null)
        {
            return;
        }

        var tab = _currentTab;
        tab.NavName = rb.Name;                    // 记录当前标签所在应用
        tab.Title = GetTitle(rb.Name);            // 标签标题同步更新
        tab.Content = CreatePage(rb.Name);        // 覆盖为新的应用页面
        ContentHost.Content = tab.Content;
    }

    /// <summary>
    /// 供页面（如首页卡片）主动打开指定应用，直接覆盖当前标签内容。
    /// </summary>
    /// <param name="navName">目标导航项名称</param>
    public void NavigateTo(string navName)
    {
        var target = FindNavRadio(navName);
        if (target is not null)
        {
            target.IsChecked = true;
            return;
        }

        // 子应用（网盘/转盘/广播/商店）不在侧边栏，直接覆盖当前标签页内容
        if (_currentTab is null)
        {
            return;
        }
        var tab = _currentTab;
        tab.NavName = navName;
        tab.Title = GetTitle(navName);
        tab.Content = CreatePage(navName);
        ContentHost.Content = tab.Content;

        _suppressNav = true;                     // 清除侧边栏高亮（子应用无对应导航项）
        foreach (var radio in AllNavRadios())
        {
            radio.IsChecked = false;
        }
        _suppressNav = false;
    }

    /// <summary>
    /// 按导航项名称返回页面标题。
    /// </summary>
    private static string GetTitle(string name) => name switch
    {
        "NavHome" => "首页",
        "NavDrive" => "明星云网盘",
        "NavRoulette" => "明星转盘",
        "NavBroadcast" => "明星广播器",
        "NavLive" => "明星直播",
        "NavShop" => "明星商店",
        "NavMail" => "邮件中心",
        "NavUsers" => "用户管理",
        "NavSettings" => "设置",
        _ => "明星学校",
    };

    /// <summary>
    /// 按导航项名称创建页面实例（各标签各自独立，不做跨标签缓存）。
    /// </summary>
    private static UserControl CreatePage(string name) => name switch
    {
        "NavDrive" => new DrivePage(),
        "NavRoulette" => new RoulettePage(),
        "NavBroadcast" => new BroadcastPage(),
        "NavLive" => new LivePage(),
        "NavShop" => new ShopPage(),
        "NavMail" => new MailPage(),
        "NavUsers" => new UsersPage(),
        "NavSettings" => new SettingsPage(),
        _ => new HomePage(),
    };

    /// <summary>
    /// 点击头像：切换账号菜单的显示状态（与网页端点击头像展开菜单一致）。
    /// 必须在按下阶段拦截，否则事件会冒泡到顶栏触发窗口拖动，导致点击无效。
    /// </summary>
    private void Avatar_Click(object sender, RoutedEventArgs e)
    {
        AvatarMenu.IsOpen = !AvatarMenu.IsOpen;
        e.Handled = true;
    }

    /// <summary>
    /// 账号菜单中的「退出登录」：清除本地会话并回到登录窗口。
    /// </summary>
    private async void MenuLogout_Click(object sender, RoutedEventArgs e)
    {
        AvatarMenu.IsOpen = false;
        await AppServices.LogoutAsync();
        ((App)Application.Current).ReopenLogin();
    }

    /// <summary>
    /// 顶部用户栏回填：姓名、积分、头像，以及管理员专属菜单显隐。
    /// </summary>
    private void ApplyUserInfo()
    {
        var me = AppServices.CurrentUser;
        if (me is null)
        {
            return;
        }

        UserNameText.Text = (me.Name ?? "未登录") + (AppServices.IsAdmin ? "（管理员）" : string.Empty);
        UserPointsText.Text = "积分 " + (me.Points ?? "0");

        // 头像：先显示姓名首字符占位，再异步加载真实头像
        AvatarImage.Visibility = Visibility.Collapsed;
        AvatarInitial.Visibility = Visibility.Visible;
        AvatarInitial.Text = string.IsNullOrWhiteSpace(me.Name) ? "?" : me.Name[..1];

        // 账号菜单同步回填：头像首字符、姓名、ID、积分
        MenuAvatarImage.Visibility = Visibility.Collapsed;
        MenuAvatarInitial.Visibility = Visibility.Visible;
        MenuAvatarInitial.Text = AvatarInitial.Text;
        MenuNameText.Text = me.Name ?? "未登录";
        MenuIdText.Text = "ID：" + (me.UserId ?? AppServices.Settings.Username ?? "-");
        MenuPointsText.Text = me.Points ?? "0";

        if (!string.IsNullOrWhiteSpace(me.Avatar))
        {
            _ = LoadAvatarAsync(me.Avatar);
        }

        // 邮件中心与用户管理仅管理员可见
        NavMail.Visibility = AppServices.IsAdmin ? Visibility.Visible : Visibility.Collapsed;
        NavUsers.Visibility = AppServices.IsAdmin ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>
    /// 异步加载头像图片。
    /// 头像资源位于受登录保护的路径下，直接给 Image 设 URL 会因缺少认证被拒，
    /// 因此通过 ApiClient 携带令牌取回字节后再解码。
    /// </summary>
    /// <param name="avatar">服务端返回的头像地址（站内相对路径或完整 URL）</param>
    private async Task LoadAvatarAsync(string avatar)
    {
        try
        {
            var path = avatar.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                ? new Uri(avatar, UriKind.Absolute).PathAndQuery   // 完整 URL 只取路径部分走统一客户端
                : avatar;
            var bytes = await AppServices.Api.GetBytesAsync(path);
            if (bytes.Length == 0)
            {
                return;
            }

            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = BitmapCacheOption.OnLoad;   // 立即读入，避免流提前释放
            bitmap.StreamSource = new MemoryStream(bytes);
            bitmap.EndInit();
            bitmap.Freeze();

            AvatarImage.Source = bitmap;
            AvatarImage.Visibility = Visibility.Visible;
            AvatarInitial.Visibility = Visibility.Collapsed;

            // 账号菜单里的头像同步使用同一张图
            MenuAvatarImage.Source = bitmap;
            MenuAvatarImage.Visibility = Visibility.Visible;
            MenuAvatarInitial.Visibility = Visibility.Collapsed;
        }
        catch
        {
            // 头像加载失败时保留姓名首字符占位
        }
    }

    /// <summary>
    /// 接收 Toast 请求并在 UI 线程展示。
    /// </summary>
    private void OnToastRequested(ToastMessage message)
    {
        Dispatcher.Invoke(() => AddToast(message));
    }

    /// <summary>
    /// 在右上角新增一条 Toast，3 秒后自动淡出移除。
    /// </summary>
    private void AddToast(ToastMessage message)
    {
        var accent = message.Kind switch
        {
            ToastKind.Success => (Brush)FindResource("SuccessBrush"),
            ToastKind.Warning => (Brush)FindResource("WarningBrush"),
            ToastKind.Error => (Brush)FindResource("DangerBrush"),
            _ => (Brush)FindResource("InfoBrush"),
        };

        var card = new Border
        {
            Background = (Brush)FindResource("ToastBackgroundBrush"),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(14, 10, 14, 10),
            Margin = new Thickness(0, 0, 0, 10),
            Effect = (System.Windows.Media.Effects.Effect)FindResource("CardShadowEffect"),
            MaxWidth = 360,
        };
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var bar = new Border { Width = 3, CornerRadius = new CornerRadius(2), Background = accent, Margin = new Thickness(0, 0, 10, 0) };
        Grid.SetColumn(bar, 0);
        var text = new TextBlock
        {
            Text = message.Text,
            TextWrapping = TextWrapping.Wrap,
            Foreground = (Brush)FindResource("TextPrimaryBrush"),
            FontSize = 13,
        };
        Grid.SetColumn(text, 1);
        grid.Children.Add(bar);
        grid.Children.Add(text);
        card.Child = grid;

        ToastHost.Children.Add(card);
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            ToastHost.Children.Remove(card);
        };
        timer.Start();
    }
}
