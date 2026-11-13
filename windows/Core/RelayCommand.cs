using System.Windows.Input;

namespace MingxingSchool.Desktop.Core;

/// <summary>
/// 可空参数的命令实现：支持同步与异步执行，执行期间自动禁用防止重复点击。
/// </summary>
public sealed class RelayCommand : ICommand
{
    /// <summary>同步或异步执行的逻辑</summary>
    private readonly Func<object?, Task> _execute;
    /// <summary>是否可执行判断（可为空）</summary>
    private readonly Predicate<object?>? _canExecute;
    /// <summary>命令是否正在执行（用于禁用）</summary>
    private bool _isExecuting;

    /// <summary>
    /// 构造命令。
    /// </summary>
    /// <param name="execute">同步执行体</param>
    /// <param name="canExecute">可执行判断</param>
    public RelayCommand(Action execute, Func<bool>? canExecute = null)
        : this(_ => execute(), canExecute is null ? null : _ => canExecute())
    {
    }

    /// <summary>
    /// 构造带参数的同步命令。
    /// </summary>
    public RelayCommand(Action<object?> execute, Predicate<object?>? canExecute = null)
        : this(p => { execute(p); return Task.CompletedTask; }, canExecute)
    {
    }

    /// <summary>
    /// 构造异步命令。
    /// </summary>
    public RelayCommand(Func<Task> execute, Func<bool>? canExecute = null)
        : this(_ => execute(), canExecute is null ? null : _ => canExecute())
    {
    }

    /// <summary>
    /// 构造带参数的异步命令。
    /// </summary>
    public RelayCommand(Func<object?, Task> execute, Predicate<object?>? canExecute = null)
    {
        _execute = execute;
        _canExecute = canExecute;
    }

    /// <summary>可执行状态变化事件</summary>
    public event EventHandler? CanExecuteChanged;

    /// <summary>判断命令当前是否可执行。</summary>
    public bool CanExecute(object? parameter)
        => !_isExecuting && (_canExecute?.Invoke(parameter) ?? true);

    /// <summary>
    /// 执行命令：异步执行并在完成后恢复可执行状态。
    /// </summary>
    public async void Execute(object? parameter)
    {
        if (!CanExecute(parameter))
        {
            return;
        }
        try
        {
            _isExecuting = true;
            RaiseCanExecuteChanged();
            await _execute(parameter);
        }
        finally
        {
            _isExecuting = false;
            RaiseCanExecuteChanged();
        }
    }

    /// <summary>触发可执行状态变化通知。</summary>
    public void RaiseCanExecuteChanged() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);
}