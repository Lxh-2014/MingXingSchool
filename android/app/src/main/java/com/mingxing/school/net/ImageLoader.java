package com.mingxing.school.net;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;
import android.widget.ImageView;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 轻量图片加载器：用 HttpURLConnection 下载网络图片并缓存到内存
 * 项目未引入第三方图片库，头像这类少量图片场景用本类足够。
 */
public final class ImageLoader {

    /** 内存缓存：key 为图片地址，value 为已解码位图，按字节数计容量 */
    private static final LruCache<String, Bitmap> CACHE = new LruCache<String, Bitmap>(8 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
            return value.getByteCount();
        }
    };
    /** 下载线程池：并发两张，避免占用过多内存 */
    private static final ExecutorService EXECUTOR = Executors.newFixedThreadPool(2);
    /** 主线程 Handler：把解码结果切回 UI 线程 */
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    /** 网络超时（毫秒） */
    private static final int TIMEOUT_MS = 10_000;

    /** 工具类不允许实例化 */
    private ImageLoader() {
    }

    /**
     * 加载图片到 ImageView：优先命中缓存，未命中则异步下载（不带登录令牌）
     * @param view 目标 ImageView
     * @param url 图片绝对地址，为空时直接显示占位图
     * @param placeholderRes 加载中/失败时显示的占位图资源
     */
    public static void load(ImageView view, String url, int placeholderRes) {
        load(view, url, placeholderRes, null);
    }

    /** 加载结果回调，用于界面提示“头像为什么没出来” */
    public interface ResultCallback {

        /**
         * 加载结束（主线程）
         * @param httpCode 0=地址为空或网络异常；2xx=成功；其它为服务端 HTTP 状态码（404=没有头像）
         */
        void onResult(int httpCode);
    }

    /**
     * 加载受登录保护的图片（如 /drive 下的用户头像）：
     * 服务端对 /drive 静态资源同样启用登录校验，未携带令牌会被重定向到登录页，
     * 结果解码不出位图，表现就是头像一直不显示，因此这里需要显式带上 Bearer 令牌。
     * @param view 目标 ImageView
     * @param url 图片绝对地址，为空时直接显示占位图
     * @param placeholderRes 加载中/失败时显示的占位图资源
     * @param token 登录令牌，可为空；为空时按匿名方式请求
     */
    public static void load(ImageView view, String url, int placeholderRes, String token) {
        load(view, url, placeholderRes, token, null);
    }

    /**
     * 加载受登录保护的图片并回报结果，供界面区分“未设置头像”与“加载失败”
     * @param view 目标 ImageView
     * @param url 图片绝对地址，为空时直接显示占位图
     * @param placeholderRes 加载中/失败时显示的占位图资源
     * @param token 登录令牌，可为空；为空时按匿名方式请求
     * @param callback 结果回调，可为空
     */
    public static void load(ImageView view, String url, int placeholderRes, String token,
                            ResultCallback callback) {
        if (url == null || url.isEmpty()) {
            view.setTag(null);
            view.setImageResource(placeholderRes);
            if (callback != null) {
                callback.onResult(0);
            }
            return;
        }
        // 用 tag 标记当前请求地址，防止列表复用时图片错位
        view.setTag(url);
        Bitmap cached = CACHE.get(url);
        if (cached != null) {
            view.setImageBitmap(cached);
            if (callback != null) {
                callback.onResult(200);
            }
            return;
        }
        view.setImageResource(placeholderRes);
        EXECUTOR.execute(() -> {
            Result result = download(url, token);
            if (result.bitmap != null) {
                CACHE.put(url, result.bitmap);
            }
            MAIN.post(() -> {
                // 仅当该 ImageView 仍在等待这张图时才设置，避免被新请求覆盖后错乱
                if (result.bitmap != null && url.equals(view.getTag())) {
                    view.setImageBitmap(result.bitmap);
                }
                if (callback != null) {
                    callback.onResult(result.code);
                }
            });
        });
    }

    /**
     * 移除指定地址的缓存（头像更新后调用，强制下次重新拉取）
     * @param url 图片绝对地址
     */
    public static void evict(String url) {
        if (url != null) {
            CACHE.remove(url);
        }
    }

    /** 一次下载的结果：HTTP 状态码 + 解码位图 */
    private static class Result {
        /** HTTP 状态码：0=网络异常 */
        int code;
        /** 解码后的位图，失败为 null */
        Bitmap bitmap;
    }

    /**
     * 下载并解码图片
     * @param url 图片绝对地址
     * @param token 登录令牌，非空时同时以 Bearer 与 Cookie 方式携带
     * @return 下载结果（含状态码，便于界面提示失败原因）
     */
    private static Result download(String url, String token) {
        Result result = new Result();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            if (token != null && !token.isEmpty()) {
                // 头像等资源位于受登录保护的 /drive 路径下，必须携带令牌；
                // 同时用 Bearer 与 Cookie 两种方式，任一被服务端识别即可通过校验
                conn.setRequestProperty("Authorization", "Bearer " + token);
                conn.setRequestProperty("Cookie", "token=" + token);
            }
            conn.setInstanceFollowRedirects(false);   // 不跟随重定向：302 本身就能说明登录失效
            result.code = conn.getResponseCode();
            if (result.code < 200 || result.code >= 300) {
                return result;
            }
            try (InputStream in = conn.getInputStream()) {
                result.bitmap = BitmapFactory.decodeStream(in);
            }
        } catch (Exception e) {
            result.code = 0;                          // 网络异常：连接超时/域名不可达等
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
        return result;
    }
}