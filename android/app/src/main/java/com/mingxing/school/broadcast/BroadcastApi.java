package com.mingxing.school.broadcast;

import android.os.Handler;
import android.os.Looper;

import com.mingxing.school.BuildConfig;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 广播器接口客户端。
 * 广播器挂载在服务端 /broadcast 下，响应体格式为：
 * 成功 {ok:true, data:...}，失败 {ok:false, error:{code,message}}，
 * 与主站 {success:true} 不同，因此单独封装解析，避免与 ApiClient 混淆。
 */
public final class BroadcastApi {

    /** 接口根地址：主服务地址 + /broadcast */
    private static final String BASE = BuildConfig.API_BASE_URL + "/broadcast";
    /** 连接超时（毫秒） */
    private static final int CONNECT_TIMEOUT_MS = 8_000;
    /** 读取超时（毫秒）：普通接口较快，无需长等待 */
    private static final int READ_TIMEOUT_MS = 10_000;
    /** 网络线程池：2 条线程足以应付控制台的并发请求 */
    private static final ExecutorService EXECUTOR = Executors.newFixedThreadPool(2);
    /** 主线程 Handler：把结果切回 UI 线程回调 */
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** 工具类不允许实例化 */
    private BroadcastApi() {
    }

    /** 请求结果回调，两个方法都在主线程执行 */
    public interface Callback {

        /**
         * 请求成功
         * @param root 服务端完整响应，业务数据在 data 字段（可能是对象或数组）
         */
        void onSuccess(JSONObject root);

        /**
         * 请求失败
         * @param message 可直接展示的中文提示
         */
        void onFailure(String message);
    }

    /**
     * 拼接音频播放地址
     * @param file 音频文件名（含扩展名，可能是中文）
     * @return 形如 http://ip/broadcast/audio/上课铃.mp3 的完整地址
     */
    public static String audioUrl(String file) {
        return BASE + "/audio/" + urlEncode(file);
    }

    /**
     * 查询四个频道的当前状态
     * @param token 登录令牌
     * @param cb 结果回调，data 为频道状态数组
     */
    public static void getChannels(String token, Callback cb) {
        request("GET", "/api/channels", null, token, cb);
    }

    /**
     * 查询音频列表（每次请求都会重新扫描 audio 目录）
     * @param token 登录令牌
     * @param cb 结果回调，data 为 {list:[...]}
     */
    public static void getAudios(String token, Callback cb) {
        request("GET", "/api/audio", null, token, cb);
    }

    /**
     * 重新扫描音频目录（等价于再查一次列表，语义更明确）
     * @param token 登录令牌
     * @param cb 结果回调
     */
    public static void rescanAudios(String token, Callback cb) {
        request("POST", "/api/audio/rescan", new JSONObject(), token, cb);
    }

    /**
     * 向频道投放音频并从头播放
     * @param channelId 频道 id（英文 key，如 classroom）
     * @param audioId 音频 id
     * @param token 登录令牌
     * @param cb 结果回调，data 为频道最新状态
     */
    public static void play(String channelId, String audioId, String token, Callback cb) {
        JSONObject body = new JSONObject();
        try {
            body.put("audioId", audioId);
        } catch (Exception ignored) {
            // JSONObject.put 对字符串不会抛异常，此处仅作防御
        }
        request("POST", "/api/channels/" + urlEncode(channelId) + "/play", body, token, cb);
    }

    /**
     * 频道控制动作：pause / resume / stop（服务端均为幂等）
     * @param channelId 频道 id
     * @param action 动作名：pause、resume、stop
     * @param token 登录令牌
     * @param cb 结果回调，data 为频道最新状态
     */
    public static void channelAction(String channelId, String action, String token, Callback cb) {
        request("POST", "/api/channels/" + urlEncode(channelId) + "/" + action,
                new JSONObject(), token, cb);
    }

    /**
     * 跳转播放进度
     * @param channelId 频道 id
     * @param positionSec 目标位置（秒）
     * @param token 登录令牌
     * @param cb 结果回调，data 为频道最新状态
     */
    public static void seek(String channelId, double positionSec, String token, Callback cb) {
        JSONObject body = new JSONObject();
        try {
            body.put("positionSec", positionSec);
        } catch (Exception ignored) {
            // 数值写入同样不会抛异常
        }
        request("POST", "/api/channels/" + urlEncode(channelId) + "/seek", body, token, cb);
    }

