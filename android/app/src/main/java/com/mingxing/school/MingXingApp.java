package com.mingxing.school;

import android.app.Application;

/**
 * 应用入口：安装崩溃日志捕获，便于用户反馈闪退原因
 */
public class MingXingApp extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        // 全局捕获 Java 层崩溃，写入私有目录，下次启动展示
        CrashLog.install(this);
    }
}
