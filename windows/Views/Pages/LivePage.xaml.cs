using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using MingxingSchool.Desktop.Services;
using NAudio.Wave;

namespace MingxingSchool.Desktop.Views.Pages;

/// <summary>
/// 明星直播（桌面客户端）：WebView2 只承载「直播画面」（/live/media，页面仅含视频元素），
/// 频道、角色、音源、设备、手机配对、观众链接、连接状态、开播/下播、监听、全屏等界面
/// 全部由原生 WPF 实现；
/// 主播端另通过原生 WASAPI 环回采集系统声音，按 PCM16 分块回传给画面页作为「电脑声音」音轨。
/// </summary>
public partial class LivePage : UserControl
{
    /// <summary>媒体设备下拉项（Id 为空表示系统默认设备）</summary>
    private sealed class DeviceOption
    {
        /// <summary>设备唯一标识（deviceId）</summary>
        public string Id { get; init; } = "";

        /// <summary>下拉框显示文案</summary>
        public string Label { get; init; } = "";

        /// <summary>设备类型：videoinput / audioinput，空表示系统默认项</summary>
        public string Kind { get; init; } = "";

        /// <summary>ComboBox 默认显示 Label</summary>
        public override string ToString() => Label;
    }

    /// <summary>WebView2 是否已完成初始化（避免重复创建内核）</summary>
    private bool _webReady;

    /// <summary>是否已成功导航到画面页（此时才允许显示 WebView2）</summary>
    private bool _webNavigated;

    /// <summary>当前选中的频道标识（ch1~ch4）</summary>
    private string _selectedChannel = "ch1";

    /// <summary>是否处于观看端模式（管理员可切换；普通用户恒为 true）</summary>
    private bool _isViewerMode = true;

    /// <summary>系统声音环回采集器（null 表示未采集）</summary>
    private WasapiLoopbackCapture? _capture;

    /// <summary>原生采集格式是否为 32 位浮点（否则按 16 位 PCM 直传）</summary>
    private bool _captureFloat32;

    /// <summary>画面页回报的信令状态：connecting / online / offline</summary>
    private string _signalState = "connecting";

    /// <summary>主播是否在线（观看端用于区分「等待开播」与「主播在线」）</summary>
    private bool _hostOnline;

    /// <summary>当前观看人数（主播端由画面页回报）</summary>
    private int _viewerCount;

    /// <summary>画面页回报的错误文案（为空表示无错误）</summary>
    private string _errorMessage = "";

    /// <summary>主播端当前音源：local 本机麦克风 / app 手机麦克风 / computer 电脑声音</summary>
    private string _audioSource = "local";

    /// <summary>手机配对令牌（主播加入频道后由服务端下发）</summary>
    private string _token = "";

    /// <summary>主播端是否已开播（已加入频道并推流）</summary>
    private bool _started;

    /// <summary>手机端是否已配对</summary>
    private bool _appConnected;

    /// <summary>主播与手机的 P2P 是否已连通</summary>
    private bool _peerConnected;

    /// <summary>摄像头是否开启</summary>
    private bool _cameraEnabled = true;

    /// <summary>扬声器监听是否开启</summary>
    private bool _monitorOn;

    /// <summary>本地预览是否左右镜像</summary>
    private bool _mirror;

    /// <summary>画面填充方式：contain 完整显示 / cover 铺满裁切</summary>
    private string _fit = "contain";

    /// <summary>当前使用的摄像头设备 id（空表示系统默认）</summary>
    private string _cameraId = "";

    /// <summary>当前使用的麦克风设备 id（空表示系统默认）</summary>
    private string _micId = "";

    /// <summary>画面页当前是否已有可显示的视频（用于控制 WebView2 与占位层显隐）</summary>
    private bool _hasVideo;

    /// <summary>上一次收到的设备集合签名，用于避免每次状态回报都重建下拉框</summary>
    private string _deviceSignature = "";

    /// <summary>上一次已下载二维码对应的令牌（避免重复请求二维码）</summary>
    private string _qrToken = "";

    /// <summary>二维码是否正在下载（防止并发重复请求）</summary>
    private bool _qrDownloading;

    /// <summary>是否正在程序化修改下拉框/开关，避免回灌事件再次下发指令</summary>
    private bool _suppressControlEvents;

    /// <summary>是否处于沉浸全屏模式（隐藏页面标题与窗口侧栏/顶栏/标签栏）</summary>
    private bool _immersive;

    /// <summary>构造函数：绑定加载/卸载事件并回显当前角色。</summary>
    public LivePage()
    {
        InitializeComponent();
        Loaded += LivePage_Loaded;
        Unloaded += LivePage_Unloaded;
        PreviewKeyDown += OnPreviewKeyDown;

        // 所有用户默认进入观看端；角色切换胶囊仅管理员可见，管理员可通过它切换到主播端
        RoleSwitch.Visibility = AppServices.IsAdmin ? Visibility.Visible : Visibility.Collapsed;
        RenderStatus();
        RenderHostPanel();
        UpdateVideoLayer();
    }

    // ==================== 页面生命周期 ====================

