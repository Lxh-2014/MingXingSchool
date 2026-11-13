using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.IO;
using System.Net.Http;
using Microsoft.Win32;
using MingxingSchool.Desktop.Models;
using MingxingSchool.Desktop.Services;

namespace MingxingSchool.Desktop.Views.Pages;

/// <summary>
/// 明星云网盘：按网页端样式还原（网格图标视图 + 地址栏 + 面包屑 + 搜索 + 右键菜单）。
/// 路径说明：服务端维护完整绝对路径，客户端保存 _rootPath 与当前完整路径。
/// </summary>
public partial class DrivePage : UserControl
{
    /// <summary>网盘根目录完整路径（来自 /api/files/root）</summary>
    private string _rootPath = string.Empty;
    /// <summary>当前目录完整路径</summary>
    private string _currentPath = string.Empty;
    /// <summary>当前目录下的全部条目（未过滤）</summary>
    private readonly List<FileItem> _allItems = new();
    /// <summary>界面显示用的条目集合（经搜索过滤后）</summary>
    private readonly ObservableCollection<FileItem> _items = new();
    /// <summary>目录访问历史（支持后退/前进）</summary>
    private readonly List<string> _history = new();
    /// <summary>历史游标：指向当前目录在 _history 中的下标</summary>
    private int _historyIndex = -1;
    /// <summary>当前搜索关键词（为空表示不过滤）</summary>
    private string _keyword = string.Empty;
    /// <summary>初始化标记：避免首次加载重复触发</summary>
    private bool _initialized;

    /// <summary>构造函数：绑定数据源并在首次加载时读取根目录。</summary>
    public DrivePage()
    {
        InitializeComponent();
        FileGrid.ItemsSource = _items;
        Loaded += async (_, _) =>
        {
            if (_initialized)
            {
                return;
            }
            _initialized = true;
            await InitRootAsync();
        };
    }

