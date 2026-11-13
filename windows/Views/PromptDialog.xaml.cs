using System.Windows;

namespace MingxingSchool.Desktop.Views;

/// <summary>
/// 通用输入弹窗：支持单行、密码和多行三种输入方式。
/// </summary>
public partial class PromptDialog : Window
{
    /// <summary>用户在弹窗中输入的内容；取消时为 null</summary>
    public string? Result { get; private set; }

    /// <summary>
    /// 构造弹窗并初始化控件。
    /// </summary>
    /// <param name="title">标题</param>
    /// <param name="message">说明文字</param>
    /// <param name="initial">初始值</param>
    /// <param name="placeholder">占位提示</param>
    /// <param name="isPassword">是否密码输入</param>
    /// <param name="multiline">是否多行输入</param>
    /// <param name="okText">确认按钮文字</param>
    public PromptDialog(string title, string message, string initial = "", string placeholder = "",
        bool isPassword = false, bool multiline = false, string okText = "确定")
    {
        InitializeComponent();
        Title = title;
        TitleText.Text = title;
        MessageText.Text = message;
        OkButton.Content = okText;

        if (multiline)
        {
            MultiInput.Visibility = Visibility.Visible;
            MultiInput.Text = initial;
            InputBox.Visibility = Visibility.Collapsed;
            Loaded += (_, _) => { MultiInput.Focus(); MultiInput.CaretIndex = MultiInput.Text.Length; };
        }
        else if (isPassword)
        {
            PasswordInput.Visibility = Visibility.Visible;
            PasswordInput.Password = initial;
            InputBox.Visibility = Visibility.Collapsed;
            Loaded += (_, _) => PasswordInput.Focus();
        }
        else
        {
            InputBox.Text = initial;
            InputBox.ToolTip = placeholder;
            Loaded += (_, _) => { InputBox.Focus(); InputBox.CaretIndex = InputBox.Text.Length; };
        }

        if (!string.IsNullOrWhiteSpace(placeholder) && !isPassword)
        {
            MessageText.Text = message + "\n提示：" + placeholder;
        }
    }

    /// <summary>
    /// 确认：读取当前输入并关闭。
    /// </summary>
    private void Ok_Click(object sender, RoutedEventArgs e)
    {
        if (MultiInput.Visibility == Visibility.Visible)
        {
            Result = MultiInput.Text;
        }
        else if (PasswordInput.Visibility == Visibility.Visible)
        {
            Result = PasswordInput.Password;
        }
        else
        {
            Result = InputBox.Text;
        }
        DialogResult = true;
        Close();
    }

    /// <summary>
    /// 取消：不返回任何值。
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