    /// <summary>
    /// 页面首次加载：创建 WebView2 环境并导航到直播画面页。
    /// </summary>
    private async void LivePage_Loaded(object sender, RoutedEventArgs e)
    {
        if (_webReady)
        {
            return;
        }
        try
        {
            await InitializeWebViewAsync();
        }
        catch (Exception ex)
        {
            // WebView2 运行时缺失或初始化失败时给出可读提示
            LoadingHint.Text = "直播页面加载失败：" + ex.Message;
            LoadingMask.Visibility = Visibility.Visible;
        }
    }

    /// <summary>
    /// 页面卸载：停止原生采集并退出全屏（保留 WebView2，切回标签页时可继续使用）。
    /// </summary>
    private void LivePage_Unloaded(object sender, RoutedEventArgs e)
    {
        StopSystemAudio();
        if (_immersive)
        {
            SetImmersive(false);
        }
    }

    /// <summary>
    /// 创建 WebView2 环境：允许局域网 HTTP 地址使用摄像头/麦克风，并放宽自动播放限制。
    /// </summary>
    private async Task InitializeWebViewAsync()
    {
        var origin = AppServices.BaseUrl.TrimEnd('/');   // 形如 http://192.168.0.138(:端口)
        // 附加参数：把本站局域网 HTTP 地址视为安全来源，否则 WebView2 会禁用 getUserMedia
        var browserArgs = $"--unsafely-treat-insecure-origin-as-secure={origin} --autoplay-policy=no-user-gesture-required";
        var envOptions = new CoreWebView2EnvironmentOptions(additionalBrowserArguments: browserArgs);

        // 用户数据目录独立，避免与用户日常浏览器配置混用
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MingxingSchool", "WebView2");
        Directory.CreateDirectory(userDataFolder);

        var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, envOptions);
        await Web.EnsureCoreWebView2Async(environment);

        var core = Web.CoreWebView2;
        // 画面区域铺黑底，避免导航或首帧前出现白色闪屏
        Web.DefaultBackgroundColor = System.Drawing.Color.Black;
        // 精简浏览器界面能力，保持客户端观感
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;

        core.PermissionRequested += OnPermissionRequested;   // 自动放行摄像头/麦克风
        core.WebMessageReceived += OnWebMessageReceived;      // 接收画面状态与系统声音消息
        core.NavigationCompleted += OnNavigationCompleted;    // 关闭加载遮罩
        core.NewWindowRequested += OnNewWindowRequested;     // 拦截弹窗