    /// <summary>读取根目录并进入，随后加载文件列表。</summary>
    private async Task InitRootAsync()
    {
        try
        {
            ShowLoading(true);
            var res = await AppServices.Api.SendAsync<DriveRootResponse>(HttpMethod.Get, "/drive/api/files/root");
            _rootPath = res.Root;
            _history.Clear();
            _history.Add(_rootPath);
            _historyIndex = 0;
            _currentPath = _rootPath;
            await LoadFilesAsync(recordHistory: false);
        }
        catch (Exception ex)
        {
            ShowLoading(false);
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>
    /// 加载当前目录的文件与文件夹。
    /// </summary>
    /// <param name="recordHistory">是否把本次目录写入历史（后退/前进跳转时为 false）</param>
    private async Task LoadFilesAsync(bool recordHistory = true)
    {
        try
        {
            ShowLoading(true);
            var query = _currentPath == _rootPath ? string.Empty : "?folder=" + Uri.EscapeDataString(_currentPath);
            var res = await AppServices.Api.SendAsync<DriveListResponse>(HttpMethod.Get, "/drive/api/files/list" + query);

            _allItems.Clear();
            foreach (var f in res.Folders)
            {
                _allItems.Add(new FileItem(f.Name, f.Path, 0, f.Modified, true));
            }
            foreach (var f in res.Files)
            {
                _allItems.Add(new FileItem(f.Name, f.Path, f.Size, f.Modified, false));
            }

            if (recordHistory)
            {
                PushHistory(_currentPath);
            }

            _keyword = string.Empty;
            SearchBox.Text = string.Empty;
            ApplyFilter();
            UpdateBreadcrumbs();
            UpdateNavState();
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
        finally
        {
            ShowLoading(false);
        }
    }

    /// <summary>把目录写入历史；若当前不在历史末尾则截断后续记录。</summary>
    private void PushHistory(string path)
    {
        if (_historyIndex >= 0 && _historyIndex < _history.Count - 1)
        {
            _history.RemoveRange(_historyIndex + 1, _history.Count - _historyIndex - 1);
        }
        if (_historyIndex >= 0 && _history[_historyIndex] == path)
        {
            return;
        }
        _history.Add(path);
        _historyIndex = _history.Count - 1;
    }

    /// <summary>按当前搜索关键词过滤条目并刷新界面与空状态。</summary>
    private void ApplyFilter()
    {
        _items.Clear();
        var matched = string.IsNullOrWhiteSpace(_keyword)
            ? _allItems
            : _allItems.Where(f => f.Name.Contains(_keyword, StringComparison.OrdinalIgnoreCase)).ToList();

        foreach (var item in matched)
        {
            _items.Add(item);
        }

        var empty = _items.Count == 0;
        EmptyState.Visibility = empty ? Visibility.Visible : Visibility.Collapsed;
        EmptyText.Text = string.IsNullOrWhiteSpace(_keyword) ? "没有文件" : "没有匹配的文件";
    }

    /// <summary>刷新按钮可用状态（后退/前进是否可点）。</summary>
    private void UpdateNavState()
    {
        BackButton.IsEnabled = _historyIndex > 0;
        ForwardButton.IsEnabled = _historyIndex >= 0 && _historyIndex < _history.Count - 1;
        UpButton.IsEnabled = _currentPath != _rootPath;
    }

    /// <summary>切换加载中提示。</summary>
    private void ShowLoading(bool loading)
    {
        LoadingText.Visibility = loading ? Visibility.Visible : Visibility.Collapsed;
        if (loading)
        {
            EmptyState.Visibility = Visibility.Collapsed;
        }
    }

    /// <summary>按当前完整路径生成面包屑：根目录 › 一级 › 二级。</summary>
    private void UpdateBreadcrumbs()
    {
        var parts = new List<BreadcrumbItem>
        {
            new("根目录", _rootPath, false)
        };

        if (_currentPath != _rootPath)
        {
            var rel = _currentPath.Replace(_rootPath, string.Empty)
                .Replace('\\', '/')
                .Trim('/');
            var acc = _rootPath;
            var segments = rel.Split('/', StringSplitOptions.RemoveEmptyEntries);
            for (var i = 0; i < segments.Length; i++)
            {
                acc = Path.Combine(acc, segments[i]);
                parts.Add(new BreadcrumbItem(segments[i], acc, i == segments.Length - 1));
            }
        }

        parts[^1] = new BreadcrumbItem(parts[^1].Name, parts[^1].Path, true);
        BreadcrumbList.ItemsSource = parts;
    }

    /// <summary>点击面包屑路径段：跳转到对应层级。</summary>
    private async void Breadcrumb_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as Button)?.Tag is not BreadcrumbItem crumb || crumb.IsLast)
        {
            return;
        }
        _currentPath = crumb.Path;
        await LoadFilesAsync();
    }

    /// <summary>后退到上一个访问过的目录。</summary>
    private async void Back_Click(object sender, RoutedEventArgs e)
    {
        if (_historyIndex <= 0)
        {
            return;
        }
        _historyIndex--;
        _currentPath = _history[_historyIndex];
        await LoadFilesAsync(recordHistory: false);
    }

    /// <summary>前进到下一个访问过的目录。</summary>
    private async void Forward_Click(object sender, RoutedEventArgs e)
    {
        if (_historyIndex >= _history.Count - 1)
        {
            return;
        }
        _historyIndex++;
        _currentPath = _history[_historyIndex];
        await LoadFilesAsync(recordHistory: false);
    }

    /// <summary>返回上级目录。</summary>
    private async void GoUp_Click(object sender, RoutedEventArgs e)
    {
        var parent = Path.GetDirectoryName(_currentPath);
        if (string.IsNullOrEmpty(parent) || !parent.StartsWith(_rootPath, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        _currentPath = parent;
        await LoadFilesAsync();
    }

    /// <summary>刷新当前目录。</summary>
    private async void Refresh_Click(object sender, RoutedEventArgs e)
    {
        await LoadFilesAsync(recordHistory: false);
    }

    /// <summary>搜索框输入：实时过滤当前目录下的条目。</summary>
    private void Search_TextChanged(object sender, TextChangedEventArgs e)
    {
        _keyword = SearchBox.Text.Trim();
        ApplyFilter();
    }

    /// <summary>双击文件卡片：文件夹进入，文件下载。</summary>
    private async void FileCard_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount != 2 || (sender as FrameworkElement)?.DataContext is not FileItem item)
        {
            return;
        }
        if (item.IsFolder)
        {
            _currentPath = item.Path;
            await LoadFilesAsync();
        }
        else
        {
            await DownloadItemAsync(item);
        }
    }

