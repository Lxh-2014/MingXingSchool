package com.mingxing.school.im;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.mingxing.school.BaseActivity;
import com.mingxing.school.BuildConfig;
import com.mingxing.school.R;
import com.mingxing.school.data.SessionStore;
import com.mingxing.school.net.ApiClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Locale;

/**
 * 邻语（IM）页面：使用 WebView 承载 assets/im/index.html
 * ----------------------------------------------------------
 * 设计要点：
 *   1. 页面由 H5 重新实现（不含网页版顶栏/底栏），原生只提供容器与能力桥；
 *   2. 页面地址借用服务端同源路径 /im/app/，由 shouldInterceptRequest 直接返回本地 assets，
 *      这样 fetch 请求与接口同源，不需要服务端开放跨域；
 *   3. 原生桥 ImBridge 提供登录令牌、服务端地址、当前用户 ID，以及文件下载与轻提示；
 *   4. 返回键先交给 H5（图片预览 / 聊天 / 会话列表逐级返回），未处理时才退出页面；
 *   5. 文件下载走系统 DownloadManager（带 Authorization 头），下载到「下载/邻语」目录。
 */
public class ImActivity extends BaseActivity {

    /** 通知点击时携带的会话 ID */
    public static final String EXTRA_CONV_ID = "extra_conv_id";
    /** 通知点击时携带的会话标题 */
    public static final String EXTRA_CONV_TITLE = "extra_conv_title";
    /** 通知点击时携带的「是否群聊」标记 */
    public static final String EXTRA_CONV_GROUP = "extra_conv_group";

    /** 页面在服务端上的伪路径前缀（实际内容来自本地 assets，由请求拦截返回） */
    private static final String PAGE_PATH = "/im/app/";

    /** 表情图片路径前缀（服务端要求登录，需原生带令牌代理） */
    private static final String EMOJI_PATH = "/im/emoji/";

    /** 当前正在查看的会话 ID（volatile：由 JS 线程写入、通知服务线程读取） */
    private static volatile String viewingConvId;
    /** 邻语页面是否处于前台（切到后台后需要正常弹出消息通知） */
    private static volatile boolean foreground;

    /** H5 页面容器 */
    private WebView webView;
    /** 会话存储：提供登录令牌与当前用户 ID */
    private SessionStore session;
    /** H5 页面内容字节（只读一次，拦截请求时复用） */
    private byte[] pageBytes;
    /** H5 是否已完成加载（决定通知带来的会话是否可以立即投递） */
    private boolean pageReady;
    /** 表情图片缓存：地址 → 二进制（表情是静态图片，复用避免重复请求） */
    private final android.util.LruCache<String, byte[]> emojiCache =
            new android.util.LruCache<String, byte[]>(12 * 1024 * 1024) {
                @Override
                protected int sizeOf(String key, byte[] value) {
                    return value.length;
                }
            };
    /** 等待保存的下载任务（旧系统缺少存储权限时暂存，授权后继续） */
    private PendingDownload pendingDownload;
    /** 文件选择回调（H5 的 input[type=file] 走系统选择器） */
    private ValueCallback<Uri[]> pendingFileCallback;
    /** 系统文件选择器启动器 */
    private ActivityResultLauncher<Intent> fileChooserLauncher;
    /** 存储权限申请启动器（仅 Android 10 以下需要） */
    private ActivityResultLauncher<String> storagePermissionLauncher;

    /**
     * 下载任务暂存结构
     */
    private static final class PendingDownload {
        /** 文件下载地址（相对或绝对） */
        final String url;
        /** 保存到本地的文件名 */
        final String name;

        PendingDownload(String url, String name) {
            this.url = url;
            this.name = name;
        }
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        session = new SessionStore(this);

        // 状态栏/导航栏底色与 H5 顶栏、底部输入区一致，避免出现色带
        setStatusBarColor(R.color.mx_surface);
        setNavigationBarColor(R.color.mx_surface);

