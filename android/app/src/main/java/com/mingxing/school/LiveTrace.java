package com.mingxing.school;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 直播初始化步骤标记：在每一步原生调用前后记录“当前步骤”，
 * 若发生 Java 捕获不到的原生崩溃，下次启动就能看到最后停在哪一步。
 */
public final class LiveTrace {

    /** 偏好文件名 */
    private static final String PREF_NAME = "live_trace";
    /** 步骤键名 */
    private static final String KEY_STEP = "step";

    /** 工具类不允许实例化 */
    private LiveTrace() {
    }

    /**
     * 记录当前步骤
     * @param context 任意上下文
     * @param step 步骤说明（中文）
     */
    public static void step(Context context, String step) {
        // 使用 commit 同步落盘：原生崩溃会立即终止进程，apply 的异步写盘来不及完成，
        // 会导致下次启动读到的步骤不是崩溃真正发生的那一步，影响定位
        prefs(context).edit().putString(KEY_STEP, step).commit();
    }

    /**
     * 正常结束流程，清除步骤标记
     * @param context 任意上下文
     */
    public static void clear(Context context) {
        // 同 step：同步落盘，保证正常结束后标记确实被清除
        prefs(context).edit().remove(KEY_STEP).commit();
    }

    /**
     * 读取上次停留的步骤
     * @param context 任意上下文
     * @return 步骤说明；没有标记时返回 null
     */
    public static String last(Context context) {
        return prefs(context).getString(KEY_STEP, null);
    }

    /**
     * 获取偏好对象
     * @param context 任意上下文
     * @return SharedPreferences
     */
    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext()
                .getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }
}