    /// <summary>右键按下：把对应条目设为右键菜单的数据上下文。</summary>
    private void FileCard_MouseRightButtonDown(object sender, MouseButtonEventArgs e)
    {
        if ((sender as FrameworkElement)?.DataContext is FileItem item)
        {
            (sender as FrameworkElement)!.ContextMenu!.DataContext = item;
        }
    }

    /// <summary>右键菜单「下载 / 导出」。</summary>
    private async void MenuDownload_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as MenuItem)?.DataContext is not FileItem item)
        {
            return;
        }
        if (item.IsFolder)
        {
            ToastService.Show("文件夹暂不支持直接下载", ToastKind.Info);
            return;
        }
        await DownloadItemAsync(item);
    }

    /// <summary>右键菜单「重命名」。</summary>
    private async void MenuRename_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as MenuItem)?.DataContext is not FileItem item)
        {
            return;
        }
        var name = DialogService.Prompt("重命名", $"为「{item.Name}」输入新名称", item.Name, placeholder: "新名称");
        if (name is null)
        {
            return;
        }
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Post, "/drive/api/files/rename", new
            {
                oldPath = item.Path,
                newName = name.Trim(),
            });
            ToastService.Show("重命名成功", ToastKind.Success);
            await LoadFilesAsync(recordHistory: false);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>右键菜单「属性」：显示大小与修改时间。</summary>
    private void MenuInfo_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as MenuItem)?.DataContext is not FileItem item)
        {
            return;
        }
        var typeText = item.IsFolder ? "文件夹" : "文件";
        var detail = item.IsFolder
            ? $"{typeText} · 修改时间 {item.ModifiedText}"
            : $"{typeText} · {item.SizeText} · 修改时间 {item.ModifiedText}";
        ToastService.Show($"{item.Name}：{detail}", ToastKind.Info);
    }

    /// <summary>右键菜单「删除」。</summary>
    private async void MenuDelete_Click(object sender, RoutedEventArgs e)
    {
        if ((sender as MenuItem)?.DataContext is not FileItem item)
        {
            return;
        }
        var typeText = item.IsFolder ? "文件夹" : "文件";
        if (!DialogService.Confirm($"删除{typeText}", $"确定删除「{item.Name}」？该操作不可恢复！", "删除"))
        {
            return;
        }
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Post, "/drive/api/files/delete", new { path = item.Path });
            ToastService.Show("已删除", ToastKind.Success);
            await LoadFilesAsync(recordHistory: false);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>上传文件到当前目录（支持多选）。</summary>
    private async void Upload_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Multiselect = true, Title = "选择要上传的文件" };
        if (dialog.ShowDialog() != true)
        {
            return;
        }

        try
        {
            // 服务端上传接口的 folder 参数按「相对根目录」解释，需转换当前完整路径
            var fields = new Dictionary<string, string>();
            if (_currentPath != _rootPath)
            {
                fields["folder"] = Path.GetRelativePath(_rootPath, _currentPath);
            }
            foreach (var file in dialog.FileNames)
            {
                await AppServices.Api.UploadFileAsync<DriveUploadResponse>("/drive/api/files/upload", file, "file", fields);
            }
            ToastService.Show($"已上传 {dialog.FileNames.Length} 个文件", ToastKind.Success);
            await LoadFilesAsync(recordHistory: false);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>下载文件到本地所选位置。</summary>
    private async Task DownloadItemAsync(FileItem item)
    {
        var dialog = new SaveFileDialog { FileName = item.Name, Title = "另存为" };
        if (dialog.ShowDialog() != true)
        {
            return;
        }
        try
        {
            await AppServices.Api.DownloadAsync(
                "/drive/api/files/download?path=" + Uri.EscapeDataString(item.Path),
                dialog.FileName, null);
            ToastService.Show("下载完成", ToastKind.Success);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }

    /// <summary>新建文件夹（创建于当前目录）。</summary>
    private async void NewFolder_Click(object sender, RoutedEventArgs e)
    {
        var name = DialogService.Prompt("新建文件夹", "输入文件夹名称", placeholder: "文件夹名");
        if (name is null)
        {
            return;
        }
        try
        {
            await AppServices.Api.SendAsync<SimpleResponse>(HttpMethod.Post, "/drive/api/files/newfolder", new
            {
                name = name.Trim(),
                parent = _currentPath,
            });
            ToastService.Show("文件夹已创建", ToastKind.Success);
            await LoadFilesAsync(recordHistory: false);
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
    }
}

/// <summary>面包屑路径段模型。</summary>
public sealed class BreadcrumbItem
{
    /// <summary>段名（根目录 / 子目录名）</summary>
    public string Name { get; }
    /// <summary>该段对应的完整路径</summary>
    public string Path { get; }
    /// <summary>是否为当前所在层级（末段不可点击、不显示分隔符）</summary>
    public bool IsLast { get; }
    /// <summary>分隔符显示状态：末段不显示</summary>
    public Visibility SeparatorVisibility => IsLast ? Visibility.Collapsed : Visibility.Visible;

    /// <summary>构造面包屑段。</summary>
    public BreadcrumbItem(string name, string path, bool isLast)
    {
        Name = name;
        Path = path;
        IsLast = isLast;
    }
}

/// <summary>网盘文件 / 文件夹条目模型。</summary>
public sealed class FileItem
{
    /// <summary>文件夹图标（橙色实心）</summary>
    private const string FolderGeometry =
        "M22,19 A2,2 0 0,1 20,21 H4 A2,2 0 0,1 2,19 V5 A2,2 0 0,1 4,3 H9 L11,6 H20 A2,2 0 0,1 22,8 Z";
    /// <summary>普通文件图标</summary>
    private const string FileGeometry =
        "M14,2 H6 A2,2 0 0,0 4,4 V20 A2,2 0 0,0 6,22 H18 A2,2 0 0,0 20,20 V8 Z";

    /// <summary>名称</summary>
    public string Name { get; }
    /// <summary>完整路径</summary>
    public string Path { get; }
    /// <summary>字节大小</summary>
    public long Size { get; }
    /// <summary>修改时间</summary>
    public DateTime Modified { get; }
    /// <summary>是否文件夹</summary>
    public bool IsFolder { get; }

    /// <summary>构造条目模型。</summary>
    public FileItem(string name, string path, long size, DateTime modified, bool isFolder)
    {
        Name = name;
        Path = path;
        Size = size;
        Modified = modified;
        IsFolder = isFolder;
    }

    /// <summary>图标几何：文件夹与文件使用不同形状</summary>
    public Geometry IconGeometry => Geometry.Parse(IsFolder ? FolderGeometry : FileGeometry);

    /// <summary>图标颜色：文件夹橙色，文件按扩展名取色（对齐网页端规则）</summary>
    public Brush IconBrush
    {
        get
        {
            if (IsFolder)
            {
                return new SolidColorBrush(Color.FromRgb(0xF5, 0xA6, 0x23));
            }
            var ext = Name.Contains('.') ? Name[(Name.LastIndexOf('.') + 1)..].ToLowerInvariant() : string.Empty;
            var color = ext switch
            {
                "jpg" or "jpeg" or "png" or "gif" or "bmp" or "pdf" => "#E74C3C",
                "doc" or "docx" => "#3498DB",
                "xls" or "xlsx" => "#27AE60",
                "ppt" or "pptx" => "#E67E22",
                "zip" or "rar" or "7z" => "#9B59B6",
                _ => "#95A5A6",
            };
            return new SolidColorBrush((Color)ColorConverter.ConvertFromString(color));
        }
    }

    /// <summary>大小展示文本（文件夹为空）</summary>
    public string SizeText => IsFolder ? string.Empty : FormatSize(Size);

    /// <summary>修改时间展示文本</summary>
    public string ModifiedText => Modified.ToString("yyyy-MM-dd HH:mm");

    /// <summary>字节数转可读文本。</summary>
    private static string FormatSize(long bytes)
    {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024L * 1024) return (bytes / 1024.0).ToString("0.#") + " KB";
        if (bytes < 1024L * 1024 * 1024) return (bytes / (1024.0 * 1024)).ToString("0.#") + " MB";
        return (bytes / (1024.0 * 1024 * 1024)).ToString("0.#") + " GB";
    }
}
