package com.mingxing.school.data;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.appcompat.app.AppCompatDelegate;

/**
 * 应用偏好存储
 * 作用：保存与主题相关的本地偏好（深色模式），供启动时与设置页共用。
 */
public final class AppPrefs {

    /** SharedPreferences 文件名 */
    private static final String PREF_NAME = "mingxing_settings";
    /** 深色模式偏好键名，取值为 AppCompatDelegate 的 MODE_NIGHT_* 常量 */
    private static final String KEY_NIGHT_MODE = "nightMode";

    /** 工具类不允许实例化 */
    private AppPrefs() {
    }

    /**
     * 读取深色模式偏好
     * @param context 任意上下文
     * @return AppCompatDelegate.MODE_NIGHT_* 常量，默认跟随系统
     */
    public static int getNightMode(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        return prefs.getInt(KEY_NIGHT_MODE, AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM);
    }

    /**
     * 保存深色模式偏好并立即应用（会触发界面按新主题重建）
     * @param context 任意上下文
     * @param mode AppCompatDelegate.MODE_NIGHT_* 常量
     */
    public static void setNightMode(Context context, int mode) {
        context.getApplicationContext()
                .getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
                .edit()
                .putInt(KEY_NIGHT_MODE, mode)
                .apply();
        // 立即生效：Activity 会按新主题重建
        AppCompatDelegate.setDefaultNightMode(mode);
    }
}