package com.mingxing.school.data;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 登录会话本地存储
 * 作用：保存登录接口返回的 token 与用户信息，供启动时判断登录态、
 *      以及后续接口在 Authorization 头中携带令牌。
 */
public class SessionStore {

    /** SharedPreferences 文件名，独立于其他缓存 */
    private static final String PREF_NAME = "mingxing_session";
    /** 登录令牌键名，后续请求使用 Bearer 方式携带 */
    private static final String KEY_TOKEN = "token";
    /** 用户唯一 ID 键名 */
    private static final String KEY_USER_ID = "userId";
    /** 用户姓名键名 */
    private static final String KEY_USERNAME = "username";
    /** 是否管理员键名 */
    private static final String KEY_IS_ADMIN = "isAdmin";
    /** 头像相对路径键名，形如 /drive/assets/user/xx.png */
    private static final String KEY_AVATAR = "avatar";

    /** SharedPreferences 实例，真正负责读写磁盘 */
    private final SharedPreferences prefs;

    /**
     * 构造会话存储
     * @param context 任意上下文，内部只取 ApplicationContext，不会持有 Activity 导致内存泄漏
     */
    public SessionStore(Context context) {
        prefs = context.getApplicationContext()
                .getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    /**
     * 保存登录成功后的会话信息
     * @param token 登录令牌
     * @param userId 用户唯一 ID
     * @param username 用户姓名
     * @param isAdmin 是否管理员
     * @param avatar 头像相对路径，可为 null
     */
    public void save(String token, String userId, String username, boolean isAdmin, String avatar) {
        prefs.edit()
                .putString(KEY_TOKEN, token)
                .putString(KEY_USER_ID, userId)
                .putString(KEY_USERNAME, username)
                .putBoolean(KEY_IS_ADMIN, isAdmin)
                .putString(KEY_AVATAR, avatar)
                .apply();
    }

    /**
     * 判断当前是否已登录
     * @return token 非空时返回 true
     */
    public boolean isLoggedIn() {
        String token = prefs.getString(KEY_TOKEN, "");
        return token != null && !token.isEmpty();
    }

    /**
     * 读取当前登录令牌
     * @return 令牌字符串，未登录时返回空串
     */
    public String getToken() {
        return prefs.getString(KEY_TOKEN, "");
    }

    /**
     * 读取当前登录用户姓名
     * @return 姓名字符串，未登录时返回空串
     */
    public String getUsername() {
        return prefs.getString(KEY_USERNAME, "");
    }

    /**
     * 读取当前登录用户唯一 ID
     * @return 用户 ID 字符串，未登录时返回空串
     */
    public String getUserId() {
        return prefs.getString(KEY_USER_ID, "");
    }

    /**
     * 读取当前用户是否为管理员
     * @return 管理员返回 true
     */
    public boolean isAdmin() {
        return prefs.getBoolean(KEY_IS_ADMIN, false);
    }

    /**
     * 读取头像相对路径
     * @return 头像路径，未设置时返回空串
     */
    public String getAvatar() {
        String avatar = prefs.getString(KEY_AVATAR, "");
        // 兼容历史脏数据：早期版本曾把 JSON null 解析成字符串 "null" 存入
        return "null".equals(avatar) ? "" : avatar;
    }

    /**
     * 更新头像相对路径（设置页上传或恢复默认后调用）
     * @param avatar 新的头像路径，空串表示恢复默认头像
     */
    public void updateAvatar(String avatar) {
        prefs.edit().putString(KEY_AVATAR, avatar).apply();
    }

    /**
     * 退出登录：清空全部会话信息
     */
    public void clear() {
        prefs.edit().clear().apply();
    }
}
