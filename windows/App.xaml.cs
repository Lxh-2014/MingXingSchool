using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Threading;
using MingxingSchool.Desktop.Services;
using MingxingSchool.Desktop.Views;

namespace MingxingSchool.Desktop;

/// <summary>
/// 应用程序入口：初始化全局服务并管理「登录 ↔ 主窗口」的切换。
/// </summary>
public partial class App : Application
{
    /// <summary>崩溃日志路径（%APPDATA%\MingxingSchool\crash.log）</summary>
    private static string CrashLogPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "MingxingSchool", "crash.log");

    /// <summary>
    /// 启动流程：加载设置、建立 API 连接、应用主题；
    /// 优先用本地保存的会话自动登录，失败再显示登录窗口。
    /// </summary>
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // 全局异常兜底：UI 线程异常弹窗并退出，后台线程异常至少留下日志
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, args) => WriteCrashLog(args.ExceptionObject as Exception);

        AppServices.Initialize();
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        _ = StartupFlowAsync();   // 异步走自动登录流程，不阻塞界面线程
    }

    /// <summary>
    /// UI 线程未处理异常：记录完整堆栈并给出中文提示，避免无声闪退。
    /// </summary>
    private void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        WriteCrashLog(e.Exception);
        e.Handled = true;
        MessageBox.Show(
            "程序遇到错误，已记录日志：\n" + CrashLogPath + "\n\n" + e.Exception.Message,
            "明星学校", MessageBoxButton.OK, MessageBoxImage.Error);
        Shutdown();
    }

    /// <summary>
    /// 追加崩溃日志（含堆栈），便于定位主界面打不开等运行时问题。
    /// </summary>
    private static void WriteCrashLog(Exception? ex)
    {
        if (ex is null)
        {
            return;
        }
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(CrashLogPath)!);
            File.AppendAllText(
                CrashLogPath,
                $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {ex}{Environment.NewLine}{Environment.NewLine}",
                Encoding.UTF8);
        }
        catch
        {
            // 日志写入失败不应再引发二次异常
        }
    }

    /// <summary>
    /// 启动分流：自动登录成功直接进主窗口，否则回落到登录窗口。
    /// </summary>
    private async Task StartupFlowAsync()
    {
        try
        {
            if (await AppServices.TryAutoLoginAsync())
            {
                ShowMainWindow();
                return;
            }
        }
        catch
        {
            // 自动登录过程异常一律回落到手动登录，避免启动失败
        }

        ShowLoginWindow();
    }

    /// <summary>
    /// 显示登录窗口；登录成功则进入主窗口，否则退出应用。
    /// </summary>
    public void ShowLoginWindow()
    {
        var login = new LoginWindow();
        if (login.ShowDialog() == true && AppServices.IsLoggedIn)
        {
            ShowMainWindow();
        }
        else
        {
            Shutdown();
        }
    }

    /// <summary>
    /// 显示主窗口，并切换为「主窗口关闭即退出」。
    /// </summary>
    public void ShowMainWindow()
    {
        var main = new MainWindow();
        MainWindow = main;
        ShutdownMode = ShutdownMode.OnMainWindowClose;
        main.Show();
    }

    /// <summary>
    /// 登出后关闭主窗口、重新回到登录页。
    /// </summary>
    public void ReopenLogin()
    {
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        var main = MainWindow;
        MainWindow = null;
        main?.Close();
        ShowLoginWindow();
    }
}