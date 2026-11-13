package com.mingxing.school.net;

import android.os.Handler;
import android.os.Looper;

import com.mingxing.school.BuildConfig;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 认证接口封装：目前实现统一登录 POST /api/auth/login
 * 为减少依赖，使用 HttpURLConnection + SDK 内置 org.json，不引入第三方网络库；
 * 所有回调都会切回主线程，调用方可以直接更新 UI。
 */
public final class AuthApi {

    /** 接口基础地址，取自 app/build.gradle 的 BuildConfig.API_BASE_URL */
    private static final String BASE_URL = BuildConfig.API_BASE_URL;
    /** 网络超时时间（毫秒）：连接与读取都使用该值 */
    private static final int TIMEOUT_MS = 10_000;
    /** 单线程池：登录请求串行执行，避免用户连点造成并发登录 */
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    /** 主线程 Handler：把网络结果从子线程切回 UI 线程 */
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    /** 最近一次登录拿到的令牌，后续接口可作为 Bearer 令牌使用 */
    private static String sToken;

    /** 工具类不允许实例化 */
    private AuthApi() {
    }

    /** 登录结果回调，两个方法都在主线程执行 */
    public interface LoginCallback {

        /**
         * 登录成功
         * @param result 服务端返回的会话信息
         */
        void onSuccess(LoginResult result);

        /**
         * 登录失败
         * @param message 可直接展示给用户的中文提示
         */
        void onFailure(String message);
    }

    /** 登录成功后的会话数据 */
    public static final class LoginResult {
        /** 登录令牌，后续接口放在 Authorization 头中 */
        public final String token;
        /** 用户唯一 ID */
        public final String userId;
        /** 用户姓名（登录名） */
        public final String username;
        /** 是否管理员 */
        public final boolean isAdmin;
        /** 头像相对路径，未设置头像时为 null */
        public final String avatar;

        /**
         * 构造登录结果
         * @param token 登录令牌
         * @param userId 用户唯一 ID
         * @param username 用户姓名
         * @param isAdmin 是否管理员
         * @param avatar 头像相对路径
         */
        public LoginResult(String token, String userId, String username, boolean isAdmin, String avatar) {
            this.token = token;
            this.userId = userId;
            this.username = username;
            this.isAdmin = isAdmin;
            this.avatar = avatar;
        }
    }

    /**
     * 发起登录请求
     * @param username 姓名
     * @param password 学号
     * @param callback 结果回调，运行在主线程
     */
    public static void login(String username, String password, LoginCallback callback) {
        EXECUTOR.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(BASE_URL + "/api/auth/login");
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(TIMEOUT_MS);
                conn.setReadTimeout(TIMEOUT_MS);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                conn.setRequestProperty("Accept", "application/json");
                // 标明这是原生 App：服务端据此不会把本客户端当作 WebView（WebView 禁止登录管理员）
                conn.setRequestProperty("X-Client-Type", "MingxingSchool-Android");

                // 请求体：与服务端 /api/auth/login 约定的字段一致
                JSONObject body = new JSONObject();
                body.put("username", username);
                body.put("password", password);

                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }

                int code = conn.getResponseCode();
                // 非 2xx 时错误 JSON 在 errorStream 中，需要分开读取
                InputStream stream = (code >= 200 && code < 300)
                        ? conn.getInputStream()
                        : conn.getErrorStream();
                String text = readAll(stream);
                JSONObject json = text.isEmpty() ? new JSONObject() : new JSONObject(text);

                if (code == HttpURLConnection.HTTP_OK && json.optBoolean("success")) {
                    String token = json.optString("token", "");
                    sToken = token;
                    // 服务端未设置头像时返回 JSON null，org.json 的 optString 会得到字符串 "null"，
                    // 这里显式归一为空串，避免后续拼出无效的图片地址
                    String avatar = json.isNull("avatar") ? "" : json.optString("avatar", "");
                    LoginResult result = new LoginResult(
                            token,
                            json.optString("userId", ""),
                            json.optString("username", username),
                            json.optBoolean("isAdmin", false),
                            avatar
                    );
                    postSuccess(callback, result);
                } else {
                    // 优先使用服务端返回的中文提示，缺失时给出兜底文案
                    String message = json.optString("message", "");
                    postFailure(callback, message.isEmpty() ? "登录失败（HTTP " + code + "）" : message);
                }
            } catch (Exception e) {
                // 网络不可达、超时、JSON 解析失败等都归为网络异常，避免把堆栈暴露给用户
                postFailure(callback, "网络异常，请检查网络后重试");
            } finally {
                // 及时断开连接，释放底层套接字
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    /**
     * 读取当前登录令牌
     * @return 登录成功后的令牌，未登录时返回空串
     */
    public static String getToken() {
        return sToken == null ? "" : sToken;
    }

    /**
     * 把成功结果切回主线程回调
     * @param callback 调用方回调
     * @param result 登录结果
     */
    private static void postSuccess(LoginCallback callback, LoginResult result) {
        MAIN_HANDLER.post(() -> callback.onSuccess(result));
    }

    /**
     * 把失败提示切回主线程回调
     * @param callback 调用方回调
     * @param message 中文错误提示
     */
    private static void postFailure(LoginCallback callback, String message) {
        MAIN_HANDLER.post(() -> callback.onFailure(message));
    }

    /**
     * 读取输入流全部字节并按 UTF-8 解码
     * @param in 输入流，可能为 null（服务端没有响应体）
     * @return 响应文本，无内容时返回空串
     * @throws Exception 读取过程出错时抛出，由调用方统一处理
     */
    private static String readAll(InputStream in) throws Exception {
        if (in == null) {
            return "";
        }
        try (InputStream input = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];  // 每次读取的缓冲区
            int len;                         // 本次实际读取到的字节数
            while ((len = input.read(buffer)) != -1) {
                out.write(buffer, 0, len);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
