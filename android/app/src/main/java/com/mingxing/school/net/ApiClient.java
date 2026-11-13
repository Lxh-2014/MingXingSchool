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
 * 通用接口客户端：封装 GET / POST / PUT 的 JSON 请求
 * 统一处理基础地址、超时、Bearer 令牌、错误提示与主线程回调，
 * 供设置页等页面复用，避免每个接口重复编写 HttpURLConnection 代码。
 */
public final class ApiClient {

    /** 接口基础地址，取自 app/build.gradle 的 BuildConfig */
    private static final String BASE_URL = BuildConfig.API_BASE_URL;
    /** 连接与读取超时（毫秒） */
    private static final int TIMEOUT_MS = 10_000;
    /** 网络线程池：并发执行多个请求，不阻塞主线程 */
    private static final ExecutorService EXECUTOR = Executors.newFixedThreadPool(2);
    /** 主线程 Handler：把结果从子线程切回 UI 线程 */
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());

    /** 工具类不允许实例化 */
    private ApiClient() {
    }

    /** 请求结果回调，两个方法都在主线程执行 */
    public interface Callback {

        /**
         * 请求成功（HTTP 2xx）
         * @param json 服务端返回的 JSON
         */
        void onSuccess(JSONObject json);

        /**
         * 请求失败
         * @param message 可直接展示给用户的中文提示
         */
        void onFailure(String message);
    }

    /** HTTP 方法枚举 */
    private enum Method { GET, POST, PUT }

    /**
     * 读取接口基础地址，供图片等绝对地址拼接
     * @return 形如 http://192.168.0.138
     */
    public static String baseUrl() {
        return BASE_URL;
    }

    /**
     * 发起 GET 请求
     * @param path 相对路径，如 /api/mail/me
     * @param token 登录令牌，可为空
     * @param cb 结果回调
     */
    public static void get(String path, String token, Callback cb) {
        request(Method.GET, path, null, token, cb);
    }

    /**
     * 发起 POST 请求
     * @param path 相对路径
     * @param body 请求体 JSON，可为空
     * @param token 登录令牌，可为空
     * @param cb 结果回调
     */
    public static void post(String path, JSONObject body, String token, Callback cb) {
        request(Method.POST, path, body, token, cb);
    }

    /**
     * 发起 PUT 请求
     * @param path 相对路径
     * @param body 请求体 JSON，可为空
     * @param token 登录令牌，可为空
     * @param cb 结果回调
     */
    public static void put(String path, JSONObject body, String token, Callback cb) {
        request(Method.PUT, path, body, token, cb);
    }

    /**
     * 发起 PATCH 请求：Android 的 HttpURLConnection 不支持 PATCH 方法，
     * 这里改用 POST 并带 X-HTTP-Method-Override 头，由服务端中间件还原为 PATCH
     * @param path 相对路径
     * @param body 请求体 JSON
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void patch(String path, JSONObject body, String token, Callback cb) {
        request(Method.POST, path, body, token, cb, "PATCH");
    }

    /**
     * 执行一次 JSON 请求（内部在子线程运行）
     * @param method HTTP 方法
     * @param path 相对路径
     * @param body 请求体，GET 时传 null
     * @param token 登录令牌，为空则不携带 Authorization 头
     * @param cb 结果回调
     */
    private static void request(Method method, String path, JSONObject body, String token, Callback cb) {
        request(method, path, body, token, cb, null);
    }

    /**
     * 执行一次 JSON 请求（可覆盖 HTTP 方法）
     * @param method 实际发送的 HTTP 方法
     * @param path 相对路径
     * @param body 请求体，GET 时传 null
     * @param token 登录令牌，为空则不携带 Authorization 头
     * @param cb 结果回调
     * @param overrideMethod 非空时写入 X-HTTP-Method-Override 头（用于 PATCH）
     */
    private static void request(Method method, String path, JSONObject body, String token, Callback cb,
                                String overrideMethod) {
        EXECUTOR.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(BASE_URL + path);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod(method.name());
                if (overrideMethod != null) {
                    conn.setRequestProperty("X-HTTP-Method-Override", overrideMethod);
                }
                conn.setConnectTimeout(TIMEOUT_MS);
                conn.setReadTimeout(TIMEOUT_MS);
                conn.setRequestProperty("Accept", "application/json");
                // 标明这是原生 App，服务端据此区分 WebView 客户端
                conn.setRequestProperty("X-Client-Type", "MingxingSchool-Android");
                // 已登录时携带 Bearer 令牌
                if (token != null && !token.isEmpty()) {
                    conn.setRequestProperty("Authorization", "Bearer " + token);
                }
                // 有请求体时写入 JSON
                if (body != null) {
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                    }
                }

                int code = conn.getResponseCode();
                // 非 2xx 时错误 JSON 在 errorStream 中
                InputStream stream = (code >= 200 && code < 300)
                        ? conn.getInputStream()
                        : conn.getErrorStream();
                String text = readAll(stream);
                JSONObject json = text.isEmpty() ? new JSONObject() : new JSONObject(text);

                // 统一成功判定：HTTP 2xx 且未显式声明失败
                // （商店/主项目用 success:false，邻语用 ok:false + error.message）
                boolean ok = code >= 200 && code < 300
                        && json.optBoolean("success", true)
                        && json.optBoolean("ok", true);
                if (ok) {
                    postSuccess(cb, json);
                } else {
                    String message = json.optString("message", "");
                    // 邻语接口把错误信息放在 error.message 里
                    if (message.isEmpty()) {
                        JSONObject error = json.optJSONObject("error");
                        if (error != null) {
                            message = error.optString("message", "");
                        }
                    }
                    postFailure(cb, message.isEmpty() ? "请求失败（HTTP " + code + "）" : message);
                }
            } catch (Exception e) {
                // 网络不可达、超时、解析失败统一归为网络异常
                postFailure(cb, "网络异常，请检查网络后重试");
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    /**
     * 把成功结果切回主线程回调
     * @param cb 调用方回调
     * @param json 响应 JSON
     */
    private static void postSuccess(Callback cb, JSONObject json) {
        if (cb == null) return;
        MAIN_HANDLER.post(() -> cb.onSuccess(json));
    }

    /**
     * 把失败提示切回主线程回调
     * @param cb 调用方回调
     * @param message 中文错误提示
     */
    private static void postFailure(Callback cb, String message) {
        if (cb == null) return;
        MAIN_HANDLER.post(() -> cb.onFailure(message));
    }

    /**
     * 读取输入流全部字节并按 UTF-8 解码
     * @param in 输入流，可能为 null
     * @return 响应文本，无内容时返回空串
     * @throws Exception 读取失败时抛出
     */
    private static String readAll(InputStream in) throws Exception {
        if (in == null) {
            return "";
        }
        try (InputStream input = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];  // 每次读取的缓冲区
            int len;                         // 本次读取到的字节数
            while ((len = input.read(buffer)) != -1) {
                out.write(buffer, 0, len);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}