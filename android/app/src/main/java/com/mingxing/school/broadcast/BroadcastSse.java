package com.mingxing.school.broadcast;

import android.os.Handler;
import android.os.Looper;

import com.mingxing.school.BuildConfig;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 广播器 SSE（Server-Sent Events）订阅器。
 * 服务端推送三类事件：
 *   snapshot —— 状态对齐（连接建立即推一次）
 *   command  —— 实时指令（play / pause / resume / stop，含 seq）
 *   error    —— 错误广播
 * 断线后按 3 秒间隔自动重连，连接状态通过回调通知界面。
 */
public final class BroadcastSse {

    /** 接口根地址：主服务地址 + /broadcast */
    private static final String BASE = BuildConfig.API_BASE_URL + "/broadcast";
    /** 连接超时（毫秒） */
    private static final int CONNECT_TIMEOUT_MS = 8_000;
    /** 读取超时（毫秒）：服务端每 20 秒发心跳，留足余量用于发现断线 */
    private static final int READ_TIMEOUT_MS = 90_000;
    /** 断线重连间隔（毫秒） */
    private static final long RECONNECT_DELAY_MS = 3_000;
    /** 单线程执行器：SSE 是长连接，独占一个线程 */
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    /** 主线程 Handler：事件解析完切回 UI 线程回调 */
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** 事件监听器，所有回调都在主线程执行 */
    public interface Listener {

        /**
         * 收到一条服务端事件
         * @param type 事件名：snapshot / command / error
         * @param data 事件数据原文（JSON 字符串，可能是对象或数组）
         */
        void onEvent(String type, String data);

        /**
         * 连接状态变化
         * @param connected true 表示已连上，false 表示断开（随后会自动重连）
         */
        void onConnection(boolean connected);
    }

    /** 订阅路径，如 /api/events 或 /api/channels/classroom/events */
    private final String path;
    /** 事件监听器 */
    private final Listener listener;
    /** 登录令牌 */
    private final String token;
    /** 是否已请求停止：停止后线程不再重连 */
    private final AtomicBoolean stopped = new AtomicBoolean(false);
    /** 当前连接句柄，停止时用于主动断开 */
    private volatile HttpURLConnection connection;

    /**
     * 构造订阅器
     * @param path 相对 /broadcast 的 SSE 路径
     * @param token 登录令牌
     * @param listener 事件监听器
     */
    public BroadcastSse(String path, String token, Listener listener) {
        this.path = path;
        this.token = token;
        this.listener = listener;
    }

    /** 开始订阅（立即返回，连接在后台线程建立） */
    public void start() {
        EXECUTOR.execute(this::loop);
    }

    /** 停止订阅：置停止标记并断开当前连接，不再重连 */
    public void stop() {
        stopped.set(true);
        HttpURLConnection conn = connection;
        if (conn != null) {
            try {
                conn.disconnect();
            } catch (Exception ignored) {
                // 连接已断开时 disconnect 可能抛异常，忽略即可
            }
        }
    }

    /**
     * 连接主循环：连上 → 读取事件 → 断开 → 等待 → 重连，直到被停止
     */
    private void loop() {
        while (!stopped.get()) {
            try {
                connectOnce();
            } catch (Exception e) {
                // 任何异常都视为连接断开，走统一的重连流程
            }
            if (stopped.get()) {
                break;
            }
            notifyConnection(false);
            try {
                Thread.sleep(RECONNECT_DELAY_MS);
            } catch (InterruptedException e) {
                // 线程被中断说明要退出，结束循环
                Thread.currentThread().interrupt();
                break;
            }
        }
        notifyConnection(false);
    }

    /**
     * 建立一次连接并持续读取事件，直到服务端关闭或出现异常
     * @throws Exception 网络异常、读取中断等
     */
    private void connectOnce() throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(BASE + path).openConnection();
        connection = conn;
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestProperty("Accept", "text/event-stream");
        conn.setRequestProperty("Cache-Control", "no-cache");
        conn.setRequestProperty("X-Client-Type", "MingxingSchool-Android");
        if (token != null && !token.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + token);
        }

        int code = conn.getResponseCode();
        if (code != 200) {
            // 非 200（如 401）不进入读循环，直接走重连
            throw new IllegalStateException("SSE 连接失败，HTTP " + code);
        }
        notifyConnection(true);

        // 事件名与数据在空行处成对提交
        String eventType = "message";   // 当前事件名，默认按 SSE 规范是 message
        StringBuilder data = new StringBuilder();  // 当前事件的数据（多行 data 需拼接）

        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while (!stopped.get() && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    // 空行 = 一条事件结束，派发后重置
                    if (data.length() > 0) {
                        dispatch(eventType, data.toString());
                    }
                    eventType = "message";
                    data.setLength(0);
                    continue;
                }
                if (line.startsWith(":")) {
                    // 心跳注释行（": ping"），忽略
                    continue;
                }
                if (line.startsWith("event:")) {
                    eventType = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    if (data.length() > 0) {
                        data.append('\n');
                    }
                    data.append(line.substring(5).trim());
                }
                // retry: 等其它字段忽略，重连间隔由本地常量控制
            }
        } finally {
            conn.disconnect();
            connection = null;
        }
    }

    /**
     * 把事件切回主线程派发
     * @param type 事件名
     * @param payload 事件数据原文
     */
    private void dispatch(String type, String payload) {
        MAIN.post(() -> {
            if (!stopped.get()) {
                listener.onEvent(type, payload);
            }
        });
    }

    /**
     * 把连接状态变化切回主线程通知
     * @param connected 是否已连接
     */
    private void notifyConnection(boolean connected) {
        MAIN.post(() -> listener.onConnection(connected));
    }
}