        await InjectTokenCookieAsync(core);                   // 注入会话令牌，免二次登录
        _webReady = true;
        NavigateToMedia();
    }

    /// <summary>
    /// 把桌面端保存的会话令牌写入 WebView2 Cookie（名称为 token，与网页端一致）。
    /// </summary>
    /// <param name="core">WebView2 内核对象</param>
    private static Task InjectTokenCookieAsync(CoreWebView2 core)
    {
        var token = AppServices.Settings.Token;      // 本地保存的会话令牌
        if (string.IsNullOrWhiteSpace(token))
        {
            return Task.CompletedTask;
        }
        var serverUri = new Uri(AppServices.BaseUrl); // 服务器地址（用于确定 Cookie 域）
        var cookie = core.CookieManager.CreateCookie("token", token, serverUri.Host, "/");
        cookie.IsHttpOnly = false;
        cookie.IsSecure = serverUri.Scheme == "https";
        cookie.SameSite = CoreWebView2CookieSameSiteKind.Lax;
        core.CookieManager.AddOrUpdateCookie(cookie);
        return Task.CompletedTask;
    }

    /// <summary>
    /// 导航到嵌入式画面页（重置本地画面相关状态并显示加载遮罩）。
    /// </summary>
    private void NavigateToMedia()
    {
        _webNavigated = false;
        _hasVideo = false;
        _mirror = false;
        _fit = "contain";
        _signalState = "connecting";
        _hostOnline = false;
        _viewerCount = 0;
        _errorMessage = "";
        _token = "";
        _started = false;
        _appConnected = false;
        _peerConnected = false;
        _deviceSignature = "";
        _qrToken = "";
        QrImage.Source = null;

        LoadingMask.Visibility = Visibility.Visible;
        Web.Visibility = Visibility.Collapsed;
        Placeholder.Visibility = Visibility.Collapsed;
        RenderStatus();
        RenderHostPanel();
        Web.CoreWebView2.Navigate(BuildMediaUrl());
    }

    /// <summary>
    /// 生成嵌入式画面页地址：/live/media?mode=host|view&amp;ch=chN
    /// 该页面只包含一个视频元素，其余界面全部由原生外壳提供。
    /// </summary>
    /// <returns>完整画面页 URL</returns>
    private string BuildMediaUrl()
    {
        var baseUrl = AppServices.BaseUrl.TrimEnd('/');   // 服务器根地址
        var mode = _isViewerMode ? "view" : "host";       // 页面模式：观看端只收流，主播端采集推流
        return $"{baseUrl}/live/media?mode={mode}&ch={_selectedChannel}";
    }

    // ==================== WebView2 事件 ====================

    /// <summary>
    /// 权限请求：自动允许摄像头与麦克风，其余保持默认。
    /// </summary>
    private void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        if (e.PermissionKind is CoreWebView2PermissionKind.Camera or CoreWebView2PermissionKind.Microphone)
        {
            e.State = CoreWebView2PermissionState.Allow;
            e.Handled = true;
        }
    }

    /// <summary>
    /// 页面导航完成：成功时显示画面层，失败时展示原因。
    /// </summary>
    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        LoadingMask.Visibility = Visibility.Collapsed;
        if (!e.IsSuccess)
        {
            _webNavigated = false;
            LoadingMask.Visibility = Visibility.Visible;
            LoadingHint.Text = "直播画面加载失败，请检查服务器是否可访问：" + e.WebErrorStatus;
            return;
        }
        _webNavigated = true;
        UpdateVideoLayer();
    }

    /// <summary>
    /// 拦截新建窗口请求（直播页中的链接统一在当前页面内处理）。
    /// </summary>
    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
    }

    /// <summary>
    /// 接收画面页回传的消息：连接状态、系统声音采集请求、按键通知。
    /// </summary>
    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var root = document.RootElement;
            var type = root.TryGetProperty("type", out var node) ? node.GetString() : null;
            switch (type)
            {
                case "live:system-audio-start":
                    StartSystemAudio();
                    break;
                case "live:system-audio-stop":
                    StopSystemAudio();
                    break;
                case "media:status":
                    ApplyMediaStatus(root);
                    break;
                case "media:key":
                    // 画面区域内按 ESC：交给原生外壳退出全屏
                    if (ReadString(root, "key", "") == "Escape" && _immersive)
                    {
                        SetImmersive(false);
                    }
                    break;
            }
        }
        catch
        {
            // 非 JSON 消息直接忽略，避免影响页面其他通信
        }
    }

    /// <summary>
    /// 应用画面页回报的状态：同步全部原生控件（状态、设备、配对、按钮文案等）。
    /// </summary>
    /// <param name="root">状态消息 JSON 根节点</param>
    private void ApplyMediaStatus(JsonElement root)
    {
        _signalState = ReadString(root, "signal", _signalState);
        _hostOnline = ReadBool(root, "hostOnline");
        _viewerCount = ReadInt(root, "viewers");
        _audioSource = ReadString(root, "source", _audioSource);
        _errorMessage = ReadString(root, "error", "");
        _token = ReadString(root, "token", "");
        _started = ReadBool(root, "started");
        _appConnected = ReadBool(root, "appConnected");
        _peerConnected = ReadBool(root, "peerConnected");
        _cameraEnabled = ReadBool(root, "cameraEnabled");
        _monitorOn = ReadBool(root, "monitorOn");
        _mirror = ReadBool(root, "mirror");
        _fit = ReadString(root, "fit", _fit);
        _cameraId = ReadString(root, "cameraId", "");
        _micId = ReadString(root, "micId", "");
        _hasVideo = ReadBool(root, "hasVideo");

        if (root.TryGetProperty("devices", out var devicesNode) && devicesNode.ValueKind == JsonValueKind.Array)
        {
            ApplyDevices(devicesNode);
        }

        RenderStatus();
        RenderHostPanel();
        UpdateVideoLayer();
        _ = RefreshQrAsync();
    }

    /// <summary>
    /// 解析画面页回报的设备数组并填充下拉框（设备未变化时跳过重建）。
    /// </summary>
    /// <param name="devicesNode">设备数组 JSON 节点</param>
    private void ApplyDevices(JsonElement devicesNode)
    {
        var options = new List<DeviceOption>
        {
            // 系统默认项永远排在最前，Id 为空表示不指定设备
            new() { Id = "", Label = "系统默认" },
        };
        var signature = new StringBuilder();   // 设备集合签名，用于判断是否需要重建
        foreach (var item in devicesNode.EnumerateArray())
        {
            var kind = ReadString(item, "kind", "");       // videoinput / audioinput
            var id = ReadString(item, "id", "");           // 设备唯一标识
            var label = ReadString(item, "label", "");     // 设备名称
            if (string.IsNullOrEmpty(id) || (kind != "videoinput" && kind != "audioinput"))
            {
                continue;
            }
            options.Add(new DeviceOption
            {
                Id = id,
                Kind = kind,
                Label = (kind == "videoinput" ? "摄像头 · " : "麦克风 · ") + (label.Length > 0 ? label : id),
            });
            signature.Append(kind).Append('|').Append(id).Append(';');
        }

        var signatureText = signature.ToString();
        if (signatureText == _deviceSignature)
        {
            // 设备未变化：只同步选中项，避免打断用户正在操作的列表
            SyncComboSelection(CameraCombo, _cameraId);
            SyncComboSelection(MicCombo, _micId);
            return;
        }
        _deviceSignature = signatureText;

        RebuildCombo(CameraCombo, options.Where(d => d.Kind is "" or "videoinput").ToList(), _cameraId);
        RebuildCombo(MicCombo, options.Where(d => d.Kind is "" or "audioinput").ToList(), _micId);
    }

    /// <summary>
    /// 重建下拉框选项并选中指定设备。
    /// </summary>
    /// <param name="combo">目标下拉框</param>
    /// <param name="options">候选项（首项为系统默认）</param>
    /// <param name="currentId">当前设备 id</param>
    private void RebuildCombo(ComboBox combo, List<DeviceOption> options, string currentId)
    {
        _suppressControlEvents = true;
        try
        {
            combo.ItemsSource = options;
            combo.SelectedItem = options.FirstOrDefault(o => o.Id == currentId) ?? options[0];
        }
        finally
        {
            _suppressControlEvents = false;
        }
    }

    /// <summary>
    /// 同步下拉框选中项（不触发切换事件）。
    /// </summary>
    /// <param name="combo">目标下拉框</param>
    /// <param name="id">目标设备 id</param>
    private void SyncComboSelection(ComboBox combo, string id)
    {
        if (combo.SelectedItem is DeviceOption current && current.Id == id)
        {
            return;
        }
        var match = combo.Items.OfType<DeviceOption>().FirstOrDefault(o => o.Id == id);
        if (match is null)
        {
            return;
        }
        _suppressControlEvents = true;
        try
        {
            combo.SelectedItem = match;
        }
        finally
        {
            _suppressControlEvents = false;
        }
    }

    // ==================== JSON 读取工具 ====================

    /// <summary>
    /// 读取 JSON 中的字符串字段（缺失时返回默认值）
    /// </summary>
    /// <param name="root">JSON 节点</param>
    /// <param name="name">字段名</param>
    /// <param name="fallback">默认值</param>
    /// <returns>字段值</returns>
    private static string ReadString(JsonElement root, string name, string fallback)
    {
        return root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.String
            ? node.GetString() ?? fallback
            : fallback;
    }

    /// <summary>
    /// 读取 JSON 中的布尔字段（缺失时返回 false）
    /// </summary>
    /// <param name="root">JSON 节点</param>
    /// <param name="name">字段名</param>
    /// <returns>字段值</returns>
    private static bool ReadBool(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.True;
    }

    /// <summary>
    /// 读取 JSON 中的整数字段（缺失时返回 0）
    /// </summary>
    /// <param name="root">JSON 节点</param>
    /// <param name="name">字段名</param>
    /// <returns>字段值</returns>
    private static int ReadInt(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var node) && node.ValueKind == JsonValueKind.Number
            && node.TryGetInt32(out var value) ? value : 0;
    }

    // ==================== 原生界面渲染 ====================

    /// <summary>
    /// 刷新顶部标题与右侧连接状态文案。
    /// </summary>
    private void RenderStatus()
    {
        var channelNumber = ChannelNumber();   // 当前频道编号 1~4
        var roleText = _isViewerMode ? "观看端" : "主播端";

        string stateText;
        if (_isViewerMode)
        {
            stateText = _signalState switch
            {
                "online" when _hostOnline => "主播在线",
                "online" => "等待主播开播",
                "offline" => "连接已断开",
                _ => "正在连接…"
            };
        }
        else
        {
            stateText = _signalState switch
            {
                "online" when _started => $"正在直播 · {_viewerCount} 人观看",
                "online" => "已连接 · 等待加入频道",
                "offline" => "已下播 / 连接已断开",
                _ => "正在连接…"
            };
        }

        // 有错误时优先展示错误原因，方便用户直接看到失败信息
        RoleText.Text = $"频道 {channelNumber} · {roleText} · " +
                        (string.IsNullOrWhiteSpace(_errorMessage) ? stateText : _errorMessage);
        RoleText.ToolTip = RoleText.Text;

        // 连接状态卡片（主播端面板）
        StateChannelText.Text = $"频道 {channelNumber}";
        StateSignalText.Text = _signalState switch
        {
            "online" => "已连接",
            "offline" => "已断开",
            _ => "连接中"
        };
        StateAppText.Text = _appConnected ? "已配对" : "未连接";
        StatePeerText.Text = _peerConnected ? "已建立" : "未建立";
        StateSourceText.Text = SourceLabel(_audioSource);
        StateViewersText.Text = $"{_viewerCount} 人";
        ViewerCountBadge.Text = $"{_viewerCount} 人";
    }

    /// <summary>
    /// 刷新主播端控制面板：面板显隐、按钮文案、配对信息与观看链接。
    /// </summary>
    private void RenderHostPanel()
    {
        var isHost = !_isViewerMode;
        HostPanel.Visibility = isHost ? Visibility.Visible : Visibility.Collapsed;
        HostPanelColumn.Width = new GridLength(isHost ? 340 : 0);
        // 镜像与铺满只影响主播端的本地预览画面
        MirrorButton.Visibility = isHost ? Visibility.Visible : Visibility.Collapsed;
        FitButton.Visibility = isHost ? Visibility.Visible : Visibility.Collapsed;
        MirrorButton.Content = _mirror ? "取消镜像" : "镜像";
        FitButton.Content = _fit == "cover" ? "完整显示" : "铺满";

        // 开播 / 下播按钮：未开播用绿色「开播」，直播中用红色「下播」
        LiveButton.Content = _started ? "下播" : "开播";
        LiveButton.Style = (Style)FindResource(_started ? "DangerButton" : "GreenButton");

        // 扬声器监听
        MonitorButton.Content = _monitorOn ? "关闭扬声器监听" : "开启扬声器监听";
        MonitorStateText.Text = _monitorOn ? "监听已开启" : "监听未开启";

        // 音源单选（程序化同步，避免回灌再次下发指令）
        SyncSourceRadio();

        // 摄像头开关
        if (CameraEnabledCheck.IsChecked != _cameraEnabled)
        {
            _suppressControlEvents = true;
            try
            {
                CameraEnabledCheck.IsChecked = _cameraEnabled;
            }
            finally
            {
                _suppressControlEvents = false;
            }
        }

        // 手机配对
        PairStateText.Text = _appConnected
            ? (_peerConnected ? "手机已连接，音频传输中" : "手机已配对，正在建立连接…")
            : (string.IsNullOrEmpty(_token) ? "等待开播后生成配对二维码" : "等待扫码配对");
        TokenText.Text = string.IsNullOrEmpty(_token) ? "配对令牌：—" : $"配对令牌：{_token}";
        RefreshTokenButton.IsEnabled = !string.IsNullOrEmpty(_token);
        CopyPairButton.IsEnabled = !string.IsNullOrEmpty(_token);
        KickAppButton.Visibility = _appConnected ? Visibility.Visible : Visibility.Collapsed;

        // 观众观看链接
        ViewerLinkText.Text = "观看链接：" + BuildViewerUrl();
        CopyViewerButton.IsEnabled = true;
    }

    /// <summary>
    /// 按当前音源同步三个音源单选项的选中态。
    /// </summary>
    private void SyncSourceRadio()
    {
        var target = _audioSource switch
        {
            "app" => SourceApp,
            "computer" => SourceComputer,
            _ => SourceMic,
        };
        if (target.IsChecked == true)
        {
            return;
        }
        _suppressControlEvents = true;
        try
        {
            target.IsChecked = true;
        }
        finally
        {
            _suppressControlEvents = false;
        }
    }

    /// <summary>
    /// 更新画面层显隐：有视频时显示 WebView2，否则显示原生占位提示。
    /// </summary>
    private void UpdateVideoLayer()
    {
        if (!_webNavigated)
        {
            return;
        }

        var showVideo = _hasVideo;
        Web.Visibility = showVideo ? Visibility.Visible : Visibility.Collapsed;
        Placeholder.Visibility = showVideo ? Visibility.Collapsed : Visibility.Visible;
        if (showVideo)
        {
            return;
        }

        if (_isViewerMode)
        {
            switch (_signalState)
            {
                case "offline":
                    PlaceholderTitle.Text = "连接已断开";
                    PlaceholderText.Text = "正在自动重连信令服务器…";
                    break;
                case "online" when _hostOnline:
                    PlaceholderTitle.Text = "正在接收画面…";
                    PlaceholderText.Text = "主播已开播，画面即将出现";
                    break;
                case "online":
                    PlaceholderTitle.Text = "等待主播开播";
                    PlaceholderText.Text = "主播开播后画面会自动出现，保持页面即可";
                    break;
                default:
                    PlaceholderTitle.Text = "正在连接频道…";
                    PlaceholderText.Text = "正在建立信令连接";
                    break;
            }
            return;
        }

        // 主播端：没有画面通常是因为摄像头关闭或尚未启动
        if (!_cameraEnabled)
        {
            PlaceholderTitle.Text = "摄像头已关闭";
            PlaceholderText.Text = "当前仅推送音频，可在右侧设备面板重新开启摄像头";
        }
        else
        {
            PlaceholderTitle.Text = "正在启动摄像头…";
            PlaceholderText.Text = "若长时间无画面，可在右侧面板刷新设备或更换摄像头";
        }
    }

    /// <summary>
    /// 当前频道对应的编号（ch1 -> 1）。
    /// </summary>
    /// <returns>频道编号 1~4</returns>
    private int ChannelNumber()
    {
        var index = _selectedChannel.LastIndexOf('h');       // chN 中字母 h 的位置
        return int.TryParse(_selectedChannel[(index + 1)..], out var number) ? number : 1;
    }

    /// <summary>
    /// 音源标识转中文文案。
    /// </summary>
    /// <param name="source">local / app / computer</param>
    /// <returns>中文名称</returns>
    private static string SourceLabel(string source) => source switch
    {
        "app" => "手机麦克风",
        "computer" => "电脑音频",
        _ => "本机麦克风",
    };

    // ==================== 链接与二维码 ====================

    /// <summary>
    /// 生成手机配对链接：/live/?role=app&amp;ch=chN&amp;token=...
    /// </summary>
    /// <param name="token">配对令牌</param>
    /// <returns>手机端可访问的完整链接</returns>
    private string BuildPairUrl(string token)
    {
        var baseUrl = AppServices.BaseUrl.TrimEnd('/');
        return $"{baseUrl}/live/?role=app&ch={_selectedChannel}&token={Uri.EscapeDataString(token)}";
    }

    /// <summary>
    /// 生成观众观看链接：/live/channel/N
    /// </summary>
    /// <returns>观看页完整链接</returns>
    private string BuildViewerUrl()
    {
        var baseUrl = AppServices.BaseUrl.TrimEnd('/');
        return $"{baseUrl}/live/channel/{ChannelNumber()}";
    }

    /// <summary>
    /// 按当前配对令牌下载二维码图片并显示（令牌未变化时跳过）。
    /// </summary>
    private async Task RefreshQrAsync()
    {
        if (string.IsNullOrEmpty(_token))
        {
            if (_qrToken.Length > 0)
            {
                _qrToken = "";
                QrImage.Source = null;
            }
            return;
        }
        if (_token == _qrToken || _qrDownloading)
        {
            return;
        }

        _qrDownloading = true;
        var requestedToken = _token;   // 记录本次请求的令牌，用于判断回填时是否已过期
        try
        {
            var url = BuildPairUrl(requestedToken);
            var bytes = await AppServices.Api.GetBytesAsync(
                "/live/api/qrcode?text=" + Uri.EscapeDataString(url));
            using var stream = new MemoryStream(bytes);
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.StreamSource = stream;
            image.EndInit();
            image.Freeze();

            // 下载期间令牌可能已变更，只回填最新令牌对应的二维码
            if (requestedToken == _token)
            {
                QrImage.Source = image;
                _qrToken = requestedToken;
            }
        }
        catch
        {
            // 二维码生成失败不阻断直播，面板上仍有配对链接可复制
        }
        finally
        {
            _qrDownloading = false;
        }
    }

    // ==================== 控件事件 ====================

    /// <summary>
    /// 角色切换：在主播端（开播推流）与观看端（观看直播）之间切换，
    /// 切换时释放原生系统声音并重新导航到对应画面页（保留当前频道）。
    /// </summary>
    private void Role_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string role })
        {
            return;
        }
        // XAML 中 IsChecked="True" 会在网页初始化前触发一次，此时只记录初始角色，不触发导航
        var viewer = role == "viewer";
        if (!_webReady)
        {
            _isViewerMode = viewer;
            return;
        }
        if (viewer == _isViewerMode)
        {
            RenderHostPanel();
            return;
        }
        _isViewerMode = viewer;
        StopSystemAudio();                                 // 主播端切走后先释放 WASAPI 采集
        RenderStatus();
        RenderHostPanel();
        NavigateToMedia();
    }

    /// <summary>
    /// 频道切换：调用画面页接口切换频道（不刷新页面，保留设备与连接状态）。
    /// </summary>
    private void Channel_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string channel })
        {
            return;
        }
        // XAML 中 IsChecked="True" 会在网页初始化前触发一次，此时只保留默认频道
        if (!_webReady)
        {
            _selectedChannel = channel;
            return;
        }
        if (channel == _selectedChannel)
        {
            return;
        }
        _selectedChannel = channel;
        QrImage.Source = null;          // 频道切换后令牌失效，先清空二维码
        _qrToken = "";
        RenderStatus();
        RenderHostPanel();
        ExecuteJs($"window.MXMedia && window.MXMedia.setChannel('{channel}')");
    }

    /// <summary>
    /// 音源切换：本机麦克风 / 手机麦克风 / 电脑音频（仅主播端）。
    /// 电脑音频由画面页请求原生 WASAPI 环回采集，原生端分块回传 PCM。
    /// </summary>
    private void Source_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string source })
        {
            return;
        }
        var target = source switch
        {
            "app" => "app",
            "computer" => "computer",
            _ => "local",
        };
        if (_suppressControlEvents || !_webReady || _isViewerMode)
        {
            return;
        }
        if (target == _audioSource)
        {
            return;
        }
        _audioSource = target;
        ExecuteJs($"window.MXMedia && window.MXMedia.setSource('{target}')");
    }

    /// <summary>
    /// 开播 / 下播：未开播时加入频道开始推流，直播中则断开频道与观众。
    /// </summary>
    private void Live_Click(object sender, RoutedEventArgs e)
    {
        ExecuteJs(_started
            ? "window.MXMedia && window.MXMedia.stopLive()"
            : "window.MXMedia && window.MXMedia.startLive()");
    }

    /// <summary>
    /// 扬声器监听开关：在本机扬声器播放当前音源。
    /// </summary>
    private void Monitor_Click(object sender, RoutedEventArgs e)
    {
        ExecuteJs($"window.MXMedia && window.MXMedia.setMonitor({(_monitorOn ? "false" : "true")})");
    }

    /// <summary>
    /// 刷新设备：请求权限并重新枚举摄像头与麦克风，然后重启采集。
    /// </summary>
    private void RefreshDevices_Click(object sender, RoutedEventArgs e)
    {
        ExecuteJs("window.MXMedia && window.MXMedia.refreshDevices()");
        ToastService.Show("正在刷新摄像头与麦克风列表…");
    }

    /// <summary>
    /// 切换摄像头后立刻重启采集（画面页内部处理）。
    /// </summary>
    private void CameraCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressControlEvents || !_webReady || _isViewerMode)
        {
            return;
        }
        if (CameraCombo.SelectedItem is not DeviceOption option || option.Id == _cameraId)
        {
            return;
        }
        _cameraId = option.Id;
        ExecuteJs($"window.MXMedia && window.MXMedia.setCameraDevice('{EscapeJs(option.Id)}')");
    }

    /// <summary>
    /// 切换麦克风后立刻重启采集（画面页内部处理）。
    /// </summary>
    private void MicCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressControlEvents || !_webReady || _isViewerMode)
        {
            return;
        }
        if (MicCombo.SelectedItem is not DeviceOption option || option.Id == _micId)
        {
            return;
        }
        _micId = option.Id;
        ExecuteJs($"window.MXMedia && window.MXMedia.setMicDevice('{EscapeJs(option.Id)}')");
    }

    /// <summary>
    /// 摄像头开关：关闭后只推送音频。
    /// </summary>
    private void CameraEnabled_Changed(object sender, RoutedEventArgs e)
    {
        if (_suppressControlEvents || !_webReady)
        {
            return;
        }
        var enabled = CameraEnabledCheck.IsChecked == true;   // 目标开关状态
        if (enabled == _cameraEnabled)
        {
            return;
        }
        _cameraEnabled = enabled;
        ExecuteJs($"window.MXMedia && window.MXMedia.setCameraEnabled({(enabled ? "true" : "false")})");
    }

    /// <summary>
    /// 重新生成配对令牌（旧令牌与已配对的手机端立即失效）。
    /// </summary>
    private void RefreshToken_Click(object sender, RoutedEventArgs e)
    {
        ExecuteJs("window.MXMedia && window.MXMedia.refreshToken()");
    }

    /// <summary>
    /// 复制手机配对链接到剪贴板。
    /// </summary>
    private void CopyPair_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_token))
        {
            ToastService.Show("配对令牌尚未生成，请先开播", ToastKind.Warning);
            return;
        }
        CopyText(BuildPairUrl(_token), "配对链接已复制");
    }

    /// <summary>
    /// 断开已配对的手机端。
    /// </summary>
    private void KickApp_Click(object sender, RoutedEventArgs e)
    {
        ExecuteJs("window.MXMedia && window.MXMedia.kickApp()");
    }

    /// <summary>
    /// 复制观众观看链接到剪贴板。
    /// </summary>
    private void CopyViewer_Click(object sender, RoutedEventArgs e)
    {
        CopyText(BuildViewerUrl(), "观看链接已复制");
    }

    /// <summary>
    /// 镜像按钮：切换本地预览画面左右镜像。
    /// </summary>
    private void Mirror_Click(object sender, RoutedEventArgs e)
    {
        ExecuteJs($"window.MXMedia && window.MXMedia.setMirror({(_mirror ? "false" : "true")})");
    }

    /// <summary>
    /// 铺满按钮：在「完整显示」与「铺满裁切」之间切换画面填充方式。
    /// </summary>
    private void Fit_Click(object sender, RoutedEventArgs e)
    {
        var target = _fit == "cover" ? "contain" : "cover";   // 目标填充方式
        ExecuteJs($"window.MXMedia && window.MXMedia.setFit('{target}')");
    }

    /// <summary>
    /// 刷新按钮：重新加载当前画面页并重置状态。
    /// </summary>
    private void Refresh_Click(object sender, RoutedEventArgs e)
    {
        if (!_webReady)
        {
            return;
        }
        StopSystemAudio();
        NavigateToMedia();
    }

    /// <summary>
    /// 全屏按钮：进入 / 退出沉浸全屏（隐藏页面标题与窗口侧栏、顶栏、标签栏）。
    /// </summary>
    private void Fullscreen_Click(object sender, RoutedEventArgs e)
    {
        SetImmersive(!_immersive);
    }

    /// <summary>
    /// 键盘处理：全屏状态下按 ESC 退出全屏。
    /// </summary>
    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape && _immersive)
        {
            SetImmersive(false);
            e.Handled = true;
        }
    }

    // ==================== 通用辅助 ====================

    /// <summary>
    /// 切换沉浸全屏：同步页面标题与主窗口外壳（侧栏/顶栏/标签栏）。
    /// </summary>
    /// <param name="enabled">true 进入全屏，false 退出全屏</param>
    private void SetImmersive(bool enabled)
    {
        if (_immersive == enabled)
        {
            return;
        }
        _immersive = enabled;
        HeaderBar.Visibility = enabled ? Visibility.Collapsed : Visibility.Visible;
        RootGrid.Margin = enabled ? new Thickness(0) : new Thickness(24, 16, 24, 24);
        FullscreenButton.Content = enabled ? "退出全屏" : "全屏";
        if (Window.GetWindow(this) is MainWindow window)
        {
            window.SetImmersive(enabled);
        }
    }

    /// <summary>
    /// 在画面页执行一段脚本（页面未就绪时静默忽略）。
    /// </summary>
    /// <param name="expression">要执行的 JS 表达式</param>
    private void ExecuteJs(string expression)
    {
        if (!_webReady)
        {
            return;
        }
        try
        {
            _ = Web.CoreWebView2.ExecuteScriptAsync(expression);
        }
        catch
        {
            // 页面已销毁时忽略
        }
    }

    /// <summary>
    /// 把设备 id 转义为可安全嵌入单引号字符串的形式。
    /// </summary>
    /// <param name="value">原始字符串</param>
    /// <returns>转义后的字符串</returns>
    private static string EscapeJs(string value)
        => value.Replace("\\", "\\\\").Replace("'", "\\'");

    /// <summary>
    /// 复制文本到剪贴板并给出中文提示。
    /// </summary>
    /// <param name="text">要复制的文本</param>
    /// <param name="successMessage">复制成功提示</param>
    private static void CopyText(string text, string successMessage)
    {
        try
        {
            Clipboard.SetText(text);
            ToastService.Show(successMessage, ToastKind.Success);
        }
        catch (Exception ex)
        {
            ToastService.Show("复制失败：" + ex.Message, ToastKind.Error);
        }
    }

    // ==================== 原生系统声音采集（WASAPI 环回） ====================

    /// <summary>
    /// 开始采集系统声音（WASAPI 环回：直接录制扬声器输出）。
    /// </summary>
    private void StartSystemAudio()
    {
        try
        {
            StopSystemAudio();                            // 先清理上一次采集，避免设备占用
            var capture = new WasapiLoopbackCapture();    // 默认播放设备的环回采集
            var format = capture.WaveFormat;              // 设备混音格式，通常 32 位浮点 48kHz 立体声

            // 仅支持 32 位浮点与 16 位 PCM，其余格式提示失败由页面回退
            _captureFloat32 = format.Encoding == WaveFormatEncoding.IeeeFloat && format.BitsPerSample == 32;
            var isPcm16 = format.Encoding == WaveFormatEncoding.Pcm && format.BitsPerSample == 16;
            if (!_captureFloat32 && !isPcm16)
            {
                throw new NotSupportedException($"不支持的系统音频格式：{format.Encoding} {format.BitsPerSample} 位");
            }

            capture.DataAvailable += OnAudioDataAvailable;
            capture.RecordingStopped += OnAudioRecordingStopped;
            _capture = capture;
            capture.StartRecording();

            PostToPage(new
            {
                type = "live:system-audio-started",
                sampleRate = format.SampleRate,
                channels = format.Channels,
            });
        }
        catch (Exception ex)
        {
            StopSystemAudio();
            PostToPage(new { type = "live:system-audio-failed", message = ex.Message });
        }
    }

    /// <summary>
    /// 停止系统声音采集（正常停止不通知页面，避免误触发“采集已结束”提示）。
    /// </summary>
    private void StopSystemAudio()
    {
        var capture = _capture;
        if (capture is null)
        {
            return;
        }
        _capture = null;
        try
        {
            capture.DataAvailable -= OnAudioDataAvailable;
            capture.RecordingStopped -= OnAudioRecordingStopped;
            capture.StopRecording();
        }
        catch
        {
            // 设备已被移除时停止可能失败，忽略即可
        }
        try
        {
            capture.Dispose();
        }
        catch
        {
            // 释放失败不影响后续重新采集
        }
    }

    /// <summary>
    /// 采集数据回调：把原始采样转成 PCM16，并分块回传给页面。
    /// </summary>
    private void OnAudioDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (e.BytesRecorded <= 0)
        {
            return;
        }
        var format = _capture?.WaveFormat;
        if (format is null)
        {
            return;
        }

        byte[] pcm16;   // 转换后的 16 位 PCM 字节
        if (_captureFloat32)
        {
            var sampleCount = e.BytesRecorded / 4;              // 浮点采样点数量
            var floats = new float[sampleCount];                // 原始浮点采样
            Buffer.BlockCopy(e.Buffer, 0, floats, 0, Math.Min(e.BytesRecorded, sampleCount * 4));
            pcm16 = new byte[sampleCount * 2];
            for (var i = 0; i < sampleCount; i++)
            {
                var value = floats[i];                          // 当前采样值
                if (value > 1f) value = 1f;
                else if (value < -1f) value = -1f;
                var sample = (short)Math.Round(value * 32767f); // 转 16 位整数
                pcm16[i * 2] = (byte)(sample & 0xFF);
                pcm16[i * 2 + 1] = (byte)((sample >> 8) & 0xFF);
            }
        }
        else
        {
            pcm16 = new byte[e.BytesRecorded];
            Buffer.BlockCopy(e.Buffer, 0, pcm16, 0, e.BytesRecorded);
        }

        var base64 = Convert.ToBase64String(pcm16);              // 便于通过 JSON 传输
        PostToPage(new
        {
            type = "live:system-audio-chunk",
            data = base64,
            sampleRate = format.SampleRate,
            channels = format.Channels,
        });
    }

    /// <summary>
    /// 采集被系统终止（设备移除 / 音频服务重启）：通知页面切回本机麦克风。
    /// </summary>
    private void OnAudioRecordingStopped(object? sender, StoppedEventArgs e)
    {
        StopSystemAudio();
        PostToPage(new { type = "live:system-audio-ended" });
    }

    /// <summary>
    /// 向页面发送消息（原生命中可能在采集线程，统一调度到界面线程）。
    /// </summary>
    /// <param name="payload">要发送的对象</param>
    private void PostToPage(object payload)
    {
        var json = JsonSerializer.Serialize(payload);   // 先序列化，减少界面线程耗时
        Dispatcher.BeginInvoke(new Action(() =>
        {
            if (!_webReady)
            {
                return;
            }
            try
            {
                Web.CoreWebView2?.PostWebMessageAsJson(json);
            }
            catch
            {
                // 页面已销毁时忽略
            }
        }));
    }
}
