package com.mingxing.school.live;

import android.os.Handler;
import android.os.Looper;

import com.mingxing.school.BuildConfig;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 直播 REST 接口：目前只有 /live/api/info（STUN 配置与频道列表）。
 * 说明：手机端（role=app）与观看端都可用该接口；请求参数带 role=app 可跳过主服务的登录/管理员校验，
 *       与网页端手机页一致（见 server/index.js 的 requireLoginForLive）。
 */
public final class LiveApi {

    /** 服务端根地址，例如 http://192.168.0.138 */
    private static final String BASE = BuildConfig.API_BASE_URL;

    /** 单线程池：这些请求很快，串行执行即可 */
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    /** 主线程 Handler：回调统一回到主线程，方便直接更新界面 */
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /**
     * 直播信息：频道列表 + ICE 服务器地址
     */
    public static class LiveInfo {
        /** 频道标识列表，例如 ["ch1","ch2","ch3","ch4"] */
        public List<String> channels = new ArrayList<>();
        /** STUN 服务器地址列表，可为空（局域网 host 候选仍可直连） */
        public List<String> iceUrls = new ArrayList<>();
    }

    /**
     * 请求结果回调（主线程）
     */
    public interface InfoCallback {
        /** 成功 @param info 直播信息 */
        void onSuccess(LiveInfo info);

        /** 失败 @param message 中文原因 */
        void onFailure(String message);
    }

    /**
     * 拉取直播信息
     * @param callback 结果回调
     */
    public static void fetchInfo(InfoCallback callback) {
        EXECUTOR.execute(() -> {
            try {
                // role=app：跳过主播/管理员校验，手机端与观看端都能拿到配置
                String url = BASE + "/live/api/info?role=app";
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    MAIN.post(() -> callback.onFailure("获取直播配置失败（HTTP " + code + "）"));
                    return;
                }
                StringBuilder sb = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream()))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        sb.append(line);
                    }
                }
                LiveInfo info = parse(new JSONObject(sb.toString()));
                MAIN.post(() -> callback.onSuccess(info));
            } catch (Exception e) {
                MAIN.post(() -> callback.onFailure("无法连接直播服务，请检查网络：" + e.getMessage()));
            }
        });
    }

    /**
     * 解析 /api/info 返回体
     * @param root 原始 JSON
     * @return 规整后的直播信息
     */
    private static LiveInfo parse(JSONObject root) {
        LiveInfo info = new LiveInfo();
        JSONArray channels = root.optJSONArray("channels");
        if (channels != null) {
            for (int i = 0; i < channels.length(); i++) {
                String id = channels.optString(i, "");
                if (!id.isEmpty()) {
                    info.channels.add(id);
                }
            }
        }
        // iceServers 形如 [{ urls: ["stun:stun.l.google.com:19302", "..."] }]
        JSONArray servers = root.optJSONArray("iceServers");
        if (servers != null) {
            for (int i = 0; i < servers.length(); i++) {
                JSONObject server = servers.optJSONObject(i);
                JSONArray urls = server == null ? null : server.optJSONArray("urls");
                if (urls != null) {
                    for (int j = 0; j < urls.length(); j++) {
                        String u = urls.optString(j, "");
                        if (!u.isEmpty()) {
                            info.iceUrls.add(u);
                        }
                    }
                }
            }
        }
        return info;
    }

    /**
     * 信令地址（http://host/live/ws）
     * 注意：OkHttp 3.x 的 HttpUrl 只接受 http/https，直接传 ws:// 会抛
     * 「Expected URL scheme 'http' or 'https' but was 'ws'」，因此这里保持 http，
     * 由 OkHttp 在 newWebSocket 时自行完成 WebSocket 升级。
     * @return 信令完整地址
     */
    public static String signalingUrl() {
        return BASE + "/live/ws";
    }
}