    /**
     * 上报音频总时长，供其他听众显示进度百分比
     * @param channelId 频道 id
     * @param durationSec 音频总时长（秒）
     * @param token 登录令牌
     */
    public static void reportDuration(String channelId, double durationSec, String token) {
        JSONObject body = new JSONObject();
        try {
            body.put("durationSec", durationSec);
        } catch (Exception ignored) {
            // 数值写入不会抛异常
        }
        // 静默上报，不关心结果，失败也不打扰用户
        request("POST", "/api/channels/" + urlEncode(channelId) + "/duration",
                body, token, new Callback() {
                    @Override
                    public void onSuccess(JSONObject root) {
                    }

                    @Override
                    public void onFailure(String message) {
                    }
                });
    }

    /**
     * 执行一次 JSON 请求（内部在子线程运行）
     * @param method HTTP 方法
     * @param path 相对 /broadcast 的路径
     * @param body 请求体，GET 时传 null
     * @param token 登录令牌，为空则不携带 Authorization 头
     * @param cb 结果回调
     */
    private static void request(String method, String path, JSONObject body, String token, Callback cb) {
        EXECUTOR.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(BASE + path).openConnection();
                conn.setRequestMethod(method);
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setRequestProperty("Accept", "application/json");
                conn.setRequestProperty("X-Client-Type", "MingxingSchool-Android");
                if (token != null && !token.isEmpty()) {
                    conn.setRequestProperty("Authorization", "Bearer " + token);
                }
                if (body != null) {
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                    }
                }

                int code = conn.getResponseCode();
                InputStream stream = (code >= 200 && code < 300)
                        ? conn.getInputStream()
                        : conn.getErrorStream();
                String text = readAll(stream);
                JSONObject json = text.isEmpty() ? new JSONObject() : new JSONObject(text);

                boolean ok = code >= 200 && code < 300 && json.optBoolean("ok", false);
                if (ok) {
                    postSuccess(cb, json);
                } else {
                    postFailure(cb, extractError(json, code));
                }
            } catch (Exception e) {
                // 连接失败、超时、JSON 解析失败统一归为网络异常
                postFailure(cb, "网络异常，请检查网络后重试");
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    /**
     * 从失败响应中提取中文错误提示
     * @param json 响应 JSON
     * @param code HTTP 状态码
     * @return 优先取 error.message，缺失时按状态码兜底
     */
    private static String extractError(JSONObject json, int code) {
        JSONObject error = json.optJSONObject("error");
        String message = error == null ? "" : error.optString("message", "");
        if (!message.isEmpty()) {
            return message;
        }
        if (code == 401) {
            return "登录已过期，请重新登录";
        }
        return "请求失败（HTTP " + code + "）";
    }

    /**
     * 把成功结果切回主线程回调
     * @param cb 调用方回调
     * @param json 响应 JSON
     */
    private static void postSuccess(Callback cb, JSONObject json) {
        MAIN.post(() -> cb.onSuccess(json));
    }

    /**
     * 把失败提示切回主线程回调
     * @param cb 调用方回调
     * @param message 中文错误提示
     */
    private static void postFailure(Callback cb, String message) {
        MAIN.post(() -> cb.onFailure(message));
    }

    /**
     * 对路径片段做 URL 编码（频道 id、音频文件名可能是中文）
     * @param raw 原始文本
     * @return 编码后的文本，编码失败时返回原值
     */
    private static String urlEncode(String raw) {
        try {
            // URLEncoder 会把空格编码成 +，路径中应还原为 %20
            return URLEncoder.encode(raw, StandardCharsets.UTF_8.name()).replace("+", "%20");
        } catch (Exception e) {
            return raw;
        }
    }

    /**
     * 读取输入流全部内容并按 UTF-8 解码
     * @param in 输入流，可能为 null
     * @return 响应文本
     * @throws Exception 读取失败时抛出
     */
    private static String readAll(InputStream in) throws Exception {
        if (in == null) {
            return "";
        }
        try (InputStream input = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];  // 读取缓冲区
            int len;                         // 单次读取字节数
            while ((len = input.read(buffer)) != -1) {
                out.write(buffer, 0, len);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}