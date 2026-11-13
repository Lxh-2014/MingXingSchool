using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Net.Http;
using MingxingSchool.Desktop.Models;
using MingxingSchool.Desktop.Services;

namespace MingxingSchool.Desktop.Views.Pages;

/// <summary>
/// 明星广播器：实时展示频道状态（SSE），管理员可播放 / 暂停 / 停止各频道。
/// </summary>
public partial class BroadcastPage : UserControl
{
    /// <summary>左侧频道卡片数据源</summary>
    private readonly ObservableCollection<ChannelCard> _cards = new();
    /// <summary>最新一次频道快照（用于下拉与卡片）</summary>
    private readonly List<ChannelStateDto> _states = new();
    /// <summary>音频列表</summary>
    private readonly List<AudioDto> _audios = new();
    /// <summary>SSE 取消令牌，页面卸载时终止订阅</summary>
    private CancellationTokenSource? _cts;

    /// <summary>构造函数：初始化并订阅 SSE 与加载音频。</summary>
    public BroadcastPage()
    {
        InitializeComponent();
        ChannelList.ItemsSource = _cards;
        ControlPanel.Visibility = AppServices.IsAdmin ? Visibility.Visible : Visibility.Collapsed;

        Loaded += async (_, _) =>
        {
            await LoadAudiosAsync();
            await RefreshAsync();
            StartSse();
        };
        Unloaded += (_, _) => _cts?.Cancel();
    }

