package com.mingxing.school.live;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * WebSocket 信令客户端：与网页端共用同一套消息协议（见 apps/live/server.js）。
 *
 * 观看端流程：viewer:join → viewer:joined → 收到 host 的 signal(offer) → 回 viewer:signal(answer/候选)
 * 手机端流程：app:join(token) → app:joined → 收到 host 的 signal(offer) → 回 app:signal(answer/候选)
 *
 * 说明：连接地址使用 http(s) 并由 OkHttp 自动升级为 WebSocket；
 *       OkHttp 3.x 的 HttpUrl 不支持 ws:// 前缀，传 ws:// 会直接抛 IllegalArgumentException。
 */
public class LiveSignaling {

    /** 主线程 Handler：所有回调切回主线程，方便更新界面 */
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** 共用的 OkHttp 客户端（内部维持连接池与线程） */
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .connectTimeout(8, java.util.concurrent.TimeUnit.SECONDS)
            .build();

    /** 消息回调接口（均在主线程触发） */
    public interface Listener {
        /** WebSocket 已建立，可开始发送 join 消息 */
        void onOpen();

        /** 收到一条 JSON 消息 */
        void onMessage(JSONObject message);

        /** 连接关闭或被服务端拒绝 */
        void onClosed(String reason);

        /** 连接失败（网络问题等） */
        void onFailure(String message);
    }

    /** 底层 WebSocket 句柄 */
    private WebSocket socket;
    /** 业务回调 */
    private final Listener listener;
    /** 是否已主动关闭（避免主动关闭后仍回调 onClosed 干扰界面） */
    private boolean closing;

    /**
     * 构造并立即连接信令服务器
     * @param listener 消息回调
     */
    public LiveSignaling(Listener listener) {
        this.listener = listener;
        Request request = new Request.Builder()
                .url(LiveApi.signalingUrl())
                .build();
        socket = CLIENT.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                MAIN.post(() -> listener.onOpen());
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                JSONObject json;
                try {
                    json = new JSONObject(text);
                } catch (Exception e) {
                    return;   // 非 JSON 消息直接忽略
                }
                MAIN.post(() -> listener.onMessage(json));
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                if (closing) {
                    return;
                }
                MAIN.post(() -> listener.onClosed(reason == null || reason.isEmpty()
                        ? "连接已关闭" : reason));
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (closing) {
                    return;
                }
                String msg = t == null ? "网络异常" : t.getMessage();
                MAIN.post(() -> listener.onFailure(msg == null ? "网络异常" : msg));
            }
        });
    }

    /**
     * 发送一条 JSON 消息
     * @param message 消息体
     * @return 是否已提交到发送队列
     */
    public boolean send(JSONObject message) {
        WebSocket ws = socket;
        if (ws == null) {
            return false;
        }
        try {
            return ws.send(message.toString());
        } catch (Throwable t) {
            // 连接已断开时 OkHttp 会抛 IOException（not connected）。
            // 该方法可能被 WebRTC 原生线程回调（如 ICE 候选上报）调用，
            // 异常一旦从 JNI 回调逃逸到原生层，进程会被直接中止，表现为无 Java 堆栈的原生崩溃，
            // 因此这里必须整体兜住，只当作“发送失败”处理。
            return false;
        }
    }

    /** 主动关闭连接（页面退出时调用） */
    public void close() {
        closing = true;
        WebSocket ws = socket;
        socket = null;
        if (ws != null) {
            ws.close(1000, "leave");
        }
    }
}