        // 根容器：承载 WebView，并统一让出系统栏安全区
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.mx_surface));
        setContentView(root);
        root.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        registerLaunchers();
        createWebView(root);
        applyBarsAndImeInsets(root);

        // 返回键交给 H5 逐级处理
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                dispatchBackToPage();
            }
        });

        requestNotificationPermission();
        loadPage();
    }

    /**
     * 注册文件选择与存储权限的启动器（必须在页面进入 STARTED 之前完成）
     */
    private void registerLaunchers() {
        fileChooserLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(), result -> {
                    ValueCallback<Uri[]> callback = pendingFileCallback;
                    pendingFileCallback = null;
                    if (callback == null) {
                        return;
                    }
                    callback.onReceiveValue(pickUrisFrom(result.getResultCode(), result.getData()));
                });

        storagePermissionLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestPermission(), granted -> {
                    PendingDownload task = pendingDownload;
                    pendingDownload = null;
                    if (task == null) {
                        return;
                    }
                    if (granted) {
                        enqueueDownload(task.url, task.name);
                    } else {
                        toast("没有存储权限，无法保存文件");
                    }
                });
    }

    /**
     * 创建并配置 WebView
     * @param root 页面根容器
     */
    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView(FrameLayout root) {
        webView = new WebView(this);
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.mx_surface));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);              // H5 页面全部逻辑依赖 JS
        settings.setDomStorageEnabled(true);              // 允许 localStorage/sessionStorage
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);                // 按 viewport meta 渲染，适配手机宽度
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);                   // 禁用双击缩放，避免误触放大
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setTextZoom(100);                        // 固定字号缩放，避免系统字体放大挤坏布局
        // 混合内容：页面与服务端同源（均为 http），保留默认兼容策略以防后续切 https
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // 页面配色固定为浅色，禁止系统深色模式对其做算法压暗
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            settings.setAlgorithmicDarkeningAllowed(false);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        }

        if (BuildConfig.DEBUG) {
            // 仅调试包开启远程调试，方便用 Chrome 检查 H5 页面
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.addJavascriptInterface(new Bridge(), "ImBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // 页面本体放在服务端同源路径下，实际内容由本地 assets 提供
                String url = request.getUrl().toString();
                if (!request.getMethod().equalsIgnoreCase("GET")) {
                    return super.shouldInterceptRequest(view, request);
                }
                if (url.startsWith(ApiClient.baseUrl() + PAGE_PATH)) {
                    return pageResponse();
                }
                // 表情图片位于登录守卫下的 /im/emoji，<img> 无法携带令牌，由原生代理补齐
                if (url.startsWith(ApiClient.baseUrl() + EMOJI_PATH)) {
                    return emojiResponse(url);
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleExternalUrl(request.getUrl().toString());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                dispatchConvToPage(getIntent());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                // 只关心主文档失败；子资源失败不打扰用户
                if (!request.isForMainFrame()) {
                    return;
                }
                toast("页面加载失败：" + error.getDescription());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // 上一次选择未结束时先释放旧回调，避免内存泄漏
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                    pendingFileCallback = null;
                }
                pendingFileCallback = callback;
                try {
                    fileChooserLauncher.launch(params.createIntent());
                    return true;
                } catch (Exception e) {
                    // 部分机型没有文件选择器时直接回调空值，避免 H5 一直等待
                    pendingFileCallback = null;
                    callback.onReceiveValue(null);
                    toast("没有可用的文件选择器");
                    return false;
                }
            }
        });

        // 页面内直接指向文件（非 blob 图片）时同样走系统下载
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                startDownload(url, nameFromUrl(url, contentDisposition)));

        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    /**
     * 给根容器补齐安全区：顶部让出状态栏，底部取「导航条高度 / 键盘高度」的较大值。
     * 页面采用 edge-to-edge（BaseActivity 已关闭 decorFitsSystemWindows），
     * 若只让出导航条，键盘弹出时会盖住输入框，因此这里把输入法区域也算进底部留白。
     * @param root 页面根容器
     */
    private void applyBarsAndImeInsets(View root) {
        // 记录原有 padding，避免覆盖布局里写死的留白
        final int baseLeft = root.getPaddingLeft();
        final int baseTop = root.getPaddingTop();
        final int baseRight = root.getPaddingRight();
        final int baseBottom = root.getPaddingBottom();

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());   // 状态栏 + 导航条
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());           // 输入法区域
            v.setPadding(baseLeft, baseTop + bars.top, baseRight,
                    baseBottom + Math.max(bars.bottom, ime.bottom));
            return insets;
        });
    }

    /**
     * 加载 H5 页面：优先使用拦截方式，页面 origin 即服务端地址，接口请求同源
     */
    private void loadPage() {
        pageReady = false;
        webView.loadUrl(ApiClient.baseUrl() + PAGE_PATH);
    }

    /**
     * 读取 assets 中的 H5 页面内容（只读一次并缓存）
     * @return 页面字节数组
     */
    private byte[] pageBytes() {
        if (pageBytes != null) {
            return pageBytes;
        }
        try (InputStream in = getAssets().open("im/index.html");
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];       // 分块读取缓冲区
            int len;                              // 本次读取到的字节数
            while ((len = in.read(buffer)) != -1) {
                out.write(buffer, 0, len);
            }
            pageBytes = out.toByteArray();
        } catch (Exception e) {
            pageBytes = new byte[0];
            toast("页面资源缺失：" + e.getMessage());
        }
        return pageBytes;
    }

    /**
     * 构造 H5 页面的响应（保持同源域名，此响应不需要网络）
     * @return WebView 可直接渲染的 HTML 响应
     */
    private WebResourceResponse pageResponse() {
        WebResourceResponse response = new WebResourceResponse(
                "text/html", "UTF-8", new ByteArrayInputStream(pageBytes()));   // 本地页面内容
        // 禁用缓存，保证 assets 更新后立即生效
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Cache-Control", "no-store");
        response.setResponseHeaders(headers);
        return response;
    }

    /**
     * 代理加载表情图片：WebView 的 img 请求不带 Authorization，
     * 这里由原生补上登录令牌后再返回图片数据。
     * @param url 表情图片完整地址
     * @return 图片响应；失败时返回 404（页面显示为未加载，不影响其它内容）
     */
    private WebResourceResponse emojiResponse(String url) {
        byte[] data = emojiCache.get(url);
        if (data == null) {
            data = fetchBytes(url);
            if (data != null) {
                emojiCache.put(url, data);
            }
        }
        if (data == null) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                    new java.util.HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
        }
        return new WebResourceResponse("image/png", null, new ByteArrayInputStream(data));
    }

    /**
     * 带登录令牌请求二进制内容（在 WebView 的请求线程执行，可同步阻塞）
     * @param url 目标地址
     * @return 响应字节；网络异常或非 200 时返回 null
     */
    private byte[] fetchBytes(String url) {
        java.net.HttpURLConnection conn = null;
        try {
            conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            String token = session.getToken();
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            if (conn.getResponseCode() != 200) {
                return null;
            }
            try (InputStream in = conn.getInputStream();
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];      // 分块读取缓冲区
                int len;                             // 本次读取长度
                while ((len = in.read(buffer)) != -1) {
                    out.write(buffer, 0, len);
                }
                return out.toByteArray();
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /**
     * 处理外部链接：站内地址交给 WebView，站外地址用系统浏览器打开
     * @param url 目标地址
     * @return true=已由本方法消费
     */
    private boolean handleExternalUrl(String url) {
        if (url == null) {
            return true;
        }
        if (url.startsWith(ApiClient.baseUrl())) {
            return false;   // 站内页面继续在 WebView 内打开
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            toast("没有可打开该链接的应用");
        }
        return true;
    }

    /**
     * 把通知带来的会话投递给 H5（页面尚未加载完成时先不处理，加载完成后会再调用一次）
     * @param intent 当前页面意图
     */
    private void dispatchConvToPage(Intent intent) {
        if (!pageReady || intent == null) {
            return;
        }
        String convId = intent.getStringExtra(EXTRA_CONV_ID);
        if (convId == null || convId.isEmpty()) {
            return;
        }
        String title = intent.getStringExtra(EXTRA_CONV_TITLE);
        boolean isGroup = intent.getBooleanExtra(EXTRA_CONV_GROUP, false);
        // 消费一次，避免从后台恢复时重复打开
        intent.removeExtra(EXTRA_CONV_ID);
        intent.removeExtra(EXTRA_CONV_TITLE);
        intent.removeExtra(EXTRA_CONV_GROUP);
        callJs("window.imOpenConv && window.imOpenConv(" + JSONObject.quote(convId) + ","
                + JSONObject.quote(title == null ? "" : title) + "," + isGroup + ")");
    }

    /**
     * 通知点击且页面已存在时（singleTop）切换到对应会话
     * @param intent 新的页面意图
     */
    @Override
    protected void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        dispatchConvToPage(intent);
    }

    /**
     * 返回键：先问 H5 是否处理（图片预览 / 聊天 / 会话列表），未处理则退出
     */
    private void dispatchBackToPage() {
        if (webView == null || !pageReady) {
            finish();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!window.imHandleBack&&window.imHandleBack();}catch(e){return false;}})()",
                value -> {
                    boolean handled = value != null && value.contains("true");
                    if (!handled && !isFinishing()) {
                        finish();
                    }
                });
    }

    /**
     * 执行一段 JS（忽略执行结果）
     * @param script 要执行的脚本
     */
    private void callJs(String script) {
        if (webView != null) {
            webView.evaluateJavascript(script, null);
        }
    }

    /**
     * 判断指定会话是否正在前台查看（消息提醒服务据此跳过弹窗）
     * @param convId 会话 ID
     * @return true=用户正在看这个会话
     */
    public static boolean isViewingConv(String convId) {
        return foreground && convId != null && convId.equals(viewingConvId);
    }

    @Override
    protected void onResume() {
        super.onResume();
        foreground = true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 进入后台后消息提醒需要正常弹出
        foreground = false;
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        viewingConvId = null;
        foreground = false;
        if (webView != null) {
            webView.removeJavascriptInterface("ImBridge");
            webView.destroy();
            webView = null;
        }
    }

    /**
     * 请求通知权限（Android 13+），否则后台消息提醒无法显示
     */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ActivityCompat.requestPermissions(this,
                new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1002);
    }

    // ==================== 文件下载 ====================

    /**
     * 发起下载：Android 10 以下先申请存储权限，其余版本直接下载
     * @param url 文件地址（相对或绝对）
     * @param name 保存的文件名
     */
    private void startDownload(String url, String name) {
        if (url == null || url.isEmpty()) {
            toast("文件地址无效");
            return;
        }
        String fileName = sanitizeName(name);       // 清理掉不合法字符的文件名
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            pendingDownload = new PendingDownload(url, fileName);
            storagePermissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE);
            return;
        }
        enqueueDownload(url, fileName);
    }

    /**
     * 交给系统下载管理器执行下载（带登录令牌，保存到「下载/邻语」）
     * @param url 文件地址（相对或绝对）
     * @param name 保存的文件名
     */
    private void enqueueDownload(String url, String name) {
        String full = url.startsWith("http") ? url : ApiClient.baseUrl() + url;
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(full));
            String token = session.getToken();
            if (token != null && !token.isEmpty()) {
                request.addRequestHeader("Authorization", "Bearer " + token);
            }
            request.setMimeType(guessMimeType(name));
            request.setTitle(name);
            request.setDescription("邻语文件");
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS, "邻语/" + name);

            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager == null) {
                toast("系统下载服务不可用");
                return;
            }
            manager.enqueue(request);
            toast("开始下载：" + name);
        } catch (Exception e) {
            toast("下载失败：" + e.getMessage());
        }
    }

    /**
     * 清理文件名中的非法字符，避免保存失败
     * @param name 原始文件名
     * @return 可安全保存的文件名
     */
    private static String sanitizeName(String name) {
        String value = name == null ? "" : name.trim();
        if (value.isEmpty()) {
            value = "文件";
        }
        value = value.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_");
        if (value.length() > 80) {
            value = value.substring(0, 80);
        }
        return value;
    }

    /**
     * 从下载地址或 Content-Disposition 推断文件名
     * @param url 下载地址
     * @param contentDisposition 服务端返回的 Content-Disposition（可能为空）
     * @return 推断出的文件名
     */
    private static String nameFromUrl(String url, String contentDisposition) {
        if (contentDisposition != null && contentDisposition.contains("filename=")) {
            String part = contentDisposition.substring(contentDisposition.indexOf("filename=") + 9);
            part = part.replace("\"", "").trim();
            if (!part.isEmpty()) {
                return sanitizeName(Uri.decode(part));
            }
        }
        String path = Uri.parse(url == null ? "" : url).getLastPathSegment();
        return sanitizeName(path == null ? "文件" : Uri.decode(path));
    }

    /**
     * 按扩展名推断 MIME 类型，便于系统用正确的应用打开
     * @param name 文件名
     * @return MIME 类型
     */
    private static String guessMimeType(String name) {
        String lower = name == null ? "" : name.toLowerCase(Locale.ROOT);
        int dot = lower.lastIndexOf('.');
        String ext = dot >= 0 ? lower.substring(dot + 1) : "";
        switch (ext) {
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "gif": return "image/gif";
            case "webp": return "image/webp";
            case "mp4": return "video/mp4";
            case "mp3": return "audio/mpeg";
            case "pdf": return "application/pdf";
            case "doc": return "application/msword";
            case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "xls": return "application/vnd.ms-excel";
            case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "ppt": return "application/vnd.ms-powerpoint";
            case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            case "zip": return "application/zip";
            case "apk": return "application/vnd.android.package-archive";
            case "txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }

    /**
     * 从文件选择结果中取出选中的 Uri 列表
     * @param resultCode 选择结果码
     * @param data 选择结果数据
     * @return 选中的 Uri 数组；取消或无效时返回 null
     */
    private static Uri[] pickUrisFrom(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null) {
            return null;
        }
        if (data.getClipData() != null) {
            int count = data.getClipData().getItemCount();   // 多选数量
            Uri[] uris = new Uri[count];
            for (int i = 0; i < count; i++) {
                uris[i] = data.getClipData().getItemAt(i).getUri();
            }
            return uris;
        }
        Uri single = data.getData();
        return single == null ? null : new Uri[]{single};
    }

    /**
     * 轻提示（统一在主线程弹出）
     * @param message 提示文本
     */
    private void toast(String message) {
        runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_SHORT).show());
    }

    // ==================== JS 桥 ====================

    /**
     * 注入到 H5 的原生桥：提供登录信息、下载能力与轻提示。
     * 注意：@JavascriptInterface 方法运行在 WebView 的 JS 线程，涉及 UI 的操作必须切回主线程。
     */
    public final class Bridge {

        /** 服务端根地址（H5 用它拼接接口地址） */
        @JavascriptInterface
        public String getBaseUrl() {
            return ApiClient.baseUrl();
        }

        /** 当前登录令牌（H5 请求接口与图片鉴权使用） */
        @JavascriptInterface
        public String getToken() {
            String token = session.getToken();
            return token == null ? "" : token;
        }

        /** 当前登录用户 ID（用于区分自己发送的消息） */
        @JavascriptInterface
        public String getMyId() {
            String userId = session.getUserId();
            return userId == null ? "" : userId;
        }

        /**
         * H5 通知原生当前正在查看的会话（空串表示回到会话列表），
         * 供后台消息提醒判断是否需要弹通知
         * @param convId 会话 ID
         */
        @JavascriptInterface
        public void setCurrentConv(String convId) {
            viewingConvId = (convId == null || convId.isEmpty()) ? null : convId;
        }

        /**
         * 下载文件（H5 文件卡片点击）
         * @param url 文件地址（相对或绝对）
         * @param name 建议文件名
         */
        @JavascriptInterface
        public void download(String url, String name) {
            runOnUiThread(() -> startDownload(url, name));
        }

        /**
         * H5 轻提示
         * @param message 提示文本
         */
        @JavascriptInterface
        public void toast(String message) {
            if (message != null && !message.isEmpty()) {
                ImActivity.this.toast(message);
            }
        }
    }
}
