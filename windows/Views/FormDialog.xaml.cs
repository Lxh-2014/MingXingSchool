using System.Windows;
using System.Windows.Controls;

namespace MingxingSchool.Desktop.Views;

/// <summary>
/// 表单字段定义：用于动态生成通用表单弹窗。
/// </summary>
public sealed class FormField
{
    /// <summary>字段键（结果字典的 key）</summary>
    public string Key { get; init; } = string.Empty;
    /// <summary>显示标签</summary>
    public string Label { get; init; } = string.Empty;
    /// <summary>初始值</summary>
    public string Value { get; init; } = string.Empty;
    /// <summary>占位提示</summary>
    public string Placeholder { get; init; } = string.Empty;
    /// <summary>是否为密码输入</summary>
    public bool IsPassword { get; init; }
    /// <summary>是否为多行输入</summary>
    public bool Multiline { get; init; }
    /// <summary>下拉选项（不为空时渲染 ComboBox）</summary>
    public IReadOnlyList<string>? Choices { get; init; }
}

/// <summary>
/// 动态表单弹窗：按字段定义生成输入控件，返回键值对。
/// </summary>
public partial class FormDialog : Window
{
    /// <summary>字段键 → 读取当前值的委托</summary>
    private readonly List<(string Key, Func<string> Read)> _readers = new();

    /// <summary>用户填写结果；取消时为 null</summary>
    public Dictionary<string, string>? Result { get; private set; }

    /// <summary>
    /// 构造表单弹窗并动态创建控件。
    /// </summary>
    public FormDialog(string title, string message, IReadOnlyList<FormField> fields, string okText = "保存")
    {
        InitializeComponent();
        Title = title;
        TitleText.Text = title;
        MessageText.Text = message;
        OkButton.Content = okText;

        foreach (var field in fields)
        {
            // 标签
            var label = new TextBlock
            {
                Text = field.Label,
                Style = (Style)FindResource("FieldLabelText"),
                Margin = new Thickness(0, _readers.Count == 0 ? 0 : 12, 0, 6),
            };
            FieldsPanel.Children.Add(label);

            if (field.Choices is { Count: > 0 })
            {
                var combo = new ComboBox { ItemsSource = field.Choices, MinHeight = 38 };
                combo.SelectedItem = field.Choices.Contains(field.Value) ? field.Value : field.Choices[0];
                FieldsPanel.Children.Add(combo);
                _readers.Add((field.Key, () => combo.SelectedItem?.ToString() ?? string.Empty));
            }
            else if (field.Multiline)
            {
                var box = new TextBox
                {
                    Text = field.Value,
                    AcceptsReturn = true,
                    TextWrapping = TextWrapping.Wrap,
                    Height = 110,
                    VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                    VerticalContentAlignment = VerticalAlignment.Top,
                };
                FieldsPanel.Children.Add(box);
                _readers.Add((field.Key, () => box.Text));
            }
            else if (field.IsPassword)
            {
                var box = new PasswordBox { Password = field.Value, MinHeight = 38 };
                FieldsPanel.Children.Add(box);
                _readers.Add((field.Key, () => box.Password));
            }
            else
            {
                var box = new TextBox { Text = field.Value, MinHeight = 38, ToolTip = field.Placeholder };
                FieldsPanel.Children.Add(box);
                _readers.Add((field.Key, () => box.Text));
            }
        }

        Loaded += (_, _) =>
        {
            // 聚焦第一个输入控件，提升键盘操作体验
            if (FieldsPanel.Children.Count > 1 && FieldsPanel.Children[1] is Control control)
            {
                control.Focus();
            }
        };
    }

    /// <summary>
    /// 保存：收集所有字段值并关闭。
    /// </summary>
    private void Ok_Click(object sender, RoutedEventArgs e)
    {
        Result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, read) in _readers)
        {
            Result[key] = read();
        }
        DialogResult = true;
        Close();
    }

    /// <summary>
    /// 取消。
    /// </summary>
    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        Result = null;
        DialogResult = false;
        Close();
    }

    /// <summary>
    /// 点击自绘关闭按钮：等同于取消。
    /// </summary>
    private void Close_Click(object sender, RoutedEventArgs e)
    {
        Result = null;
        DialogResult = false;
        Close();
    }

    /// <summary>
    /// 按住标题区域拖动无边框弹窗。
    /// </summary>
    private void TitleBar_MouseLeftButtonDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if (e.LeftButton == System.Windows.Input.MouseButtonState.Pressed)
        {
            DragMove();
        }
    }

    /// <summary>
    /// 键盘处理：ESC 关闭弹窗（等同取消）。
    /// </summary>
    private void Window_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Escape)
        {
            e.Handled = true;
            Result = null;
            DialogResult = false;
            Close();
        }
    }
}