package com.mingxing.school.live;

import android.Manifest;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;
import com.mingxing.school.BaseActivity;
import com.mingxing.school.R;
import com.mingxing.school.databinding.ActivityLiveBinding;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.Camera2Enumerator;
import org.webrtc.CameraEnumerator;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RendererCommon;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.ArrayList;
import java.util.List;

/**
 * 明星直播（Android 原生 WebRTC）
 *
 * 对接网页端信令（/live/ws），支持两种角色：
 *   1) 观看端（viewer）：进入频道后由主播端下发 Offer，本机回 Answer 并渲染画面与声音
 *   2) 手机端（app）：用配对令牌加入频道，用手机摄像头 + 麦克风回答主播的 Offer，为其提供画面与声音
 * 原生端不承担「主播」角色（主播仍需在电脑网页上开播）。
 */
public class LiveActivity extends BaseActivity {

    /** 视图：频道列表 */
    private static final int VIEW_LIST = 0;
    /** 视图：观看直播 */
    private static final int VIEW_WATCH = 1;
    /** 视图：手机端推流 */
    private static final int VIEW_PHONE = 2;

    /** 权限请求码：直播需要的摄像头与麦克风 */
    private static final int REQ_LIVE_PERMISSIONS = 2001;

    private ActivityLiveBinding binding;

    /** 当前视图 */
    private int view = VIEW_LIST;

    /** 服务端返回的频道列表，例如 ch1..ch4 */
    private final List<String> channels = new ArrayList<>();
    /** 服务端返回的 STUN 地址列表（为空时使用内置默认值） */
    private final List<String> iceUrls = new ArrayList<>();
    /** 直播配置是否已拉取过（避免每次回到列表都重复请求） */
    private boolean infoLoaded;
    /** 音频管理：观看直播时强制走扬声器，避免声音从听筒出来 */
    @Nullable
    private AudioManager audioManager;

    /** 主线程 Handler：WebRTC 回调在子线程，所有界面更新都必须切回主线程 */
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    /** 扫码配对入口（ZXing 扫码页结果回调） */
    private ActivityResultLauncher<ScanOptions> scanLauncher;
    /** 手机端配对页的链接输入框，供扫码结果回填 */
    @Nullable
    private EditText phoneLinkInput;
    /** 手机端配对页的令牌输入框，供扫码结果回填 */
    @Nullable
    private EditText phoneTokenInput;
    /** 手机端配对页的频道 chip 行，供扫码结果切换频道 */
    @Nullable
    private LinearLayout phoneChipRow;
    /** 手机端当前选中的频道（扫码或点 chip 时更新） */
    private String phonePickedChannel = "ch1";
    /** 当前频道，例如 ch1 */
    private String currentChannel = "ch1";

    /** 信令连接 */
    @Nullable
    private LiveSignaling signaling;

    /** WebRTC 工厂（全局唯一，首次进入直播时创建） */
    @Nullable
    private PeerConnectionFactory factory;
    /** 音频设备模块：显式创建并持有强引用，避免被 GC 回收导致原生层悬空 */
    @Nullable
    private JavaAudioDeviceModule audioDeviceModule;
    /** EGL 上下文，供所有渲染器共享 */
    @Nullable
    private EglBase eglBase;
    /** 当前连接 */
    @Nullable
    private PeerConnection pc;

    /** 观看画面渲染器 */
    @Nullable
    private SurfaceViewRenderer remoteRenderer;
    /** 观看页视频容器：全屏与 16:9 之间切换时需要改尺寸 */
    @Nullable
    private FrameLayout videoBox;
    /** 观看页根容器：全屏时视频容器居中放置，非全屏时顶部对齐 */
    @Nullable
    private LinearLayout watchPage;
    /** 观看页全屏按钮：全屏后仍留在画面上，用于退出全屏 */
    @Nullable
    private ImageButton fullscreenBtn;
    /** 是否处于全屏观看（顶栏、底部按钮、系统栏全部隐藏，视频铺满整屏） */
    private boolean fullscreen;
    /** 手机端本地预览渲染器 */
    @Nullable
    private SurfaceViewRenderer localRenderer;

    /** 手机端：摄像头采集器 */
    @Nullable
    private VideoCapturer capturer;
    /** 手机端：视频源与轨道 */
    @Nullable
    private VideoSource videoSource;
    @Nullable
    private VideoTrack videoTrack;
    /** 手机端：音频源与轨道 */
    @Nullable
    private AudioSource audioSource;
    @Nullable
    private AudioTrack audioTrack;
    /** 手机端：采集线程辅助类 */
    @Nullable
    private SurfaceTextureHelper surfaceHelper;

    /** 当前是否手机端推流模式（决定收到 Offer 后是加轨道还是纯接收） */
    private boolean phoneMode;
    /** 等待远端描述就绪前缓存的候选，避免时序问题丢包 */
    private final List<IceCandidate> pendingCandidates = new ArrayList<>();
    /** 观看页是否已挂上远端画面：用于避免「已连接」提示文字在画面渲染后又被写回 */
    private boolean remoteVideoAttached;

    /** 观看页状态文本 */
    @Nullable
    private TextView statusView;
    /** 手机端状态文本 */
    @Nullable
    private TextView phoneStatusView;

    // ==================== 生命周期 ====================

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityLiveBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        applySystemBarsInsets(binding.layoutTopbar, binding.layoutContent);
        applyContentInsetsForFullscreen();
        setStatusBarColor(R.color.mx_surface);
        setNavigationBarColor(R.color.mx_login_bg);

        attachTopbarAvatar(binding.layoutTopbarAvatar);
        binding.btnBack.setOnClickListener(v -> onBackAction());
        binding.tvTitle.setText(R.string.live_title);

        // 扫码配对：必须在页面 STARTED 之前注册，返回二维码里的配对链接
        scanLauncher = registerForActivityResult(new ScanContract(), result -> {
            String content = result == null ? null : result.getContents();
            if (!TextUtils.isEmpty(content)) {
                applyPairing(content);
            }
        });