    /// <summary>加载可选音频列表。</summary>
    private async Task LoadAudiosAsync()
    {
        try
        {
            var env = await AppServices.Api.SendAsync<BroadcastEnvelope<AudioListPayload>>(HttpMethod.Get, "/broadcast/api/audio");
            _audios.Clear();
            if (env.Data?.List is not null)
            {
                _audios.AddRange(env.Data.List);
            }
            AudioCombo.ItemsSource = _audios;
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>拉取一次全量频道快照。</summary>
    private async Task RefreshAsync()
    {
        try
        {
            var env = await AppServices.Api.SendAsync<BroadcastEnvelope<List<ChannelStateDto>>>(HttpMethod.Get, "/broadcast/api/channels");
            if (env.Data is not null)
            {
                ApplySnapshot(env.Data);
            }
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>启动 SSE 订阅，收到 snapshot 事件即刷新。</summary>
    private void StartSse()
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        var token = _cts.Token;

        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await AppServices.Api.SubscribeSseAsync("/broadcast/api/events", (name, data) =>
                    {
                        if (name == "snapshot")
                        {
                            Dispatcher.Invoke(() => ApplySnapshot(ApiClient.Deserialize<List<ChannelStateDto>>(data)));
                        }
                    }, token);
                }
                catch
                {
                    // 连接中断后稍等重连
                }
                await Task.Delay(3000, token).ContinueWith(_ => { }, TaskContinuationOptions.OnlyOnCanceled);
            }
        });
    }

    /// <summary>用最新快照重建卡片与下拉。</summary>
    private void ApplySnapshot(List<ChannelStateDto> states)
    {
        _states.Clear();
        _states.AddRange(states);

        _cards.Clear();
        foreach (var s in states)
        {
            _cards.Add(ChannelCard.From(s));
        }

        // 保持频道下拉选中项
        var selectedId = (ChannelCombo.SelectedItem as ChannelStateDto)?.Id;
        ChannelCombo.ItemsSource = _states;
        if (selectedId is not null)
        {
            ChannelCombo.SelectedItem = _states.FirstOrDefault(x => x.Id == selectedId);
        }
        else if (_states.Count > 0)
        {
            ChannelCombo.SelectedIndex = 0;
        }
        if (AudioCombo.ItemsSource is null)
        {
            AudioCombo.ItemsSource = _audios;
        }
    }

    /// <summary>当前选中的频道。</summary>
    private ChannelStateDto? SelectedChannel => ChannelCombo.SelectedItem as ChannelStateDto;

    /// <summary>播放：投放选中音频并从头开始。</summary>
    private async void Play_Click(object sender, RoutedEventArgs e)
    {
        var ch = SelectedChannel;
        var audio = AudioCombo.SelectedItem as AudioDto;
        if (ch is null || audio is null)
        {
            ToastService.Show("请选择频道和音频", ToastKind.Warning);
            return;
        }
        try
        {
            await AppServices.Api.SendAsync<BroadcastEnvelope<object>>(HttpMethod.Post,
                $"/broadcast/api/channels/{Uri.EscapeDataString(ch.Id)}/play", new { audioId = audio.Id });
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>暂停当前频道。</summary>
    private async void Pause_Click(object sender, RoutedEventArgs e)
    {
        await ControlAsync("pause");
    }

    /// <summary>继续播放当前频道。</summary>
    private async void Resume_Click(object sender, RoutedEventArgs e)
    {
        await ControlAsync("resume");
    }

    /// <summary>停止当前频道。</summary>
    private async void Stop_Click(object sender, RoutedEventArgs e)
    {
        await ControlAsync("stop");
    }

    /// <summary>通用控制动作：pause / resume / stop。</summary>
    private async Task ControlAsync(string action)
    {
        var ch = SelectedChannel;
        if (ch is null)
        {
            ToastService.Show("请选择频道", ToastKind.Warning);
            return;
        }
        try
        {
            await AppServices.Api.SendAsync<BroadcastEnvelope<object>>(HttpMethod.Post,
                $"/broadcast/api/channels/{Uri.EscapeDataString(ch.Id)}/{action}");
        }
        catch (Exception ex) { ToastService.Show(ex.Message, ToastKind.Error); }
    }

    /// <summary>手动刷新状态。</summary>
    private async void Refresh_Click(object sender, RoutedEventArgs e)
    {
        await RefreshAsync();
    }
}

/// <summary>频道状态卡片模型。</summary>
public sealed class ChannelCard
{
    /// <summary>频道名</summary>
    public string Name { get; init; } = string.Empty;
    /// <summary>图标色</summary>
    public Color IconColor { get; init; }
    /// <summary>图标首字符</summary>
    public string Initial { get; init; } = "?";
    /// <summary>当前音频描述</summary>
    public string AudioDesc { get; init; } = "未播放";
    /// <summary>状态中文</summary>
    public string StatusText { get; init; } = "空闲";
    /// <summary>状态徽标颜色</summary>
    public Color StatusColor { get; init; }
    /// <summary>在线人数描述</summary>
    public string ListenersDesc { get; init; } = "在线 0 人";

    /// <summary>由服务端状态构建卡片。</summary>
    public static ChannelCard From(ChannelStateDto s)
    {
        var iconColor = ParseColor(s.Color) ?? Color.FromRgb(0x1C, 0xB0, 0xF6);
        var (statusText, statusColor) = s.Status switch
        {
            "playing" => ("播放中", Color.FromRgb(0x3C, 0xB3, 0x71)),
            "paused" => ("已暂停", Color.FromRgb(0xE6, 0xA7, 0x00)),
            _ => ("空闲", Color.FromRgb(0x9E, 0x9E, 0x9E)),
        };
        return new ChannelCard
        {
            Name = s.Name,
            IconColor = iconColor,
            Initial = string.IsNullOrWhiteSpace(s.Name) ? "?" : s.Name[..1],
            AudioDesc = string.IsNullOrWhiteSpace(s.AudioName) ? "未播放" : "正在播放：" + s.AudioName,
            StatusText = statusText,
            StatusColor = statusColor,
            ListenersDesc = "在线 " + s.Listeners + " 人",
        };
    }

    /// <summary>解析 #RRGGBB 色值。</summary>
    private static Color? ParseColor(string hex)
    {
        if (string.IsNullOrWhiteSpace(hex) || !hex.StartsWith("#")) return null;
        try
        {
            var c = (Color)ColorConverter.ConvertFromString(hex);
            return c;
        }
        catch
        {
            return null;
        }
    }
}