using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace MingxingSchool.Desktop.Core;

/// <summary>
/// 属性变更通知基类：所有 ViewModel 继承它以支持双向绑定。
/// </summary>
public abstract class ObservableObject : INotifyPropertyChanged
{
    /// <summary>属性变更事件</summary>
    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>
    /// 触发属性变更通知。
    /// </summary>
    /// <param name="propertyName">属性名（由编译器自动填充）</param>
    protected void OnPropertyChanged([CallerMemberName] string? propertyName = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));

    /// <summary>
    /// 设置属性值并在值变化时触发通知。
    /// </summary>
    /// <typeparam name="T">属性类型</typeparam>
    /// <param name="field">字段引用</param>
    /// <param name="value">新值</param>
    /// <param name="propertyName">属性名</param>
    /// <returns>值是否发生变化</returns>
    protected bool SetProperty<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value))
        {
            return false;
        }
        field = value;
        OnPropertyChanged(propertyName);
        return true;
    }
}