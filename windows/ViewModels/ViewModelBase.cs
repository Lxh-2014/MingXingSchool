using MingxingSchool.Desktop.Core;
using MingxingSchool.Desktop.Services;

namespace MingxingSchool.Desktop.ViewModels;

/// <summary>
/// 页面 ViewModel 基类：统一提供忙碌状态与错误提示。
/// </summary>
public abstract class ViewModelBase : ObservableObject
{
    /// <summary>是否正在执行加载/提交</summary>
    private bool _isBusy;
    /// <summary>忙碌提示文字</summary>
    private string _busyText = "处理中…";

    /// <summary>是否正在忙碌</summary>
    public bool IsBusy { get => _isBusy; set => SetProperty(ref _isBusy, value); }

    /// <summary>忙碌提示文字</summary>
    public string BusyText { get => _busyText; set => SetProperty(ref _busyText, value); }

    /// <summary>
    /// 执行异步任务：自动切换忙碌状态，失败时弹出中文错误提示。
    /// </summary>
    /// <param name="action">要执行的逻辑</param>
    protected async Task RunAsync(Func<Task> action)
    {
        IsBusy = true;
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>
    /// 执行异步任务并返回结果；失败时提示错误并返回默认值。
    /// </summary>
    /// <typeparam name="T">返回类型</typeparam>
    protected async Task<T?> RunAsync<T>(Func<Task<T>> action)
    {
        IsBusy = true;
        try
        {
            return await action();
        }
        catch (Exception ex)
        {
            ToastService.Show(ex.Message, ToastKind.Error);
            return default;
        }
        finally
        {
            IsBusy = false;
        }
    }
}