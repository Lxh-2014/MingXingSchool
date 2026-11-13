package com.mingxing.school;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * 崩溃日志工具：把未捕获异常的堆栈写入应用私有目录，
 * 下次启动时由 BaseActivity 弹出对话框展示，方便用户在没有电脑时反馈崩溃原因。
 * 注意：只能捕获 Java 层异常，原生（native）崩溃不会走到这里。
 */
public final class CrashLog {

    /** 崩溃日志文件名（保存在应用私有 files 目录） */
    private static final String FILE_NAME = "last_crash.txt";

    /** 工具类不允许实例化 */
    private CrashLog() {
    }

    /**
     * 安装全局未捕获异常处理器
     * @param context 任意上下文，内部使用 ApplicationContext
     */
    public static void install(Context context) {
        final Context app = context.getApplicationContext();
        // 保留系统默认处理器，写盘后继续交给它，保证系统崩溃流程不被破坏
        final Thread.UncaughtExceptionHandler previous =
                Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                StringWriter writer = new StringWriter();
                error.printStackTrace(new PrintWriter(writer));
                File file = new File(app.getFilesDir(), FILE_NAME);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(writer.toString().getBytes("UTF-8"));
                }
            } catch (Throwable ignored) {
                // 写日志失败时保持原样，不能影响系统默认处理
            }
            if (previous != null) {
                previous.uncaughtException(thread, error);
            }
        });
    }

    /**
     * 读取并删除上次崩溃日志
     * @param context 任意上下文
     * @return 崩溃堆栈文本；没有记录时返回 null
     */
    public static String take(Context context) {
        File file = new File(context.getFilesDir(), FILE_NAME);
        if (!file.exists()) {
            return null;
        }
        try (FileInputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int len;
            while ((len = in.read(buffer)) != -1) {
                out.write(buffer, 0, len);
            }
            return new String(out.toByteArray(), "UTF-8");
        } catch (Exception e) {
            return null;
        } finally {
            file.delete();
        }
    }
}