        // 观看期间保持屏幕常亮，避免息屏后连接被系统挂起
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                onBackAction();
            }
        });

        showList();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        teardownConnection();
        teardownWebRtc();
        // 正常退出：清除“当前直播步骤”标记，避免下次启动误报中断
        com.mingxing.school.LiveTrace.clear(this);
    }

    /**
     * 返回逻辑：离开直播视图先断开连接，再回到列表，最后退出页面
     */
    private void onBackAction() {
        if (fullscreen) {
            // 全屏中按返回：只退出全屏，不直接跳出频道
            setFullscreen(false);
            return;
        }
        if (view == VIEW_WATCH || view == VIEW_PHONE) {
            teardownConnection();
            showList();
            return;
        }
        finish();
    }

    /** 释放信令与 PeerConnection（不释放 WebRTC 工厂，便于快速重连） */
    private void teardownConnection() {
        resetLink();
        removeRenderers();
    }

    /**
     * 仅重置信令连接、PeerConnection 与本地采集，保留当前页面视图
     * 用于手机端「停止推流 / 重新开始推流」，避免把正在显示的界面一起清空
     */
    private void resetLink() {
        if (signaling != null) {
            signaling.close();
            signaling = null;
        }
        closePeerConnection();
        pendingCandidates.clear();
        stopCapture();
        setSpeakerMode(false);
        // 取消观看端自动重连，避免离开页面后仍在后台重试
        if (retryHandler != null) {
            retryHandler.removeCallbacksAndMessages(null);
        }
    }

    /**
     * 关闭并释放当前 PeerConnection
     * 只先 close 断开，把 dispose 延后到主线程 500ms：
     * 断开瞬间原生线程可能仍有回调在途（setLocalDescription / ICE 通知等），
     * 立即 dispose 会让这些回调访问已释放的原生对象，直接触发野指针崩溃。
     * 延后期间所有回调都会因为 pc 为空而立即返回，不会误用旧连接。
     */
    private void closePeerConnection() {
        final PeerConnection old = pc;
        pc = null;
        if (old == null) {
            return;
        }
        old.close();
        mainHandler.postDelayed(() -> {
            try {
                old.dispose();
            } catch (Throwable ignored) {
                // 已被释放或原生层已析构时忽略
            }
        }, 500);
    }

    /** 释放摄像头采集与渲染器 */
    private void stopCapture() {
        if (capturer != null) {
            try {
                capturer.stopCapture();
            } catch (Exception ignored) {
                // 未开始采集时忽略
            }
            capturer.dispose();
            capturer = null;
        }
        if (videoTrack != null) {
            videoTrack.dispose();
            videoTrack = null;
        }
        if (videoSource != null) {
            videoSource.dispose();
            videoSource = null;
        }
        if (audioTrack != null) {
            audioTrack.dispose();
            audioTrack = null;
        }
        if (audioSource != null) {
            audioSource.dispose();
            audioSource = null;
        }
        if (surfaceHelper != null) {
            surfaceHelper.dispose();
            surfaceHelper = null;
        }
    }

    /** 移除并释放画面渲染器 */
    private void removeRenderers() {
        // 先退出全屏：恢复顶栏与系统栏，避免离开频道后仍停在沉浸状态
        if (fullscreen) {
            setFullscreen(false);
        }
        // 先清空容器再释放渲染器，避免对仍在界面上的 View 做 release
        binding.layoutContent.removeAllViews();
        videoBox = null;
        watchPage = null;
        fullscreenBtn = null;
        statusView = null;
        phoneStatusView = null;
        remoteVideoAttached = false;
        phoneLinkInput = null;
        phoneTokenInput = null;
        phoneChipRow = null;
        if (remoteRenderer != null) {
            remoteRenderer.release();
            remoteRenderer = null;
        }
        if (localRenderer != null) {
            localRenderer.release();
            localRenderer = null;
        }
    }

    /** 释放 WebRTC 工厂、音频设备模块与 EGL 环境（页面销毁时调用） */
    private void teardownWebRtc() {
        if (factory != null) {
            factory.dispose();
            factory = null;
        }
        if (audioDeviceModule != null) {
            audioDeviceModule.release();
            audioDeviceModule = null;
        }
        if (eglBase != null) {
            eglBase.release();
            eglBase = null;
        }
    }

    // ==================== 频道列表 ====================

    /**
     * 显示频道列表：4 个频道卡片 + 手机当麦克风入口
     */
    private void showList() {
        view = VIEW_LIST;
        binding.tvTitle.setText(R.string.live_title);
        binding.topbarActions.removeAllViews();

        LinearLayout page = createPage();
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        page.addView(list);

        // 频道卡：服务端固定提供 4 个频道，未拿到配置时使用默认 ch1~ch4
        if (channels.isEmpty()) {
            channels.add("ch1");
            channels.add("ch2");
            channels.add("ch3");
            channels.add("ch4");
        }
        for (int i = 0; i < channels.size(); i++) {
            String id = channels.get(i);
            int index = i + 1;
            list.addView(buildChannelCard(id, index));
        }

        // 手机端入口：把本机摄像头/麦克风接入某个频道
        LinearLayout phoneEntry = buildEntryCard(
                getString(R.string.live_phone_mode),
                getString(R.string.live_phone_desc),
                R.string.live_phone_start);
        phoneEntry.setOnClickListener(v -> requestPhonePermissions());
        list.addView(phoneEntry);

        // 首次进入时异步拉取 STUN/频道配置，失败不影响默认频道使用
        if (!infoLoaded) {
            infoLoaded = true;
            LiveApi.fetchInfo(new LiveApi.InfoCallback() {
                @Override
                public void onSuccess(LiveApi.LiveInfo info) {
                    if (!info.channels.isEmpty() && view == VIEW_LIST) {
                        channels.clear();
                        channels.addAll(info.channels);
                    }
                    // 记录服务端下发的 STUN 地址，建立连接时使用
                    iceUrls.clear();
                    iceUrls.addAll(info.iceUrls);
                }

                @Override
                public void onFailure(String message) {
                    // 配置拉取失败时继续使用默认频道与默认 STUN，不打扰用户
                    infoLoaded = false;
                }
            });
        }
    }

    /**
     * 构建单个频道卡片
     * @param channelId 频道标识（ch1..ch4）
     * @param index 展示用序号（1..4）
     * @return 卡片视图
     */
    private View buildChannelCard(String channelId, int index) {
        LinearLayout card = buildEntryCard(
                getString(R.string.live_channel, index),
                getString(R.string.live_waiting_host),
                R.string.live_watch);
        card.setOnClickListener(v -> startWatch(channelId));
        return card;
    }

    /**
     * 构建入口卡片（标题 + 说明 + 右侧主按钮外观）
     * @param title 标题
     * @param desc 说明
     * @param actionRes 右侧按钮文案
     * @return 卡片视图
     */
    private LinearLayout buildEntryCard(String title, String desc, int actionRes) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(getColor(R.color.mx_surface));
        bg.setCornerRadius(dp(16));
        card.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(12);
        card.setLayoutParams(lp);

        LinearLayout textBox = new LinearLayout(this);
        textBox.setOrientation(LinearLayout.VERTICAL);
        textBox.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextSize(15);
        titleView.setTypeface(null, android.graphics.Typeface.BOLD);
        titleView.setTextColor(getColor(R.color.mx_on_surface));
        textBox.addView(titleView);
        TextView descView = new TextView(this);
        descView.setText(desc);
        descView.setTextSize(12);
        descView.setTextColor(getColor(R.color.mx_on_surface_variant));
        LinearLayout.LayoutParams descLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        descLp.topMargin = dp(4);
        descView.setLayoutParams(descLp);
        textBox.addView(descView);
        card.addView(textBox);

        TextView action = new TextView(this);
        action.setText(actionRes);
        action.setTextSize(13);
        action.setTextColor(Color.WHITE);
        action.setPadding(dp(16), dp(8), dp(16), dp(8));
        GradientDrawable actionBg = new GradientDrawable();
        actionBg.setColor(getColor(R.color.mx_primary));
        actionBg.setCornerRadius(dp(999));
        action.setBackground(actionBg);
        card.addView(action);
        return card;
    }

    // ==================== 观看直播 ====================

    /**
     * 进入观看视图并建立连接
     * @param channelId 频道标识
     */
    private void startWatch(String channelId) {
        // 观看页涉及 EGL 渲染与 WebRTC 原生初始化，任一步异常都直接提示而不是闪退
        try {
            startWatchInternal(channelId);
        } catch (Throwable t) {
            showFatalDialog("进入频道失败", t);
        }
    }

    /**
     * 观看页实际构建逻辑
     * @param channelId 频道标识
     */
    private void startWatchInternal(String channelId) {
        if (!ensureWebRtc()) {
            return;
        }
        currentChannel = channelId;
        phoneMode = false;
        view = VIEW_WATCH;
        // 观看端声音走扬声器外放
        setSpeakerMode(true);
        binding.tvTitle.setText(getString(R.string.live_title));

        // 观看页不使用 ScrollView：视频需要在全屏时铺满整个内容区，
        // 因此用一个高度 MATCH_PARENT 的竖向容器，视频区位于容器顶部（顶部对齐）
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setGravity(Gravity.TOP);
        watchPage = page;
        page.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        binding.layoutContent.removeAllViews();
        binding.layoutContent.addView(page);

        // 画面区域：固定 16:9 的黑色容器，去掉圆角并贴住内容区顶部
        videoBox = new FrameLayout(this);
        videoBox.setBackgroundColor(Color.BLACK);
        videoBox.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, videoHeight169()));
        page.addView(videoBox);

        remoteRenderer = new SurfaceViewRenderer(this);
        com.mingxing.school.LiveTrace.step(this, "创建视频渲染器");
        remoteRenderer.init(eglBase.getEglBaseContext(), null);
        remoteRenderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
        remoteRenderer.setEnableHardwareScaler(true);
        videoBox.addView(remoteRenderer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        statusView = new TextView(this);
        statusView.setText(R.string.live_connecting);
        statusView.setTextSize(13);
        statusView.setTextColor(Color.WHITE);
        statusView.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams statusLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        statusLp.gravity = Gravity.CENTER;
        statusView.setLayoutParams(statusLp);
        videoBox.addView(statusView);

        // 全屏按钮：叠在画面右下角，全屏后仍保留在画面上用于退出
        fullscreenBtn = new ImageButton(this);
        fullscreenBtn.setImageResource(R.drawable.ic_fullscreen);
        fullscreenBtn.setScaleType(android.widget.ImageView.ScaleType.CENTER_INSIDE);
        fullscreenBtn.setContentDescription(getString(R.string.live_fullscreen));
        fullscreenBtn.setColorFilter(Color.WHITE);
        GradientDrawable fsBg = new GradientDrawable();
        fsBg.setColor(Color.parseColor("#66000000"));   // 半透明黑底，保证按钮在任意画面上可见
        fsBg.setCornerRadius(dp(999));
        fullscreenBtn.setBackground(fsBg);
        fullscreenBtn.setPadding(dp(7), dp(7), dp(7), dp(7));
        FrameLayout.LayoutParams fsLp = new FrameLayout.LayoutParams(dp(36), dp(36));
        fsLp.gravity = Gravity.BOTTOM | Gravity.END;
        fsLp.setMargins(0, 0, dp(10), dp(10));
        fullscreenBtn.setLayoutParams(fsLp);
        fullscreenBtn.setOnClickListener(v -> setFullscreen(!fullscreen));
        videoBox.addView(fullscreenBtn);

        com.mingxing.school.LiveTrace.step(this, "连接信令服务器");
        connectSignaling();
    }

    // ==================== 手机端推流 ====================

    /**
     * 请求摄像头与麦克风权限，授权后进入手机端配对页
     */
    private void requestPhonePermissions() {
        String[] need = {Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO};
        boolean allGranted = true;
        for (String p : need) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                allGranted = false;
                break;
            }
        }
        if (allGranted) {
            showPhone();
            return;
        }
        ActivityCompat.requestPermissions(this, need, REQ_LIVE_PERMISSIONS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_LIVE_PERMISSIONS) {
            return;
        }
        boolean granted = grantResults.length > 0;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) {
                granted = false;
            }
        }
        if (granted) {
            showPhone();
        } else {
            Toast.makeText(this, R.string.live_permission_denied, Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * 手机端配对页：粘贴配对链接 / 填令牌 + 选频道 + 开始推流
     */
    private void showPhone() {
        // 手机端配对页同样依赖 WebRTC 与 EGL，异常时提示原因而不是闪退
        try {
            showPhoneInternal();
        } catch (Throwable t) {
            showFatalDialog("打开手机端配对页失败", t);
        }
    }

    /**
     * 手机端配对页实际构建逻辑
     */
    private void showPhoneInternal() {
        if (!ensureWebRtc()) {
            return;
        }
        view = VIEW_PHONE;
        binding.tvTitle.setText(R.string.live_phone_title);
        binding.topbarActions.removeAllViews();

        ScrollView scroll = new ScrollView(this);
        scroll.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(16), dp(16), dp(16), dp(24));
        scroll.addView(page);
        binding.layoutContent.removeAllViews();
        binding.layoutContent.addView(scroll);

        // 本地预览：默认隐藏，开始推流后显示
        localRenderer = new SurfaceViewRenderer(this);
        localRenderer.init(eglBase.getEglBaseContext(), null);
        // 本地预览同样等比完整显示（不裁剪画面，比例不符时留黑边）
        localRenderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
        localRenderer.setMirror(true);
        LinearLayout.LayoutParams previewLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(200));
        previewLp.bottomMargin = dp(12);
        localRenderer.setLayoutParams(previewLp);
        localRenderer.setVisibility(View.GONE);
        page.addView(localRenderer);

        TextView desc = new TextView(this);
        desc.setText(R.string.live_phone_desc);
        desc.setTextSize(12);
        desc.setTextColor(getColor(R.color.mx_on_surface_variant));
        page.addView(desc);

        // 配对链接输入框：粘贴整条链接可自动解析频道与令牌
        EditText linkInput = new EditText(this);
        linkInput.setHint(R.string.live_phone_link_hint);
        linkInput.setTextSize(13);
        linkInput.setSingleLine(false);
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputLp.topMargin = dp(12);
        linkInput.setLayoutParams(inputLp);
        page.addView(linkInput);
        phoneLinkInput = linkInput;

        // 扫码配对：直接扫描主播页面上的二维码，自动填入链接与令牌
        TextView scanBtn = new TextView(this);
        scanBtn.setText(R.string.live_scan_pair);
        scanBtn.setTextSize(14);
        scanBtn.setGravity(Gravity.CENTER);
        scanBtn.setTextColor(getColor(R.color.mx_on_surface));
        scanBtn.setPadding(0, dp(12), 0, dp(12));
        GradientDrawable scanBg = new GradientDrawable();
        scanBg.setColor(getColor(R.color.mx_surface));
        scanBg.setCornerRadius(dp(999));
        LinearLayout.LayoutParams scanLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        scanLp.topMargin = dp(10);
        scanBtn.setLayoutParams(scanLp);
        scanBtn.setBackground(scanBg);
        scanBtn.setOnClickListener(v -> openScanner());
        page.addView(scanBtn);

        // 频道选择：4 个 chip
        TextView channelLabel = new TextView(this);
        channelLabel.setText(R.string.live_phone_pick_channel);
        channelLabel.setTextSize(12);
        channelLabel.setTextColor(getColor(R.color.mx_on_surface_variant));
        LinearLayout.LayoutParams labelLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        labelLp.topMargin = dp(12);
        channelLabel.setLayoutParams(labelLp);
        page.addView(channelLabel);

        LinearLayout chipRow = new LinearLayout(this);
        chipRow.setOrientation(LinearLayout.HORIZONTAL);
        chipRow.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        phoneChipRow = chipRow;
        phonePickedChannel = currentChannel;
        for (int i = 0; i < channels.size(); i++) {
            String id = channels.get(i);
            TextView chip = buildChip(getString(R.string.live_channel, i + 1),
                    id.equals(phonePickedChannel));
            chip.setOnClickListener(v -> {
                phonePickedChannel = id;
                refreshChips(chipRow, phonePickedChannel);
            });
            chip.setTag(id);
            LinearLayout.LayoutParams chipLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            chipLp.rightMargin = dp(8);
            chip.setLayoutParams(chipLp);
            chipRow.addView(chip);
        }
        page.addView(chipRow);

        // 令牌输入框
        EditText tokenInput = new EditText(this);
        tokenInput.setHint(R.string.live_phone_token_hint);
        tokenInput.setTextSize(13);
        tokenInput.setSingleLine(true);
        LinearLayout.LayoutParams tokenLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tokenLp.topMargin = dp(12);
        tokenInput.setLayoutParams(tokenLp);
        page.addView(tokenInput);
        phoneTokenInput = tokenInput;

        // 状态文本
        phoneStatusView = new TextView(this);
        phoneStatusView.setTextSize(12);
        phoneStatusView.setTextColor(getColor(R.color.mx_on_surface_variant));
        LinearLayout.LayoutParams stLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stLp.topMargin = dp(12);
        phoneStatusView.setLayoutParams(stLp);
        page.addView(phoneStatusView);

        // 开始/停止按钮
        TextView startBtn = new TextView(this);
        startBtn.setText(R.string.live_phone_start);
        startBtn.setTextSize(15);
        startBtn.setTextColor(Color.WHITE);
        startBtn.setGravity(Gravity.CENTER);
        startBtn.setPadding(0, dp(14), 0, dp(14));
        GradientDrawable startBg = new GradientDrawable();
        startBg.setColor(getColor(R.color.mx_primary));
        startBg.setCornerRadius(dp(999));
        startBtn.setBackground(startBg);
        LinearLayout.LayoutParams startLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        startLp.topMargin = dp(16);
        startBtn.setLayoutParams(startLp);
        page.addView(startBtn);

        final boolean[] running = {false};
        startBtn.setOnClickListener(v -> {
            if (running[0]) {
                // 停止推流：只断开连接与采集，保留本页界面
                resetLink();
                running[0] = false;
                startBtn.setText(R.string.live_phone_start);
                if (localRenderer != null) {
                    localRenderer.setVisibility(View.GONE);
                }
                if (phoneStatusView != null) {
                    phoneStatusView.setText("");
                }
                phoneMode = false;
                return;
            }
            String raw = linkInput.getText().toString().trim();
            String token = tokenInput.getText().toString().trim();
            // 粘贴整条配对链接时，从链接里解析频道与令牌
            if (!raw.isEmpty()) {
                String parsedToken = extractParam(raw, "token");
                String parsedChannel = extractParam(raw, "ch");
                if (parsedToken != null) {
                    token = parsedToken;
                    tokenInput.setText(token);
                }
                if (parsedChannel != null && channels.contains(parsedChannel)) {
                    phonePickedChannel = parsedChannel;
                    refreshChips(chipRow, phonePickedChannel);
                }
                if (parsedToken == null && urlLike(raw)) {
                    Toast.makeText(this, R.string.live_phone_bad_link, Toast.LENGTH_SHORT).show();
                    return;
                }
            }
            if (token.isEmpty()) {
                Toast.makeText(this, R.string.live_phone_need_token, Toast.LENGTH_SHORT).show();
                return;
            }
            currentChannel = phonePickedChannel;
            if (startPhoneStream(token)) {
                running[0] = true;
                startBtn.setText(R.string.live_phone_stop);
                localRenderer.setVisibility(View.VISIBLE);
            }
        });
    }

    /**
     * 打开扫码页：只识别二维码，用于读取主播页面生成的配对链接
     */
    private void openScanner() {
        if (scanLauncher == null) {
            return;
        }
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
        options.setPrompt(getString(R.string.live_scan_prompt));
        options.setBeepEnabled(false);
        options.setOrientationLocked(false);
        scanLauncher.launch(options);
    }

    /**
     * 处理扫码结果：解析二维码里的频道与令牌并回填到配对页
     * 二维码内容通常是完整配对链接（含 ch 与 token），也兼容只写令牌的纯文本
     * @param content 二维码解析出的文本
     */
    private void applyPairing(String content) {
        // 只处理手机端配对页的扫码结果
        if (view != VIEW_PHONE) {
            return;
        }
        String text = content.trim();
        String token = extractParam(text, "token");
        String channel = extractParam(text, "ch");
        // 不是链接也没有 token 参数时，把整段文本当成纯令牌
        if (token == null && !urlLike(text)) {
            token = text;
        }
        if (token == null) {
            Toast.makeText(this, R.string.live_phone_bad_link, Toast.LENGTH_SHORT).show();
            return;
        }
        if (phoneLinkInput != null) {
            phoneLinkInput.setText(text);
        }
        if (phoneTokenInput != null) {
            phoneTokenInput.setText(token);
        }
        if (channel != null && channels.contains(channel)) {
            phonePickedChannel = channel;
            if (phoneChipRow != null) {
                refreshChips(phoneChipRow, channel);
            }
        }
        Toast.makeText(this, R.string.live_scan_ok, Toast.LENGTH_SHORT).show();
    }

    /**
     * 构建频道选择 chip
     * @param text 文案
     * @param active 是否选中
     * @return chip 视图
     */
    private TextView buildChip(String text, boolean active) {
        TextView chip = new TextView(this);
        chip.setText(text);
        chip.setTextSize(13);
        chip.setPadding(dp(14), dp(8), dp(14), dp(8));
        chip.setTextColor(active ? Color.WHITE : getColor(R.color.mx_on_surface));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(active ? getColor(R.color.mx_primary) : getColor(R.color.mx_surface));
        bg.setCornerRadius(dp(999));
        chip.setBackground(bg);
        return chip;
    }

    /**
     * 按选中频道刷新 chip 外观
     * @param row chip 容器
     * @param picked 选中的频道标识
     */
    private void refreshChips(LinearLayout row, String picked) {
        for (int i = 0; i < row.getChildCount(); i++) {
            View child = row.getChildAt(i);
            if (!(child instanceof TextView) || child.getTag() == null) {
                continue;
            }
            String id = String.valueOf(child.getTag());
            TextView chip = (TextView) child;
            boolean active = id.equals(picked);
            chip.setTextColor(active ? Color.WHITE : getColor(R.color.mx_on_surface));
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(active ? getColor(R.color.mx_primary) : getColor(R.color.mx_surface));
            bg.setCornerRadius(dp(999));
            chip.setBackground(bg);
        }
    }

    /**
     * 从 URL 中提取查询参数
     * @param url 链接
     * @param key 参数名
     * @return 参数值，缺少时为 null
     */
    @Nullable
    private String extractParam(String url, String key) {
        try {
            // 用 android.net.Uri 解析：支持 http(s) 完整链接
            String value = android.net.Uri.parse(url).getQueryParameter(key);
            return TextUtils.isEmpty(value) ? null : value;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 判断输入是否像一条链接（用于给出“链接不完整”的提示）
     * @param text 输入内容
     * @return 是否形如链接
     */
    private boolean urlLike(String text) {
        return text.startsWith("http://") || text.startsWith("https://");
    }

    // ==================== WebRTC ====================

    /**
     * 初始化 WebRTC 工厂与 EGL 环境（幂等）
     * @return 是否可用
     */
    private boolean ensureWebRtc() {
        if (factory != null) {
            return true;
        }
        try {
            // 记录步骤：若下一步原生调用直接崩溃，下次启动可看到停在哪
            com.mingxing.school.LiveTrace.step(this, "加载 WebRTC 原生库");
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions
                    .builder(getApplicationContext())
                    .createInitializationOptions());
            com.mingxing.school.LiveTrace.step(this, "创建 EGL 渲染环境");
            eglBase = EglBase.create();
            com.mingxing.school.LiveTrace.step(this, "创建音频设备模块");
            // 显式创建音频设备模块，并关闭硬件回声消除与硬件降噪：
            // 默认实现默认开启硬件音效，个别机型（小米 HyperOS 3 / Android 16）在音频线程
            // 初始化硬件音效时会在 JNI 内部直接中止进程，表现为“没有任何 Java 堆栈的原生崩溃”。
            // 关闭硬件音效后仍会启用 WebRTC 的软件回声消除，通话效果基本不受影响。
            audioDeviceModule = JavaAudioDeviceModule.builder(getApplicationContext())
                    // 使用普通麦克风采集，避免进入平台通话音频链路（VOICE_COMMUNICATION 会在 HAL 层做处理，
                    // 部分机型在该链路上直接崩溃）
                    .setAudioSource(android.media.MediaRecorder.AudioSource.MIC)
                    .setUseHardwareAcousticEchoCanceler(false)
                    .setUseHardwareNoiseSuppressor(false)
                    .setUseLowLatency(false)
                    .createAudioDeviceModule();
            com.mingxing.school.LiveTrace.step(this, "创建 WebRTC 工厂");
            factory = PeerConnectionFactory.builder()
                    .setAudioDeviceModule(audioDeviceModule)
                    // 关闭硬件 VP8 / H264 编码器，改用软件编码：
                    // 部分机型（小米 HyperOS / Android 16）的 MediaCodec 在原生线程初始化时也会直接崩溃，
                    // 直播只推 720p30，软件编码性能足够
                    .setVideoEncoderFactory(new DefaultVideoEncoderFactory(
                            eglBase.getEglBaseContext(), false, false))
                    .setVideoDecoderFactory(new DefaultVideoDecoderFactory(
                            eglBase.getEglBaseContext()))
                    .createPeerConnectionFactory();
            if (factory == null) {
                // 原生库加载失败时 createPeerConnectionFactory 返回 null（并不抛异常），必须显式判空
                Toast.makeText(this, getString(R.string.live_webrtc_failed, "工厂创建失败"),
                        Toast.LENGTH_LONG).show();
                return false;
            }
            return true;
        } catch (Throwable t) {
            Toast.makeText(this, getString(R.string.live_webrtc_failed, t.getMessage()),
                    Toast.LENGTH_LONG).show();
            return false;
        }
    }

    /**
     * 连接信令并按角色发起加入请求
     */
    private void connectSignaling() {
        updateStatus(getString(R.string.live_connecting));
        try {
            signaling = new LiveSignaling(new LiveSignaling.Listener() {
                @Override
                public void onOpen() {
                    if (phoneMode) {
                        joinAsPhone(pendingPhoneToken);
                    } else {
                        joinAsViewer();
                    }
                }

                @Override
                public void onMessage(JSONObject message) {
                    handleMessage(message);
                }

                @Override
                public void onClosed(String reason) {
                    if (phoneMode) {
                        updatePhoneStatus(reason);
                    } else {
                        updateStatus(reason);
                    }
                }

                @Override
                public void onFailure(String message) {
                    if (phoneMode) {
                        updatePhoneStatus("连接失败：" + message);
                    } else {
                        updateStatus("连接失败：" + message);
                    }
                }
            });
        } catch (Throwable t) {
            // URL 非法或底层客户端创建失败时给出提示，避免直接闪退
            updateLiveError("信令连接失败：" + t.getMessage());
        }
    }

    /** 手机端加入时使用的令牌（信令 onOpen 时读取） */
    private String pendingPhoneToken = "";

    /**
     * 观看端加入频道
     */
    private void joinAsViewer() {
        JSONObject msg = new JSONObject();
        try {
            msg.put("type", "viewer:join");
            msg.put("channel", currentChannel);
        } catch (Exception ignored) {
            // JSONObject.put 只抛 JSONException，字段都是字符串，实际不会触发
        }
        send(msg);
    }

    /**
     * 手机端用配对令牌加入频道
     * @param token 配对令牌
     */
    private void joinAsPhone(String token) {
        JSONObject msg = new JSONObject();
        try {
            msg.put("type", "app:join");
            msg.put("channel", currentChannel);
            msg.put("token", token);
        } catch (Exception ignored) {
            // 同上，不会触发
        }
        send(msg);
    }

    /**
     * 发送信令消息
     * @param msg 消息体
     */
    private void send(JSONObject msg) {
        if (signaling != null) {
            signaling.send(msg);
        }
    }

    /**
     * 处理服务端消息
     * @param msg 消息体
     */
    private void handleMessage(JSONObject msg) {
        // 信令回调在主线程执行：任一异常都会直接闪退，这里统一兜底并显示原因
        try {
            dispatchMessage(msg);
        } catch (Throwable t) {
            updateLiveError("处理直播信令失败：" + t);
        }
    }

    /**
     * 按消息类型分发处理（由 handleMessage 统一包裹异常）
     * @param msg 服务端消息
     */
    private void dispatchMessage(JSONObject msg) {
        String type = msg.optString("type", "");
        switch (type) {
            case "viewer:joined":
                // 已成功连上信令，清除中断标记
                com.mingxing.school.LiveTrace.clear(this);
                updateStatus(getString(R.string.live_waiting_host));
                break;
            case "viewer:rejected":
                updateStatus(getString(R.string.live_rejected, msg.optString("message", "")));
                // 主播未开播时按网页端行为稍后自动重试
                retryViewerJoin();
                break;
            case "app:joined":
                com.mingxing.school.LiveTrace.clear(this);
                updatePhoneStatus(getString(R.string.live_phone_waiting));
                break;
            case "app:rejected":
                updatePhoneStatus(getString(R.string.live_rejected, msg.optString("message", "")));
                break;
            case "app:closed":
            case "app:host-left":
                updatePhoneStatus(getString(R.string.live_phone_closed));
                break;
            case "viewer:closed":
                updateStatus(getString(R.string.live_disconnected));
                break;
            case "error":
                if (phoneMode) {
                    updatePhoneStatus(msg.optString("message", ""));
                } else {
                    updateStatus(msg.optString("message", ""));
                }
                break;
            case "signal":
                handleSignal(msg.optJSONObject("data"));
                break;
            default:
                break;
        }
    }

    /** 观看端自动重试定时器 */
    @Nullable
    private android.os.Handler retryHandler;

    /**
     * 主播未开播时 3 秒后重试加入（与网页端行为一致）
     */
    private void retryViewerJoin() {
        if (retryHandler == null) {
            retryHandler = new android.os.Handler(android.os.Looper.getMainLooper());
        }
        retryHandler.postDelayed(() -> {
            if (view == VIEW_WATCH && !phoneMode) {
                joinAsViewer();
            }
        }, 3000);
    }

    /**
     * 处理主播端转发的 WebRTC 信令（SDP / ICE 候选）
     * @param data 信令数据：{sdp:{type,sdp}} 或 {candidate:{...}}
     */
    private void handleSignal(@Nullable JSONObject data) {
        if (data == null) {
            return;
        }
        // —— ICE 候选 ——
        JSONObject candidate = data.optJSONObject("candidate");
        if (candidate != null) {
            com.mingxing.school.LiveTrace.step(this, "应用主播 ICE 候选");
            IceCandidate ice = new IceCandidate(
                    candidate.optString("sdpMid", "0"),
                    candidate.optInt("sdpMLineIndex", 0),
                    candidate.optString("candidate", ""));
            if (pc == null || pc.getRemoteDescription() == null) {
                pendingCandidates.add(ice);
            } else {
                pc.addIceCandidate(ice);
            }
            return;
        }

        // —— SDP：主播端发来的 Offer，本机回 Answer ——
        JSONObject sdp = data.optJSONObject("sdp");
        if (sdp == null) {
            return;
        }
        String sdpType = sdp.optString("type", "");
        String sdpText = sdp.optString("sdp", "");
        if (sdpText.isEmpty()) {
            return;
        }
        if ("offer".equals(sdpType)) {
            com.mingxing.school.LiveTrace.step(this, "收到主播 Offer");
            answerOffer(sdpText);
        }
    }

    /**
     * 建立 PeerConnection（幂等）并回 Answer
     * @param offerSdp 主播下发的 Offer 文本
     */
    private void answerOffer(String offerSdp) {
        if (factory == null) {
            return;
        }
        // 新 Offer 到来时重建连接，避免旧状态干扰
        closePeerConnection();
        pendingCandidates.clear();

        List<PeerConnection.IceServer> iceServers = new ArrayList<>();
        // 优先使用服务端下发的 STUN；局域网内即使没有 STUN 也能通过 host 候选直连
        List<String> urls = iceUrls.isEmpty()
                ? java.util.Collections.singletonList("stun:stun.l.google.com:19302")
                : iceUrls;
        for (String url : urls) {
            iceServers.add(PeerConnection.IceServer.builder(url).createIceServer());
        }

        com.mingxing.school.LiveTrace.step(this, "创建 PeerConnection");
        pc = factory.createPeerConnection(iceServers, new PeerObserver());
        if (pc == null) {
            updateStatus(getString(R.string.live_webrtc_failed, "createPeerConnection 返回空"));
            return;
        }

        SessionDescription offer = new SessionDescription(
                SessionDescription.Type.OFFER, offerSdp);
        com.mingxing.school.LiveTrace.step(this, "设置远端描述");
        pc.setRemoteDescription(new RemoteSdpObserver(), offer);
    }

    /**
     * 手机端把本机摄像头与麦克风轨道加入连接
     * @param connection 当前 PeerConnection
     */
    private void attachLocalMedia(PeerConnection connection) {
        if (factory == null || eglBase == null) {
            return;
        }
        com.mingxing.school.LiveTrace.step(this, "添加麦克风轨道");
        // —— 音频：麦克风 ——
        if (audioTrack == null) {
            audioSource = factory.createAudioSource(new MediaConstraints());
            audioTrack = factory.createAudioTrack("mic", audioSource);
        }
        connection.addTrack(audioTrack);

        // —— 视频：后置/前置摄像头 ——
        if (videoTrack == null) {
            capturer = createCameraCapturer();
            if (capturer == null) {
                // 该方法由 WebRTC 线程回调，Toast 必须切回主线程
                mainHandler.post(() -> Toast.makeText(this, R.string.live_camera_failed,
                        Toast.LENGTH_SHORT).show());
                return;
            }
            surfaceHelper = SurfaceTextureHelper.create("LiveCapture",
                    eglBase.getEglBaseContext());
            videoSource = factory.createVideoSource(false);
            capturer.initialize(surfaceHelper, this, videoSource.getCapturerObserver());
            try {
                capturer.startCapture(1280, 720, 30);
            } catch (Exception e) {
                mainHandler.post(() -> Toast.makeText(this, R.string.live_camera_failed,
                        Toast.LENGTH_SHORT).show());
                return;
            }
            com.mingxing.school.LiveTrace.step(this, "摄像头已开始采集");
            videoTrack = factory.createVideoTrack("camera", videoSource);
            // 本地预览渲染器属于界面控件，切回主线程再挂载
            final SurfaceViewRenderer renderer = localRenderer;
            final VideoTrack track = videoTrack;
            if (renderer != null) {
                mainHandler.post(() -> track.addSink(renderer));
            }
        }
        connection.addTrack(videoTrack);
    }

    /**
     * 选择摄像头：优先前置，失败回退任意可用摄像头
     * @return 采集器，失败返回 null
     */
    @Nullable
    private VideoCapturer createCameraCapturer() {
        CameraEnumerator enumerator = new Camera2Enumerator(this);
        String front = null;
        String fallback = null;
        for (String name : enumerator.getDeviceNames()) {
            if (enumerator.isFrontFacing(name)) {
                front = name;
            } else if (fallback == null) {
                fallback = name;
            }
        }
        String target = front != null ? front : fallback;
        if (target == null) {
            return null;
        }
        return enumerator.createCapturer(target, null);
    }

    /**
     * 手机端开始推流：先建信令连接，onOpen 后再发 app:join
     * @param token 配对令牌
     * @return 是否已开始
     */
    private boolean startPhoneStream(String token) {
        // 只重连信令，保留手机端页面与本地预览控件
        resetLink();
        phoneMode = true;
        pendingPhoneToken = token;
        updatePhoneStatus(getString(R.string.live_connecting));
        connectSignaling();
        return true;
    }

    /**
     * 更新观看页状态文本
     * WebRTC 回调在子线程触发，这里统一切回主线程再操作界面
     * @param text 文案
     */
    private void updateStatus(String text) {
        mainHandler.post(() -> {
            if (statusView != null) {
                statusView.setText(text);
                // 空文案时隐藏，避免画面已经渲染后仍残留一行提示文字盖在视频上
                statusView.setVisibility(text == null || text.isEmpty() ? View.GONE : View.VISIBLE);
            }
        });
    }

    /**
     * 更新手机端状态文本
     * 同样切回主线程，避免 WebRTC 线程直接改 TextView 导致崩溃
     * @param text 文案
     */
    private void updatePhoneStatus(String text) {
        mainHandler.post(() -> {
            if (phoneStatusView != null) {
                phoneStatusView.setText(text);
            }
        });
    }

    /**
     * 切换音频输出路由
     * 观看直播时打开扬声器（默认通话模式会从听筒出声）；离开直播时恢复默认
     * @param speaker true=扬声器外放，false=系统默认
     */
    @SuppressWarnings("deprecation")
    private void setSpeakerMode(boolean speaker) {
        if (audioManager == null) {
            audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        }
        if (audioManager == null) {
            return;
        }
        try {
            audioManager.setSpeakerphoneOn(speaker);
        } catch (Exception ignored) {
            // 个别机型不允许修改音频路由，忽略即可，不影响画面
        }
    }

    /**
     * 在 WebRTC 原生线程回调中安全执行代码
     * 原生线程通过 JNI 回调 Java 时，若抛出未捕获异常，进程会被直接中止，
     * 表现为“没有任何 Java 堆栈的原生崩溃”，因此所有 JNI 回调内部都必须自行兜住 Throwable。
     * @param action 回调内部逻辑
     */
    private void safeRun(Runnable action) {
        try {
            action.run();
        } catch (Throwable t) {
            com.mingxing.school.LiveTrace.step(this, "回调异常：" + t);
            updateLiveError("直播回调异常：" + t);
        }
    }

    // ==================== PeerConnection 回调 ====================

    /**
     * PeerConnection 观察者：负责提交 Answer、转发 ICE、接收远端画面
     */
    private class PeerObserver implements PeerConnection.Observer {

        @Override
        public void onIceCandidate(IceCandidate iceCandidate) {
            // 该回调来自原生线程：内部一旦抛出异常会直接中止进程，因此整体兜底
            safeRun(() -> {
                com.mingxing.school.LiveTrace.step(LiveActivity.this, "上报本机 ICE 候选");
                JSONObject data = new JSONObject();
                JSONObject cand = new JSONObject();
                try {
                    cand.put("candidate", iceCandidate.sdp);
                    cand.put("sdpMid", iceCandidate.sdpMid);
                    cand.put("sdpMLineIndex", iceCandidate.sdpMLineIndex);
                    data.put("candidate", cand);
                } catch (Exception e) {
                    return;   // 字段拼装失败时跳过这条候选
                }
                JSONObject msg = new JSONObject();
                try {
                    msg.put("type", phoneMode ? "app:signal" : "viewer:signal");
                    msg.put("data", data);
                } catch (Exception e) {
                    return;
                }
                send(msg);
            });
        }

        @Override
        public void onTrack(org.webrtc.RtpTransceiver transceiver) {
            safeRun(() -> {
                RtpReceiver receiver = transceiver.getReceiver();
                org.webrtc.MediaStreamTrack track = receiver == null ? null : receiver.track();
                if (track == null) {
                    return;
                }
                com.mingxing.school.LiveTrace.step(LiveActivity.this, "接收远端音视频轨道");
                if (track instanceof VideoTrack) {
                    // 渲染器是界面控件，挂载必须回到主线程
                    final VideoTrack video = (VideoTrack) track;
                    mainHandler.post(() -> {
                        if (remoteRenderer != null) {
                            com.mingxing.school.LiveTrace.step(LiveActivity.this, "挂载远端画面");
                            video.addSink(remoteRenderer);
                            remoteVideoAttached = true;
                            com.mingxing.school.LiveTrace.clear(LiveActivity.this);
                            // 画面已开始渲染：隐藏覆盖在视频上的「正在连接」提示，避免文字残留
                            if (statusView != null) {
                                statusView.setVisibility(View.GONE);
                            }
                        }
                    });
                } else if (track instanceof AudioTrack) {
                    // 音频由 WebRTC 的音频设备模块自动播放，这里只需更新提示
                    com.mingxing.school.LiveTrace.clear(LiveActivity.this);
                    updateStatus(getString(R.string.live_connected));
                }
            });
        }

        @Override
        public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
            safeRun(() -> {
                if (state == PeerConnection.IceConnectionState.CONNECTED
                        || state == PeerConnection.IceConnectionState.COMPLETED) {
                    // 连接已建立，清除“中断步骤”标记
                    com.mingxing.school.LiveTrace.clear(LiveActivity.this);
                    if (phoneMode) {
                        updatePhoneStatus(getString(R.string.live_phone_running));
                    } else if (!remoteVideoAttached) {
                        // 画面已经在播放时不再写回提示文字，避免文字盖在视频上
                        updateStatus(getString(R.string.live_connected));
                    }
                } else if (state == PeerConnection.IceConnectionState.DISCONNECTED
                        || state == PeerConnection.IceConnectionState.FAILED) {
                    if (phoneMode) {
                        updatePhoneStatus(getString(R.string.live_disconnected));
                    } else {
                        updateStatus(getString(R.string.live_disconnected));
                    }
                }
            });
        }

        @Override
        public void onConnectionChange(PeerConnection.PeerConnectionState newState) {
            // 新版 WebRTC 用 PeerConnectionState 表示整体连接状态
        }

        @Override
        public void onSignalingChange(PeerConnection.SignalingState state) {
            // 仅使用统一计划（Unified Plan），无需处理
        }

        @Override
        public void onIceConnectionReceivingChange(boolean receiving) {
            // 接收状态变化不需要界面提示
        }

        @Override
        public void onIceGatheringChange(PeerConnection.IceGatheringState state) {
            // 候选收集状态无需提示
        }

        @Override
        public void onIceCandidatesRemoved(IceCandidate[] candidates) {
            // 远端移除候选时无需处理
        }

        @Override
        public void onAddStream(MediaStream stream) {
            // Unified Plan 下通过 onTrack 回调，这里保留空实现
        }

        @Override
        public void onRemoveStream(MediaStream stream) {
            // 同上
        }

        @Override
        public void onDataChannel(DataChannel dataChannel) {
            // 直播不使用数据通道
        }

        @Override
        public void onRenegotiationNeeded() {
            // 主播端负责发起重新协商，本机无需主动触发
        }

        @Override
        public void onAddTrack(RtpReceiver receiver, MediaStream[] mediaStreams) {
            // 通过 onTrack 统一处理
        }
    }

    /**
     * 远端描述观察者：设置 Offer 成功后（手机端先加入本地轨道）创建 Answer
     */
    private class RemoteSdpObserver implements SdpObserver {

        @Override
        public void onCreateSuccess(SessionDescription sdp) {
            // 不用于创建描述
        }

        @Override
        public void onSetSuccess() {
            // 该回调运行在 WebRTC signaling 线程，且当前正处于原生调用栈内部；
            // 此时再直接调用 PeerConnection 的方法会让信令线程自己等自己（BlockingCall 自等待），
            // 卡死后 WebRTC 触发断言并以 SIGABRT 终止进程。
            // 因此本地轨道挂载与 createAnswer 统一丢回主线程再执行。
            mainHandler.post(() -> safeRun(() -> {
                if (pc == null) {
                    return;
                }
                // 手机端必须等远端 Offer 落定后再挂载本地轨道，否则会在 Answer 里多出 m-line
                if (phoneMode) {
                    attachLocalMedia(pc);
                }
                com.mingxing.school.LiveTrace.step(LiveActivity.this, "生成 Answer");
                pc.createAnswer(new AnswerObserver(), new MediaConstraints());
            }));
        }

        @Override
        public void onCreateFailure(String error) {
            updateLiveError("创建 SDP 失败：" + error);
        }

        @Override
        public void onSetFailure(String error) {
            updateLiveError("设置 Offer 失败：" + error);
        }
    }

    /**
     * 本地描述观察者：Answer 写入成功后补发缓存的 ICE 候选，并把 Answer 发给主播端
     */
    private class LocalSdpObserver implements SdpObserver {

        @Override
        public void onCreateSuccess(SessionDescription sdp) {
            // 不用于创建描述
        }

        @Override
        public void onSetSuccess() {
            // 回调在 signaling 线程的原生调用栈内部执行，补发候选 / 读取本地描述同样必须回主线程
            mainHandler.post(() -> safeRun(() -> {
                if (pc == null || pc.getLocalDescription() == null) {
                    return;
                }
                com.mingxing.school.LiveTrace.step(LiveActivity.this, "发送 Answer 给主播");
                // 远端候选在收到 Offer 之前可能先到，这里统一补发
                for (IceCandidate ice : pendingCandidates) {
                    pc.addIceCandidate(ice);
                }
                pendingCandidates.clear();
                com.mingxing.school.LiveTrace.step(LiveActivity.this, "补发缓存 ICE 完成");

                String localSdp = pc.getLocalDescription().description;
                com.mingxing.school.LiveTrace.step(LiveActivity.this, "读取本地 SDP 完成");
                JSONObject data = new JSONObject();
                JSONObject sdpJson = new JSONObject();
                try {
                    sdpJson.put("type", "answer");
                    sdpJson.put("sdp", localSdp);
                    data.put("sdp", sdpJson);
                } catch (Exception e) {
                    return;
                }
                JSONObject msg = new JSONObject();
                try {
                    msg.put("type", phoneMode ? "app:signal" : "viewer:signal");
                    msg.put("data", data);
                } catch (Exception e) {
                    return;
                }
                send(msg);
                com.mingxing.school.LiveTrace.step(LiveActivity.this, "Answer 已发出，等待连接");
            }));
        }

        @Override
        public void onCreateFailure(String error) {
            updateLiveError("创建 SDP 失败：" + error);
        }

        @Override
        public void onSetFailure(String error) {
            updateLiveError("设置 Answer 失败：" + error);
        }
    }

    /**
     * Answer 创建回调：成功后写入本地描述
     */
    private class AnswerObserver implements SdpObserver {

        @Override
        public void onCreateSuccess(SessionDescription sdp) {
            // 同样不能在 signaling 线程的回调里直接调用 setLocalDescription，原因见 RemoteSdpObserver
            mainHandler.post(() -> safeRun(() -> {
                if (pc != null) {
                    com.mingxing.school.LiveTrace.step(LiveActivity.this, "应用本地 Answer");
                    pc.setLocalDescription(new LocalSdpObserver(), sdp);
                }
            }));
        }

        @Override
        public void onCreateFailure(String error) {
            updateLiveError("创建 Answer 失败：" + error);
        }

        @Override
        public void onSetSuccess() {
            // 由 LocalSdpObserver 处理
        }

        @Override
        public void onSetFailure(String error) {
            // 由 LocalSdpObserver 处理
        }
    }

    /**
     * 统一的错误提示（按当前模式更新状态文本）
     * @param message 中文原因
     */
    private void updateLiveError(String message) {
        if (phoneMode) {
            updatePhoneStatus(message);
        } else {
            updateStatus(message);
        }
    }

    /**
     * 把直播页面初始化失败的异常以对话框形式展示，避免整页闪退
     * @param title 标题（说明失败在哪一步）
     * @param error 异常对象
     */
    private void showFatalDialog(String title, Throwable error) {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        String detail = android.util.Log.getStackTraceString(error);
        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(detail)
                .setPositiveButton("知道了", null)
                .show();
    }

    // ==================== UI 工具 ====================

    /**
     * 内容区安全区处理：全屏时左右归零，让视频在横屏下真正贴边铺满
     * 说明：基类默认会给内容区补刘海/系统栏左右留白，横屏全屏时会在视频两侧留下浅色细边
     */
    private void applyContentInsetsForFullscreen() {
        final View content = binding.layoutContent;
        final int baseTop = content.getPaddingTop();        // 布局原有顶部留白
        final int baseBottom = content.getPaddingBottom();  // 布局原有底部留白
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
            // 全屏：左右不留白（画面贴边）；非全屏：避让刘海与侧边系统栏
            int left = fullscreen ? 0 : Math.max(bars.left, cutout.left);
            int right = fullscreen ? 0 : Math.max(bars.right, cutout.right);
            v.setPadding(left, baseTop, right, baseBottom + bars.bottom);
            return insets;
        });
    }

    /**
     * 计算 16:9 视频区高度
     * 以竖屏宽度为基准（视频区左右贴边），退出全屏时按此高度还原。
     * 全屏横屏时屏幕宽高已互换，取较短边作为竖屏宽度，保证退出全屏后高度正确。
     * @return 视频容器高度（像素）
     */
    private int videoHeight169() {
        android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
        int width = Math.min(dm.widthPixels, dm.heightPixels);   // 竖屏宽度（横屏时取较短边）
        return (int) (width * 9f / 16f);
    }

    /**
     * 计算全屏时视频容器的 16:9 尺寸（居中，等比完整显示）
     * 以屏幕长边/短边判断：屏幕比 16:9 宽时高度顶满，否则宽度顶满；
     * 这样容器本身始终是 16:9，渲染器即使按铺满缩放也不会把画面上下裁掉。
     * @return 长度为 2 的数组：[宽, 高]
     */
    private int[] fullscreenVideoSize() {
        android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
        int shortSide = Math.min(dm.widthPixels, dm.heightPixels);   // 屏幕短边
        int longSide = Math.max(dm.widthPixels, dm.heightPixels);    // 屏幕长边
        int width;
        int height;
        if (longSide * 9f >= shortSide * 16f) {
            // 屏幕比 16:9 更宽（如 20:9）：高度顶满，宽度按 16:9 计算
            height = shortSide;
            width = (int) (shortSide * 16f / 9f);
        } else {
            // 屏幕比 16:9 更窄：宽度顶满，高度按 16:9 计算
            width = longSide;
            height = (int) (longSide * 9f / 16f);
        }
        return new int[]{width, height};
    }

    /**
     * 切换观看页的全屏状态
     * 全屏：切为横屏、隐藏顶栏与状态栏/导航条，视频容器铺满整屏（画面保持 16:9 居中）；
     * 退出：恢复竖屏、顶栏与系统栏，视频区回到固定 16:9
     * @param on true=进入全屏，false=退出全屏
     */
    private void setFullscreen(boolean on) {
        fullscreen = on;
        binding.layoutTopbar.setVisibility(on ? View.GONE : View.VISIBLE);
        if (videoBox != null) {
            if (on) {
                // 全屏：容器保持 16:9 并按屏幕尽可能放大后居中，画面完整显示不裁切
                int[] size = fullscreenVideoSize();
                videoBox.setLayoutParams(new LinearLayout.LayoutParams(size[0], size[1]));
            } else {
                videoBox.setLayoutParams(new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, videoHeight169()));
            }
        }
        if (watchPage != null) {
            watchPage.setGravity(on ? Gravity.CENTER : Gravity.TOP);
        }
        // 再次显式指定等比完整显示：避免某些机型在尺寸切换后沿用「铺满」缩放导致上下被裁
        if (remoteRenderer != null) {
            remoteRenderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
        }
        if (fullscreenBtn != null) {
            fullscreenBtn.setImageResource(on ? R.drawable.ic_fullscreen_exit : R.drawable.ic_fullscreen);
            fullscreenBtn.setContentDescription(getString(
                    on ? R.string.live_fullscreen_exit : R.string.live_fullscreen));
        }
        // 全屏必须横屏：运行时覆盖清单里的 portrait 声明；退出时恢复竖屏（页面已声明 configChanges，不会重建界面）
        setRequestedOrientation(on
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        // 沉浸式系统栏：全屏时隐藏，退出时恢复显示
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (on) {
            controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars());
        }
        // 立即重算内容区留白：进/出全屏时左右安全区取值不同（旋转后系统也会再次回调）
        ViewCompat.requestApplyInsets(binding.layoutContent);
    }

    /**
     * 创建可滚动的内容页（淡蓝背景，四周留白）
     * @return 页面容器
     */
    private LinearLayout createPage() {
        ScrollView scroll = new ScrollView(this);
        scroll.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(16), dp(16), dp(16), dp(24));
        scroll.addView(page);
        binding.layoutContent.removeAllViews();
        binding.layoutContent.addView(scroll);
        return page;
    }
}
