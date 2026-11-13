using System.Windows;

namespace MingxingSchool.Desktop.Views;

/// <summary>
/// 通用确认弹窗。
/// </summary>
public partial class ConfirmDialog : Window
{
    /// <summary>
    /// 构造确认弹窗。
    /// </summary>
    /// <param name="title">标题</param>
    /// <param name="message">说明</param>
    /// <param name="okText">确认按钮文字</param>
    /// <param name="danger">是否使用红色危险按钮</param>
    public ConfirmDialog(string title, string message, string okText = "确定", bool danger = false)
    {
        InitializeComponent();
        Title = title;
        TitleText.Text = title;
        MessageText.Text = message;
        OkButton.Content = okText;
        if (!danger)
        {
            OkButton.Style = (Style)FindResource("PrimaryButton");
        }
        Loaded += (_, _) => OkButton.Focus();
    }

    /// <summary>
    /// 确认。
    /// </summary>
    private void Ok_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = true;
        Close();
    }

    /// <summary>
    /// 取消。
    /// </summary>
    private void Cancel_Click(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    /// <summary>
    /// 点击自绘关闭按钮：等同于取消。
    /// </summary>
    private void Close_Click(object sender, RoutedEventArgs e)
    {
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
            DialogResult = false;
            Close();
        }
    }
}
