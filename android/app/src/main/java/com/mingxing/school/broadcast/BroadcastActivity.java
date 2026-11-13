package com.mingxing.school.broadcast;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioAttributes;
import android.media.MediaMetadataRetriever;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.card.MaterialCardView;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.mingxing.school.BaseActivity;
import com.mingxing.school.R;
import com.mingxing.school.data.SessionStore;
import com.mingxing.school.databinding.ActivityBroadcastBinding;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 明星广播器（原生版）。
 * 两个界面：
 *   1. 控制台：四个固定频道的状态卡片 + audio 目录音频列表，可投放 / 暂停 / 继续 / 停止
 *   2. 频道收听页：连上单频道 SSE，用 MediaPlayer 自动跟随控制台投放的音频
 * 服务端接口与网页版 apps/broadcast 完全一致，仅换了一层原生 UI。
 */
public class BroadcastActivity extends BaseActivity {

    /** 页面重建时保存「正在收听哪个频道」的键 */
    private static final String STATE_LISTENING = "listening_channel";

    /**
     * 四个固定频道配置，与服务端 apps/broadcast/server/config/channels.js 对应。
     * id 用于接口路径，name 用于显示，color 用于卡片主题色。
     */
    private static final ChannelCfg[] CHANNELS = {
            new ChannelCfg("playground", "操场", 0xFF3CB371, R.drawable.ic_channel_playground),
            new ChannelCfg("classroom", "教室", 0xFF1CB0F6, R.drawable.ic_channel_classroom),
            new ChannelCfg("canteen", "食堂", 0xFFFF7BAC, R.drawable.ic_channel_canteen),
            new ChannelCfg("magic", "魔法教室", 0xFF9B59B6, R.drawable.ic_channel_magic)
    };

    /** 页面视图绑定 */
    private ActivityBroadcastBinding binding;
    /** 本地会话存储，读取登录令牌 */
    private SessionStore sessionStore;
    /** 登录令牌，所有请求与 SSE 都需要携带 */
    private String token;

    /** 每秒刷新进度的定时器 */
    private final Handler ticker = new Handler(Looper.getMainLooper());

    /** 控制台聚合 SSE 连接（订阅全部频道） */
    @Nullable
    private BroadcastSse consoleSse;

    /** 频道 id → 最新状态 */
    private final Map<String, ChannelState> states = new HashMap<>();
    /** 频道 id → 卡片视图持有者，避免每秒重建视图 */
    private final Map<String, CardHolder> cards = new HashMap<>();
    /** 音频列表容器 */
    @Nullable
    private LinearLayout audioContainer;
    /** 音频数量标签 */
    @Nullable
    private TextView audioCountLabel;

    /** 正在探测时长的音频文件名集合，避免重复探测 */
    private final Set<String> probingFiles = new HashSet<>();
    /** 时长探测线程池：单线程即可，探测不频繁 */
    private static final ExecutorService PROBE_EXECUTOR = Executors.newSingleThreadExecutor();

    /** 当前正在收听的频道 id；为 null 表示停留在控制台 */
    @Nullable
    private String listeningChannel;
    /** 单频道 SSE 连接 */
    @Nullable
    private BroadcastSse channelSse;
    /** 收听页的状态缓存，供每秒刷新进度使用 */
    @Nullable
    private ChannelState listeningState;
    /** 收听页的进度文字 */
    @Nullable
    private TextView listenProgress;

    /** 当前播放器已载入的音频 id，用于判断是否需要换源 */
    @Nullable
    private String loadedAudioId;
    /** 已处理的最大指令序号，丢弃过期/重复指令 */
    private int lastSeq = -1;
    /** 上一次的连接状态，用于只在状态变化时提示 */
    private boolean lastConnected;

    /**
     * 页面创建：绑定布局、校验登录、按状态恢复控制台或收听页
     * @param savedInstanceState 页面重建时的历史状态，首次创建为 null
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityBroadcastBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());
        // 顶栏避让状态栏、内容区避让手势条；根背景铺满，避免底部出现白带
        applySystemBarsInsets(binding.layoutTopbar, binding.layoutContent);
        setStatusBarColor(R.color.mx_surface);        // 状态栏与白色顶栏同色
        setNavigationBarColor(R.color.mx_login_bg);   // 手势条区与淡蓝内容区同色

        sessionStore = new SessionStore(this);
        token = sessionStore.getToken();
        if (token == null || token.isEmpty()) {
            // 会话失效时不留在页面，直接退出由登录页重新引导
            finish();
            return;
        }

        binding.btnBack.setOnClickListener(v -> handleBack());
        // 顶栏左侧头像：点击弹出用户菜单（与主界面、商店一致）
        attachTopbarAvatar(binding.layoutTopbarAvatar);
        binding.btnRefresh.setOnClickListener(v -> refresh());

        // 通知权限：Android 13 起媒体卡片需要用户授权，未授权时系统不展示通知
        requestNotificationPermission();

        // 播放状态回调：播完自动让服务端停止（所有听众一起回到空闲），失败时提示
        PlaybackService.setListener(new PlaybackService.Listener() {
            @Override
            public void onCompleted() {
                // 与服务端同步：播完即停止，避免控制台一直显示「播放中」
                if (listeningChannel != null) {
                    BroadcastApi.channelAction(listeningChannel, "stop", token,
                            new BroadcastApi.Callback() {
                                @Override
                                public void onSuccess(JSONObject root) {
                                    // 服务端会广播 snapshot，页面无需额外处理
                                }

                                @Override
                                public void onFailure(String message) {
                                    // 静默失败，避免播完后弹错误打扰用户
                                }
                            });
                }
                loadedAudioId = null;
            }

            @Override
            public void onError() {
                if (!isFinishing() && !isDestroyed()) {
                    Toast.makeText(BroadcastActivity.this,
                            R.string.broadcast_play_failed, Toast.LENGTH_SHORT).show();
                }
                loadedAudioId = null;
            }
        });
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBack();
            }
        });

        String saved = savedInstanceState == null
                ? null : savedInstanceState.getString(STATE_LISTENING);
        if (saved != null) {
            showChannel(saved);
        } else {
            showConsole();
        }
    }

    /**
     * 保存当前页面状态，重建后仍停留在同一收听频道
     * @param outState 系统提供的状态容器
     */
    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString(STATE_LISTENING, listeningChannel);
    }

    /** 页面销毁：停止定时器、关闭订阅，播放交给前台服务继续（后台/息屏可听） */
    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopTicker();
        closeConsoleSse();
        closeChannelSse();
        // 只解除页面回调，不停播放：后台/息屏继续放，由前台服务与系统媒体卡片接管
        PlaybackService.setListener(null);
    }

    /**
     * 请求通知权限（Android 13+）：未授权时前台服务的媒体卡片不会显示
     */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        int granted = ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.POST_NOTIFICATIONS);
        if (granted != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1001);
        }
    }

    /**
     * 返回逻辑：收听页先回控制台，控制台再退出页面
     */
    private void handleBack() {
        if (listeningChannel != null) {
            showConsole();
        } else {
            finish();
        }
    }

    /**
     * 刷新当前界面：控制台刷新频道与音频列表，收听页重新拉取频道状态
     */
    private void refresh() {
        if (listeningChannel != null) {
            loadSingleChannel(listeningChannel);
        } else {
            loadChannels();
            loadAudios();
        }
    }

    // ==================== 控制台 ====================

    /**
     * 切换到控制台：关闭收听页订阅与播放，重建界面并开始订阅
     */
    private void showConsole() {
        listeningChannel = null;
        listeningState = null;
        listenProgress = null;
        binding.tvTitle.setText(R.string.broadcast_title);

        closeChannelSse();
        releasePlayer();
        loadedAudioId = null;

        buildConsoleUi();
        openConsoleSse();
        loadChannels();
        loadAudios();
        startTicker();
    }

    /**
     * 构建控制台界面：四张频道卡片 + 音频列表
     */
    private void buildConsoleUi() {
        cards.clear();
        audioContainer = null;
        audioCountLabel = null;

        // ScrollView 包裹，频道与音频较多时可滚动
        ScrollView scroll = new ScrollView(this);
        scroll.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(16), dp(16), dp(24));
        scroll.addView(root, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // —— 频道状态标题 ——
        root.addView(sectionTitle(getString(R.string.broadcast_channels)));

        // —— 四张频道卡片 ——
        for (ChannelCfg cfg : CHANNELS) {
            View card = buildChannelCard(cfg);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = dp(12);
            root.addView(card, lp);
        }

        // —— 音频列表标题行 ——
        LinearLayout audioHeader = new LinearLayout(this);
        audioHeader.setOrientation(LinearLayout.HORIZONTAL);
        audioHeader.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams headerLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        headerLp.topMargin = dp(12);
        audioHeader.setLayoutParams(headerLp);

        TextView audioTitle = new TextView(this);
        audioTitle.setText(R.string.broadcast_audio_list);
        audioTitle.setTextColor(getColor(R.color.mx_on_surface));
        audioTitle.setTextSize(16);
        audioTitle.getPaint().setFakeBoldText(true);
        audioHeader.addView(audioTitle);

        audioCountLabel = new TextView(this);
        audioCountLabel.setTextColor(getColor(R.color.mx_on_surface_variant));
        audioCountLabel.setTextSize(14);
        audioCountLabel.setLayoutParams(new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        audioHeader.addView(audioCountLabel);

        MaterialButton rescan = textButton(R.string.broadcast_rescan);
        rescan.setOnClickListener(v -> rescanAudios());
        audioHeader.addView(rescan);
        root.addView(audioHeader);

        // —— 音频列表容器 ——
        audioContainer = new LinearLayout(this);
        audioContainer.setOrientation(LinearLayout.VERTICAL);
        audioContainer.setBackground(roundedBg(getColor(R.color.mx_surface), 12));
        audioContainer.setClipToOutline(true);
        root.addView(audioContainer, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        binding.layoutContent.removeAllViews();
        binding.layoutContent.addView(scroll);
    }

    /**
     * 构建一个频道卡片（对齐网页版控制台卡片）：
     * 图标 + 频道名 + 状态徽章 + 听众数 / 当前音频 / 进度提示 / 可拖动进度条 / 停止与收听按钮
     * @param cfg 频道配置
     * @return 卡片视图
     */
    private View buildChannelCard(ChannelCfg cfg) {
        MaterialCardView card = new MaterialCardView(this);
        card.setCardBackgroundColor(getColor(R.color.mx_surface));
        card.setRadius(dp(12));
        card.setCardElevation(0);
        card.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(14), dp(14), dp(8));
        card.addView(box, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // —— 第一行：频道色图标 + 频道名/状态 + 听众数 ——
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);

        // 频道图标：网页版为「品牌色底 + 频道 SVG」，这里用同样式（横竖居中留白）
        ImageView icon = new ImageView(this);
        icon.setImageResource(cfg.iconRes);
        icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
        icon.setBackground(roundedBg(cfg.color, 12));
        int iconPadding = dp(11);
        icon.setPadding(iconPadding, iconPadding, iconPadding, iconPadding);
        icon.setLayoutParams(new LinearLayout.LayoutParams(dp(44), dp(44)));
        head.addView(icon);

        // 频道名与状态徽章上下排布
        LinearLayout meta = new LinearLayout(this);
        meta.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams metaLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        metaLp.leftMargin = dp(12);
        meta.setLayoutParams(metaLp);

        TextView name = new TextView(this);
        name.setText(cfg.name);
        name.setTextColor(getColor(R.color.mx_on_surface));
        name.setTextSize(16);
        name.getPaint().setFakeBoldText(true);
        meta.addView(name);

        TextView badge = new TextView(this);
        badge.setTextSize(11);
        badge.setPadding(dp(8), dp(2), dp(8), dp(2));
        badge.setBackground(roundedBg(getColor(R.color.mx_input_stroke), 9));
        badge.setTextColor(getColor(R.color.mx_on_surface_variant));
        LinearLayout.LayoutParams badgeLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        badgeLp.topMargin = dp(4);
        badge.setLayoutParams(badgeLp);
        meta.addView(badge);
        head.addView(meta);

        TextView listeners = new TextView(this);
        listeners.setTextColor(getColor(R.color.mx_on_surface_variant));
        listeners.setTextSize(12);
        head.addView(listeners);
        box.addView(head);

        // —— 当前音频 ——
        TextView now = new TextView(this);
        now.setText(R.string.broadcast_now_none);
        now.setTextColor(getColor(R.color.mx_on_surface));
        now.setTextSize(14);
        now.setMaxLines(1);
        now.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams nowLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nowLp.topMargin = dp(12);
        now.setLayoutParams(nowLp);
        box.addView(now);

        // —— 进度提示行（对应网页版 .channel-hint） ——
        TextView hint = new TextView(this);
        hint.setText(R.string.broadcast_hint_idle);
        hint.setTextColor(getColor(R.color.mx_on_surface_variant));
        hint.setTextSize(12);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.topMargin = dp(4);
        hint.setLayoutParams(hintLp);
        box.addView(hint);

        // —— 可拖动进度条：播放中且已知总时长时才显示（松手即全体 seek） ——
        SeekBar seek = new SeekBar(this);
        seek.setMax(1);
        seek.setProgressTintList(ColorStateList.valueOf(cfg.color));
        seek.setThumbTintList(ColorStateList.valueOf(cfg.color));
        seek.setVisibility(View.GONE);
        LinearLayout.LayoutParams seekLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        seek.setLayoutParams(seekLp);
        box.addView(seek);

        // 进度时间文字：拖动时同步刷新
        TextView time = new TextView(this);
        time.setTextColor(getColor(R.color.mx_on_surface_variant));
        time.setTextSize(11);
        time.setVisibility(View.GONE);
        box.addView(time);

        // —— 操作行：只保留「停止」（投放统一走下方音频列表），收听入口放右侧 ——
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams actionsLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        actionsLp.topMargin = dp(4);
        actions.setLayoutParams(actionsLp);

        MaterialButton stop = textButton(R.string.broadcast_stop);
        stop.setTextColor(getColor(R.color.mx_error));
        stop.setOnClickListener(v -> stopChannel(cfg));
        actions.addView(stop);

        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(0, dp(1), 1f));
        actions.addView(spacer);

        MaterialButton listen = textButton(R.string.broadcast_listen);
        listen.setOnClickListener(v -> showChannel(cfg.id));
        actions.addView(listen);
        box.addView(actions);

        // 拖动结束才提交 seek，避免拖动过程中每帧都请求服务端
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                if (fromUser) {
                    time.setText(formatSec(progress) + " / " + formatSec(seekBar.getMax()));
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {
                // 标记拖动中，定时器不再回写进度
                seekBar.setTag(Boolean.TRUE);
            }

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                seekBar.setTag(null);
                seekChannel(cfg.id, seekBar.getProgress());
            }
        });

        CardHolder holder = new CardHolder(badge, now, hint, listeners, time, stop, seek);
        cards.put(cfg.id, holder);
        return card;
    }

    /**
     * 提交播放进度跳转（服务端会重算 startedAt 并广播，全体听众对齐）
     * @param channelId 频道 id
     * @param positionSec 目标位置（秒）
     */
    private void seekChannel(String channelId, int positionSec) {
        BroadcastApi.seek(channelId, positionSec, token, new BroadcastApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                JSONObject data = root.optJSONObject("data");
                if (data != null) {
                    states.put(channelId, ChannelState.parse(data));
                    updateCards();
                }
            }

            @Override
            public void onFailure(String message) {
                Toast.makeText(BroadcastActivity.this,
                        R.string.broadcast_seek_failed, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * 创建一个小尺寸透明底文字按钮（Material 3 文本按钮风格）
     * @param textRes 按钮文案
     * @return 文字按钮
     */
    private MaterialButton textButton(int textRes) {
        MaterialButton button = new MaterialButton(this);
        button.setText(textRes);
        button.setTextSize(13);
        // 去掉 MaterialButton 默认的实心底色与阴影，做成文本按钮
        button.setBackgroundTintList(ColorStateList.valueOf(Color.TRANSPARENT));
        button.setTextColor(getColor(R.color.mx_primary));
        button.setElevation(0);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setInsetTop(0);
        button.setInsetBottom(0);
        button.setPadding(dp(12), 0, dp(12), 0);
        return button;
    }

    /**
     * 创建分区标题
     * @param text 标题文字
     * @return 标题视图
     */
    private TextView sectionTitle(String text) {
        TextView title = new TextView(this);
        title.setText(text);
        title.setTextColor(getColor(R.color.mx_on_surface));
        title.setTextSize(16);
        title.getPaint().setFakeBoldText(true);
        title.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return title;
    }

    /**
     * 打开控制台聚合 SSE：连接建立即收到全量 snapshot，之后每次状态变化刷新卡片
     */
    private void openConsoleSse() {
        closeConsoleSse();
        consoleSse = new BroadcastSse("/api/events", token, new BroadcastSse.Listener() {
            @Override
            public void onEvent(String type, String data) {
                if ("snapshot".equals(type)) {
                    JSONArray array = parseArray(data);
                    if (array != null) {
                        parseStates(array);
                        updateCards();
                    }
                }
            }

            @Override
            public void onConnection(boolean connected) {
                setConnectedDot(connected);
            }
        });
        consoleSse.start();
    }

    /** 关闭控制台聚合订阅 */
    private void closeConsoleSse() {
        if (consoleSse != null) {
            consoleSse.stop();
            consoleSse = null;
        }
    }

    /**
     * 拉取四个频道的当前状态
     */
    private void loadChannels() {
        BroadcastApi.getChannels(token, new BroadcastApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                JSONArray array = root.optJSONArray("data");
                if (array != null) {
                    parseStates(array);
                    updateCards();
                }
            }

            @Override
            public void onFailure(String message) {
                Toast.makeText(BroadcastActivity.this, message, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * 拉取音频列表并渲染
     */
    private void loadAudios() {
        BroadcastApi.getAudios(token, new BroadcastApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                JSONObject data = root.optJSONObject("data");
                renderAudios(data == null ? null : data.optJSONArray("list"));
            }

            @Override
            public void onFailure(String message) {
                Toast.makeText(BroadcastActivity.this, message, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * 重新扫描 audio 目录并刷新列表
     */
    private void rescanAudios() {
        BroadcastApi.rescanAudios(token, new BroadcastApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                JSONObject data = root.optJSONObject("data");
                renderAudios(data == null ? null : data.optJSONArray("list"));
            }

            @Override
            public void onFailure(String message) {
                Toast.makeText(BroadcastActivity.this, message, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * 渲染音频列表：每行显示名称与大小，点击弹出频道选择
     * @param list 服务端返回的音频数组，可能为 null
     */
    private void renderAudios(@Nullable JSONArray list) {
        if (audioContainer == null) {
            return;
        }
        audioContainer.removeAllViews();
        List<AudioItem> items = new ArrayList<>();
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.optJSONObject(i);
                if (o == null) {
                    continue;
                }
                AudioItem item = new AudioItem();
                item.id = o.optString("id");
                item.name = o.optString("name");
                item.file = o.optString("file");
                item.size = o.optLong("size", 0);
                item.mtime = o.optLong("mtime", 0);
                items.add(item);
            }
        }

        if (audioCountLabel != null) {
            audioCountLabel.setText(getString(R.string.broadcast_audio_count, items.size()));
        }

        if (items.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText(R.string.broadcast_audio_empty);
            empty.setTextColor(getColor(R.color.mx_on_surface_variant));
            empty.setTextSize(13);
            empty.setPadding(dp(16), dp(16), dp(16), dp(16));
            audioContainer.addView(empty);
            return;
        }

        for (int i = 0; i < items.size(); i++) {
            AudioItem item = items.get(i);
            audioContainer.addView(buildAudioRow(item));
            if (i < items.size() - 1) {
                audioContainer.addView(divider());
            }
        }
    }

    /**
     * 构建单条音频行（对齐网页版：音乐图标 + 名称 + 大小/修改时间 + 投放按钮）
     * @param item 音频数据
     * @return 行视图
     */
    private View buildAudioRow(AudioItem item) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(64)));
        row.setPadding(dp(16), 0, dp(12), 0);
        row.setBackgroundResource(selectableBackground());

        // 音乐图标
        TextView icon = new TextView(this);
        icon.setText("🎵");
        icon.setTextSize(18);
        icon.setGravity(Gravity.CENTER);
        icon.setLayoutParams(new LinearLayout.LayoutParams(dp(28), dp(28)));
        row.addView(icon);

        // 名称 + 元信息
        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        infoLp.leftMargin = dp(10);
        info.setLayoutParams(infoLp);

        TextView name = new TextView(this);
        name.setText(item.name);
        name.setTextColor(getColor(R.color.mx_on_surface));
        name.setTextSize(14);
        name.setMaxLines(1);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        info.addView(name);

        TextView meta = new TextView(this);
        meta.setText(getString(R.string.broadcast_audio_meta,
                String.format(java.util.Locale.CHINA, "%.1f", item.size / 1024.0),
                formatDateTime(item.mtime)));
        meta.setTextColor(getColor(R.color.mx_on_surface_variant));
        meta.setTextSize(11);
        info.addView(meta);
        row.addView(info);

        // 投放按钮：点击后选择目标频道（可多选）
        MaterialButton play = textButton(R.string.broadcast_play_action);
        play.setOnClickListener(v -> showPickChannelDialog(item));
        row.addView(play);
        return row;
    }

    /**
     * 弹出投放弹窗：选择目标频道（可多选，未选时「投放」置灰），与网页版弹窗一致
     * @param item 待投放的音频
     */
    private void showPickChannelDialog(AudioItem item) {
        // 已选中的频道 id 集合（对应网页版 pendingChannelIds，可多选、再点取消）
        final Set<String> picked = new HashSet<>();
        // 对话框引用：点击频道块后需要动态启用/禁用「投放」按钮
        final androidx.appcompat.app.AlertDialog[] holder = new androidx.appcompat.app.AlertDialog[1];

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(4), dp(20), dp(8));

        TextView tip = new TextView(this);
        tip.setText(getString(R.string.broadcast_pick_channel_hint, item.name));
        tip.setTextColor(getColor(R.color.mx_on_surface_variant));
        tip.setTextSize(12);
        tip.setPadding(0, 0, 0, dp(8));
        box.addView(tip);

        // 两列频道块，与网页版弹窗的频道卡片网格一致（频道色图标 + 名称 + 选中描边）
        android.widget.GridLayout grid = new android.widget.GridLayout(this);
        grid.setColumnCount(2);
        for (final ChannelCfg cfg : CHANNELS) {
            LinearLayout tile = new LinearLayout(this);
            tile.setOrientation(LinearLayout.VERTICAL);
            tile.setGravity(Gravity.CENTER);
            tile.setPadding(dp(10), dp(10), dp(10), dp(10));
            android.widget.GridLayout.LayoutParams tileLp = new android.widget.GridLayout.LayoutParams();
            tileLp.width = 0;
            tileLp.columnSpec = android.widget.GridLayout.spec(android.widget.GridLayout.UNDEFINED, 1f);
            tileLp.setMargins(dp(4), dp(4), dp(4), dp(4));
            tile.setLayoutParams(tileLp);

            ImageView icon = new ImageView(this);
            icon.setImageResource(cfg.iconRes);
            icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
            icon.setBackground(roundedBg(cfg.color, 12));
            int iconPadding = dp(10);
            icon.setPadding(iconPadding, iconPadding, iconPadding, iconPadding);
            icon.setLayoutParams(new LinearLayout.LayoutParams(dp(40), dp(40)));
            tile.addView(icon);

            TextView name = new TextView(this);
            name.setText(cfg.name);
            name.setTextColor(getColor(R.color.mx_on_surface));
            name.setTextSize(13);
            LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            nameLp.topMargin = dp(6);
            name.setLayoutParams(nameLp);
            tile.addView(name);

            // 选中态：白色底 + 频道色描边；未选中：浅灰底无描边
            tile.setBackground(roundedBg(getColor(R.color.mx_input_stroke), 12));
            tile.setOnClickListener(v -> {
                if (picked.contains(cfg.id)) {
                    picked.remove(cfg.id);
                    tile.setBackground(roundedBg(getColor(R.color.mx_input_stroke), 12));
                } else {
                    picked.add(cfg.id);
                    GradientDrawable bg = roundedBg(getColor(R.color.mx_surface), 12);
                    bg.setStroke(dp(2), cfg.color);
                    tile.setBackground(bg);
                }
                if (holder[0] != null) {
                    holder[0].getButton(androidx.appcompat.app.AlertDialog.BUTTON_POSITIVE)
                            .setEnabled(!picked.isEmpty());
                }
            });
            grid.addView(tile);
        }
        box.addView(grid);

        MaterialAlertDialogBuilder builder = new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.broadcast_pick_channel)
                .setView(box)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.broadcast_play_confirm, (dialog, which) -> {
                    List<ChannelCfg> targets = new ArrayList<>();
                    for (ChannelCfg cfg : CHANNELS) {
                        if (picked.contains(cfg.id)) {
                            targets.add(cfg);
                        }
                    }
                    if (!targets.isEmpty()) {
                        playToMany(targets, item);
                    }
                });

        holder[0] = builder.create();
        // 未选任何频道时禁用投放按钮
        holder[0].setOnShowListener(d ->
                holder[0].getButton(androidx.appcompat.app.AlertDialog.BUTTON_POSITIVE).setEnabled(false));
        holder[0].show();
    }

    /**
     * 逐个投放到多个频道（对应网页版 doPlay 的串行投放）
     * @param targets 目标频道列表
     * @param item 待投放的音频
     */
    private void playToMany(List<ChannelCfg> targets, AudioItem item) {
        List<String> okNames = new ArrayList<>();
        playSequential(targets, 0, item, okNames);
    }

    /**
     * 串行投放的第 index 步：成功后继续下一个，失败提示后也继续
     * @param targets 目标频道列表
     * @param index 当前处理下标
     * @param item 待投放的音频
     * @param okNames 已成功投放的频道名集合
     */
    private void playSequential(List<ChannelCfg> targets, int index, AudioItem item, List<String> okNames) {
        if (index >= targets.size()) {
            // 全部投完：汇总提示并刷新卡片
            if (okNames.size() == 1) {
                Toast.makeText(this, getString(R.string.broadcast_played_to, okNames.get(0)),
                        Toast.LENGTH_SHORT).show();
            } else if (okNames.size() > 1) {
                Toast.makeText(this,
                        getString(R.string.broadcast_played_to_many, okNames.size(),
                                android.text.TextUtils.join("、", okNames)),
                        Toast.LENGTH_SHORT).show();
            }
            loadChannels();
            return;
        }
        ChannelCfg cfg = targets.get(index);
        BroadcastApi.play(cfg.id, item.id, token, new BroadcastApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                okNames.add(cfg.name);
                playSequential(targets, index + 1, item, okNames);
            }

            @Override
            public void onFailure(String message) {
                Toast.makeText(BroadcastActivity.this, message, Toast.LENGTH_SHORT).show();
                playSequential(targets, index + 1, item, okNames);
            }
        });
    }

    /**
     * 停止频道播放
     * @param cfg 目标频道
     */
    private void stopChannel(ChannelCfg cfg) {
        BroadcastApi.channelAction(cfg.id, "stop", token, new BroadcastApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                JSONObject data = root.optJSONObject("data");
                if (data != null) {
                    states.put(cfg.id, ChannelState.parse(data));
                    updateCards();
                }
            }

            @Override
            public void onFailure(String message) {
                Toast.makeText(BroadcastActivity.this, message, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * 把服务端数组解析进状态缓存
     * @param array 频道状态数组
     */
    private void parseStates(JSONArray array) {
        for (int i = 0; i < array.length(); i++) {
            JSONObject o = array.optJSONObject(i);
            if (o == null) {
                continue;
            }
            ChannelState state = ChannelState.parse(o);
            states.put(state.id, state);
        }
    }

    /**
     * 按最新状态刷新所有卡片
     */
    private void updateCards() {
        for (ChannelCfg cfg : CHANNELS) {
            CardHolder holder = cards.get(cfg.id);
            ChannelState state = states.get(cfg.id);
            if (holder == null || state == null) {
                continue;
            }
            applyCardState(cfg, holder, state);
        }
        probeMissingDurations();
    }

    /**
     * 把单个频道状态映射到卡片（徽章配色、当前音频、提示行、进度条）
     * @param cfg 频道配置
     * @param holder 卡片视图持有者
     * @param state 频道状态
     */
    private void applyCardState(ChannelCfg cfg, CardHolder holder, ChannelState state) {
        boolean playing = ChannelState.STATUS_PLAYING.equals(state.status);
        boolean paused = ChannelState.STATUS_PAUSED.equals(state.status);

        // 状态徽章：播放中主色、已暂停浅色容器、空闲灰色（对应网页版 badge 配色）
        holder.badge.setText(statusText(state.status));
        if (playing) {
            holder.badge.setTextColor(getColor(R.color.mx_on_primary));
            holder.badge.setBackground(roundedBg(cfg.color, 9));
        } else if (paused) {
            holder.badge.setTextColor(getColor(R.color.mx_on_primary_container));
            holder.badge.setBackground(roundedBg(getColor(R.color.mx_primary_container), 9));
        } else {
            holder.badge.setTextColor(getColor(R.color.mx_on_surface_variant));
            holder.badge.setBackground(roundedBg(getColor(R.color.mx_input_stroke), 9));
        }

        holder.now.setText(state.audioName == null
                ? getString(R.string.broadcast_now_none) : state.audioName);
        holder.listeners.setText(getString(R.string.broadcast_channel_listeners, state.listeners));
        holder.stop.setEnabled(!ChannelState.STATUS_IDLE.equals(state.status));
        holder.hint.setText(cardHint(state));

        // 进度条只在「播放中 + 已知总时长」时出现，拖动中不回写位置
        boolean showSeek = playing && state.durationSec > 0;
        holder.seek.setVisibility(showSeek ? View.VISIBLE : View.GONE);
        holder.time.setVisibility(showSeek ? View.VISIBLE : View.GONE);
        if (showSeek) {
            int duration = Math.max(1, (int) Math.floor(state.durationSec));
            int current = (int) Math.min(calcElapsedSec(state), duration);
            holder.seek.setMax(duration);
            if (holder.seek.getTag() == null) {
                holder.seek.setProgress(current);
                holder.time.setText(formatSec(current) + " / " + formatSec(duration));
            }
        }
    }

    /**
     * 生成卡片进度提示文案（网页版：已播放 xx / xx · 由控制台投放）
     * @param state 频道状态
     * @return 提示文字
     */
    private String cardHint(ChannelState state) {
        if (ChannelState.STATUS_PLAYING.equals(state.status)) {
            int elapsed = (int) calcElapsedSec(state);
            String text;
            if (state.durationSec > 0) {
                text = getString(R.string.broadcast_hint_playing_duration,
                        formatSec(elapsed), formatSec((int) state.durationSec));
            } else {
                text = getString(R.string.broadcast_hint_playing, formatSec(elapsed));
            }
            return text + getString(R.string.broadcast_hint_playing_suffix);
        }
        if (ChannelState.STATUS_PAUSED.equals(state.status)) {
            return getString(R.string.broadcast_hint_paused);
        }
        return getString(R.string.broadcast_hint_idle);
    }

    /**
     * 控制台时长探测：频道在播但服务端没有总时长时，读取音频元数据并上报，
     * 让进度条与其他听众的「已播 / 总时长」尽快可用（对应网页版 probeDuration）。
     */
    private void probeMissingDurations() {
        for (ChannelCfg cfg : CHANNELS) {
            ChannelState state = states.get(cfg.id);
            if (state == null || !ChannelState.STATUS_PLAYING.equals(state.status)) {
                continue;
            }
            if (state.durationSec > 0 || state.audioFile == null) {
                continue;
            }
            final String file = state.audioFile;
            if (!probingFiles.add(file)) {
                // 同一文件已在探测中，避免重复请求
                continue;
            }
            final String channelId = cfg.id;
            PROBE_EXECUTOR.execute(() -> {
                double seconds = probeDuration(file);
                runOnUiThread(() -> {
                    probingFiles.remove(file);
                    if (seconds > 0) {
                        // 上报后服务端会广播新快照，卡片自动出现进度条
                        BroadcastApi.reportDuration(channelId, seconds, token);
                    }
                });
            });
        }
    }

    /**
     * 用 MediaMetadataRetriever 读取网络音频的总时长（只拉元数据，不播放）
     * @param file 音频文件名
     * @return 时长（秒），失败返回 0
     */
    private double probeDuration(String file) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            Map<String, String> headers = new HashMap<>();
            headers.put("Authorization", "Bearer " + token);
            retriever.setDataSource(BroadcastApi.audioUrl(file), headers);
            String value = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (value == null || value.isEmpty()) {
                return 0;
            }
            return Double.parseDouble(value) / 1000.0;
        } catch (Exception e) {
            return 0;
        } finally {
            try {
                retriever.release();
            } catch (Exception ignored) {
                // 已释放时忽略
            }
        }
    }

    // ==================== 收听页 ====================

    /**
     * 进入频道收听页：构建界面、连接单频道 SSE、拉取初始状态
     * @param channelId 频道 id
     */
    private void showChannel(String channelId) {
        ChannelCfg cfg = findChannel(channelId);
        if (cfg == null) {
            showConsole();
            return;
        }
        listeningChannel = channelId;
        listeningState = states.get(channelId);
        lastSeq = -1;
        loadedAudioId = null;
        binding.tvTitle.setText(cfg.name);

        closeConsoleSse();
        buildListeningUi(cfg);
        openChannelSse(channelId);
        loadSingleChannel(channelId);
        startTicker();
    }

    /**
     * 构建收听页界面：大卡片展示频道与当前播放情况
     * @param cfg 频道配置
     */
    private void buildListeningUi(ChannelCfg cfg) {
        listenProgress = null;
        listenHint = null;

        ScrollView scroll = new ScrollView(this);
        scroll.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(16), dp(16), dp(16));
        scroll.addView(root, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        MaterialCardView card = new MaterialCardView(this);
        card.setCardBackgroundColor(getColor(R.color.mx_surface));
        card.setRadius(dp(16));
        card.setCardElevation(0);
        root.addView(card, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setPadding(dp(20), dp(28), dp(20), dp(28));
        card.addView(box, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 频道图标：与网页版收听页一致，品牌色圆角底 + 频道 SVG
        ImageView bigIcon = new ImageView(this);
        bigIcon.setImageResource(cfg.iconRes);
        bigIcon.setScaleType(ImageView.ScaleType.FIT_CENTER);
        bigIcon.setBackground(roundedBg(cfg.color, 20));
        int bigPadding = dp(18);
        bigIcon.setPadding(bigPadding, bigPadding, bigPadding, bigPadding);
        LinearLayout.LayoutParams bigIconLp = new LinearLayout.LayoutParams(dp(76), dp(76));
        bigIcon.setLayoutParams(bigIconLp);
        box.addView(bigIcon);

        TextView title = new TextView(this);
        title.setText(cfg.name);
        title.setTextColor(getColor(R.color.mx_on_surface));
        title.setTextSize(22);
        title.getPaint().setFakeBoldText(true);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        titleLp.topMargin = dp(12);
        title.setLayoutParams(titleLp);
        box.addView(title);

        TextView now = new TextView(this);
        now.setId(View.generateViewId());
        now.setText(R.string.broadcast_waiting);
        now.setTextColor(getColor(R.color.mx_on_surface));
        now.setTextSize(15);
        now.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams nowLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nowLp.topMargin = dp(16);
        now.setLayoutParams(nowLp);
        box.addView(now);

        listenProgress = new TextView(this);
        listenProgress.setText(R.string.broadcast_no_progress);
        listenProgress.setTextColor(getColor(R.color.mx_on_surface_variant));
        listenProgress.setTextSize(13);
        listenProgress.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams progressLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        progressLp.topMargin = dp(6);
        listenProgress.setLayoutParams(progressLp);
        box.addView(listenProgress);

        TextView hint = new TextView(this);
        hint.setText(R.string.broadcast_hint_listen_idle);
        hint.setTextColor(getColor(R.color.mx_on_surface_variant));
        hint.setTextSize(12);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.topMargin = dp(20);
        hint.setLayoutParams(hintLp);
        box.addView(hint);
        // 保存提示行引用，随播放状态动态更新（对齐网页版 card-hint）
        listenHint = hint;

        binding.layoutContent.removeAllViews();
        binding.layoutContent.addView(scroll);

        // 保存「当前音频」文字视图引用，供状态刷新时更新
        currentAudioLabel = now;
    }

    /** 收听页的「当前音频」文字视图 */
    @Nullable
    private TextView currentAudioLabel;
    /** 收听页的提示行（已播放 xx / 已暂停 / 未在播放） */
    @Nullable
    private TextView listenHint;

    /**
     * 连接单频道 SSE：第一次连上会收到 snapshot，之后收 command / snapshot
     * @param channelId 频道 id
     */
    private void openChannelSse(String channelId) {
        closeChannelSse();
        channelSse = new BroadcastSse("/api/channels/" + channelId + "/events", token,
                new BroadcastSse.Listener() {
                    @Override
                    public void onEvent(String type, String data) {
                        if ("snapshot".equals(type)) {
                            JSONObject o = parseObject(data);
                            if (o != null) {
                                listeningState = ChannelState.parse(o);
                                renderListening();
                                applyPlayback(listeningState);
                            }
                        } else if ("command".equals(type)) {
                            JSONObject o = parseObject(data);
                            if (o != null) {
                                handleCommand(o);
                            }
                        }
                    }

                    @Override
                    public void onConnection(boolean connected) {
                        setConnectedDot(connected);
                    }
                });
        channelSse.start();
    }

    /** 关闭单频道订阅 */
    private void closeChannelSse() {
        if (channelSse != null) {
            channelSse.stop();
            channelSse = null;
        }
    }

    /**
     * 拉取单频道状态（进入页面时先同步一次，避免等 SSE 首帧）
     * @param channelId 频道 id
     */
    private void loadSingleChannel(String channelId) {
        BroadcastApi.getChannels(token, new BroadcastApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                JSONArray array = root.optJSONArray("data");
                if (array == null) {
                    return;
                }
                parseStates(array);
                ChannelState state = states.get(channelId);
                if (state != null) {
                    listeningState = state;
                    renderListening();
                    applyPlayback(state);
                }
            }

            @Override
            public void onFailure(String message) {
                Toast.makeText(BroadcastActivity.this, message, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * 按最新状态刷新收听页文字
     */
    private void renderListening() {
        if (listeningState == null) {
            return;
        }
        if (currentAudioLabel != null) {
            currentAudioLabel.setText(listeningState.audioName == null
                    ? getString(R.string.broadcast_waiting) : listeningState.audioName);
        }
        if (listenProgress != null) {
            if (listeningState.durationSec > 0) {
                // 收听页的大进度文字：mm:ss / mm:ss（与提示行互补，便于一眼看清总时长）
                listenProgress.setText(formatSec((int) Math.min(calcElapsedSec(listeningState),
                        listeningState.durationSec)) + " / "
                        + formatSec((int) listeningState.durationSec));
            } else if (ChannelState.STATUS_PLAYING.equals(listeningState.status)) {
                listenProgress.setText(formatSec((int) calcElapsedSec(listeningState)));
            } else {
                listenProgress.setText(R.string.broadcast_no_progress);
            }
        }
        // 提示行文案与网页版一致：播放中带来源说明，暂停提示可继续收听
        if (listenHint != null) {
            if (ChannelState.STATUS_PLAYING.equals(listeningState.status)) {
                int elapsed = (int) calcElapsedSec(listeningState);
                String text = listeningState.durationSec > 0
                        ? getString(R.string.broadcast_hint_playing_duration,
                        formatSec(elapsed), formatSec((int) listeningState.durationSec))
                        : getString(R.string.broadcast_hint_playing, formatSec(elapsed));
                listenHint.setText(text + getString(R.string.broadcast_hint_playing_suffix));
            } else if (ChannelState.STATUS_PAUSED.equals(listeningState.status)) {
                listenHint.setText(R.string.broadcast_hint_paused_listen);
            } else {
                listenHint.setText(R.string.broadcast_hint_listen_idle);
            }
        }
    }

    /**
     * 按状态同步播放器：换源播放 / 校正进度 / 暂停 / 停止
     * @param state 频道状态
     */
    private void applyPlayback(ChannelState state) {
        if (ChannelState.STATUS_PLAYING.equals(state.status)) {
            if (state.audioId == null) {
                return;
            }
            double seek = calcSeekSec(state);
            if (!state.audioId.equals(loadedAudioId)) {
                // 新投放的音频：换源并跳到对应位置
                playAudio(BroadcastApi.audioUrl(state.audioFile), state.audioId, seek);
            } else if (PlaybackService.isPrepared()) {
                // 同一音频：确保在播，偏差超过 3 秒才纠正，避免频繁 seek 卡顿
                if (!PlaybackService.isPlaying()) {
                    PlaybackService.resume(this);
                }
                if (Math.abs(PlaybackService.positionSec() - seek) > 3) {
                    PlaybackService.seekTo(this, seek);
                }
            }
        } else if (ChannelState.STATUS_PAUSED.equals(state.status)) {
            if (PlaybackService.isPlaying()) {
                PlaybackService.pause(this);
            }
        } else {
            releasePlayer();
            loadedAudioId = null;
        }
    }

    /**
     * 处理实时指令（play / pause / resume / stop），按 seq 丢弃过期指令
     * @param cmd 指令 JSON
     */
    private void handleCommand(JSONObject cmd) {
        int seq = cmd.optInt("seq", -1);
        if (seq > 0 && seq <= lastSeq) {
            // 过期或重复指令，直接丢弃
            return;
        }
        if (seq > 0) {
            lastSeq = seq;
        }
        String action = cmd.optString("action");

        if ("play".equals(action)) {
            String audioId = cmd.optString("audioId");
            String relativeUrl = cmd.optString("url");
            String fullUrl = com.mingxing.school.BuildConfig.API_BASE_URL + "/broadcast" + relativeUrl;
            playAudio(fullUrl, audioId, 0);
            // 本地先按播放中更新界面，随后收到的 snapshot 会校准
            if (listeningState == null) {
                listeningState = new ChannelState();
                listeningState.id = listeningChannel;
            }
            listeningState.status = ChannelState.STATUS_PLAYING;
            listeningState.audioId = audioId;
            listeningState.audioFile = extractFileName(relativeUrl);
            listeningState.audioName = listeningState.audioFile;
            listeningState.startedAt = System.currentTimeMillis();
            renderListening();
        } else if ("pause".equals(action)) {
            if (PlaybackService.isPlaying()) {
                PlaybackService.pause(this);
            }
            if (listeningState != null) {
                listeningState.status = ChannelState.STATUS_PAUSED;
            }
        } else if ("resume".equals(action)) {
            if (PlaybackService.isPrepared()) {
                PlaybackService.resume(this);
            }
            if (listeningState != null) {
                listeningState.status = ChannelState.STATUS_PLAYING;
                listeningState.startedAt = System.currentTimeMillis();
            }
        } else if ("stop".equals(action)) {
            releasePlayer();
            loadedAudioId = null;
            if (listeningState != null) {
                listeningState.status = ChannelState.STATUS_IDLE;
                listeningState.audioId = null;
                listeningState.audioName = null;
                listeningState.audioFile = null;
                listeningState.startedAt = 0;
            }
            renderListening();
        }
    }

    /**
     * 载入音频并播放
     * @param url 完整音频地址
     * @param audioId 音频 id，用于后续判断是否需要换源
     * @param startSec 起播位置（秒）
     */
    private void playAudio(String url, String audioId, double startSec) {
        loadedAudioId = audioId;

        // 通知卡片文案：主标题用音频名，副标题用频道名
        String title = listeningState != null && listeningState.audioName != null
                ? listeningState.audioName : extractFileName(url);
        ChannelCfg cfg = listeningChannel == null ? null : findChannel(listeningChannel);
        String subtitle = cfg != null
                ? getString(R.string.broadcast_listen) + " · " + cfg.name
                : getString(R.string.broadcast_title);

        // 播放交给前台服务：切后台/息屏后继续播放，并由系统媒体卡片接管控制
        PlaybackService.play(this, url, audioId, title, subtitle, startSec, token);
    }

    /** 停止播放并移除媒体通知（幂等） */
    private void releasePlayer() {
        PlaybackService.stop(this);
    }

    // ==================== 定时刷新 ====================

    /** 每秒执行的刷新任务：控制台更新播放中的卡片进度，收听页更新进度文字 */
    private final Runnable tickTask = new Runnable() {
        @Override
        public void run() {
            if (listeningChannel == null) {
                for (ChannelCfg cfg : CHANNELS) {
                    CardHolder holder = cards.get(cfg.id);
                    ChannelState state = states.get(cfg.id);
                    // 只有播放中的频道需要推进进度，暂停/空闲保留原值
                    if (holder != null && state != null
                            && ChannelState.STATUS_PLAYING.equals(state.status)) {
                        holder.hint.setText(cardHint(state));
                        // 拖动中的进度条不回写，避免打断用户操作
                        if (state.durationSec > 0 && holder.seek.getTag() == null) {
                            int duration = Math.max(1, (int) Math.floor(state.durationSec));
                            int current = (int) Math.min(calcElapsedSec(state), duration);
                            holder.seek.setMax(duration);
                            holder.seek.setProgress(current);
                            holder.time.setText(formatSec(current) + " / " + formatSec(duration));
                        }
                    }
                }
            } else if (listeningState != null) {
                renderListening();
            }
            ticker.postDelayed(this, 1000);
        }
    };

    /** 启动每秒刷新（先移除再添加，避免重复调度） */
    private void startTicker() {
        stopTicker();
        ticker.postDelayed(tickTask, 1000);
    }

    /** 停止每秒刷新 */
    private void stopTicker() {
        ticker.removeCallbacks(tickTask);
    }

    // ==================== 工具方法 ====================

    /**
     * 更新顶栏连接状态圆点
     * @param connected 是否已连接；只有状态变化时才提示，避免频繁打扰
     */
    private void setConnectedDot(boolean connected) {
        binding.viewConn.setBackgroundResource(
                connected ? R.drawable.bg_dot_on : R.drawable.bg_dot_off);
        if (lastConnected && !connected) {
            Toast.makeText(this, R.string.broadcast_connection_lost, Toast.LENGTH_SHORT).show();
        } else if (!lastConnected && connected && listeningChannel != null && lastSeq > 0) {
            Toast.makeText(this, R.string.broadcast_connection_back, Toast.LENGTH_SHORT).show();
        }
        lastConnected = connected;
    }

    /**
     * 按 id 查找频道配置
     * @param id 频道 id
     * @return 配置对象，找不到返回 null
     */
    @Nullable
    private ChannelCfg findChannel(String id) {
        for (ChannelCfg cfg : CHANNELS) {
            if (cfg.id.equals(id)) {
                return cfg;
            }
        }
        return null;
    }

    /**
     * 计算频道已播放秒数
     * @param state 频道状态
     * @return 已播秒数，未知时返回 0
     */
    private double calcElapsedSec(ChannelState state) {
        if (state.startedAt <= 0) {
            return 0;
        }
        return Math.max(0, (System.currentTimeMillis() - state.startedAt) / 1000.0);
    }

    /**
     * 计算进入频道时应跳转到的播放位置，靠近结尾时钳制到结束前一秒
     * @param state 频道状态
     * @return 目标位置（秒）
     */
    private double calcSeekSec(ChannelState state) {
        double elapsed = calcElapsedSec(state);
        if (state.durationSec > 0) {
            elapsed = Math.min(elapsed, Math.max(0, state.durationSec - 1));
        }
        return elapsed;
    }

    /**
     * 把状态字符串转成中文文案
     * @param status idle / playing / paused
     * @return 中文状态
     */
    private String statusText(String status) {
        if (ChannelState.STATUS_PLAYING.equals(status)) {
            return getString(R.string.broadcast_status_playing);
        }
        if (ChannelState.STATUS_PAUSED.equals(status)) {
            return getString(R.string.broadcast_status_paused);
        }
        return getString(R.string.broadcast_status_idle);
    }

    /**
     * 从相对地址中取出文件名并解码
     * @param relativeUrl 形如 /audio/%E4%B8%8A%E8%AF%BE%E9%93%83.mp3
     * @return 解码后的文件名
     */
    private String extractFileName(String relativeUrl) {
        int index = relativeUrl.lastIndexOf('/');
        String name = index >= 0 ? relativeUrl.substring(index + 1) : relativeUrl;
        try {
            return java.net.URLDecoder.decode(name, "UTF-8");
        } catch (Exception e) {
            return name;
        }
    }

    /**
     * 秒数格式化为 mm:ss
     * @param totalSec 总秒数
     * @return 形如 03:25 的文本
     */
    private String formatSec(int totalSec) {
        int m = Math.max(0, totalSec) / 60;
        int s = Math.max(0, totalSec) % 60;
        return String.format(java.util.Locale.CHINA, "%02d:%02d", m, s);
    }

    /**
     * 时间戳格式化（音频修改时间）
     * @param millis 毫秒时间戳，0 表示未知
     * @return 形如 2026-10-28 20:30 的文本，未知时返回「未知时间」
     */
    private String formatDateTime(long millis) {
        if (millis <= 0) {
            return "未知时间";
        }
        return new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.CHINA)
                .format(new java.util.Date(millis));
    }

    /**
     * 解析 SSE 数据为 JSON 数组
     * @param data 事件原文
     * @return 数组，解析失败返回 null
     */
    @Nullable
    private JSONArray parseArray(String data) {
        try {
            return new JSONArray(data);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 解析 SSE 数据为 JSON 对象
     * @param data 事件原文
     * @return 对象，解析失败返回 null
     */
    @Nullable
    private JSONObject parseObject(String data) {
        try {
            return new JSONObject(data);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 生成纯色圆角背景
     * @param color 颜色
     * @param radiusDp 圆角半径（dp）
     * @return 圆角矩形 drawable
     */
    private GradientDrawable roundedBg(int color, int radiusDp) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(color);
        bg.setCornerRadius(dp(radiusDp));
        return bg;
    }

    /**
     * 读取主题中的水波纹点击背景
     * @return drawable 资源 id
     */
    private int selectableBackground() {
        android.util.TypedValue value = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, value, true);
        return value.resourceId;
    }

    /**
     * 构建列表分隔线
     * @return 1dp 高的浅色线
     */
    private View divider() {
        View line = new View(this);
        line.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(1))));
        line.setBackgroundColor(getColor(R.color.mx_input_stroke));
        return line;
    }

    // ==================== 数据结构 ====================

    /** 频道配置：id 用于接口，name 用于显示，color 用于主题色，iconRes 用网页版频道 SVG 转成的矢量图 */
    private static final class ChannelCfg {
        /** 频道英文 id，如 classroom */
        final String id;
        /** 频道中文名，如 教室 */
        final String name;
        /** 频道主题色（不随深浅色变化） */
        final int color;
        /** 频道图标（白色矢量图，配合频道色底使用） */
        final int iconRes;

        /**
         * 构造频道配置
         * @param id 英文 id
         * @param name 中文名
         * @param color 主题色
         * @param iconRes 图标资源
         */
        ChannelCfg(String id, String name, int color, int iconRes) {
            this.id = id;
            this.name = name;
            this.color = color;
            this.iconRes = iconRes;
        }
    }

    /** 频道运行时状态，对应服务端 channelStore 的快照字段 */
    private static final class ChannelState {

        /** 空闲状态 */
        static final String STATUS_IDLE = "idle";
        /** 播放中状态 */
        static final String STATUS_PLAYING = "playing";
        /** 已暂停状态 */
        static final String STATUS_PAUSED = "paused";

        /** 频道 id */
        String id;
        /** 频道名 */
        String name;
        /** 状态：idle / playing / paused */
        String status = STATUS_IDLE;
        /** 当前音频 id */
        @Nullable
        String audioId;
        /** 当前音频显示名 */
        @Nullable
        String audioName;
        /** 当前音频文件名 */
        @Nullable
        String audioFile;
        /** 音频总时长（秒），0 表示未知 */
        double durationSec;
        /** 本轮播放的起始时间戳（毫秒），0 表示未开始 */
        long startedAt;
        /** 状态版本号，用于丢弃过期指令 */
        int seq;
        /** 当前听众数 */
        int listeners;

        /**
         * 从服务端快照解析状态
         * @param o 快照 JSON
         * @return 状态对象
         */
        static ChannelState parse(JSONObject o) {
            ChannelState s = new ChannelState();
            s.id = o.optString("id");
            s.name = o.optString("name");
            s.status = o.optString("status", STATUS_IDLE);
            s.audioId = optStringOrNull(o, "audioId");
            s.audioName = optStringOrNull(o, "audioName");
            s.audioFile = optStringOrNull(o, "audioFile");
            s.durationSec = o.optDouble("durationSec", 0);
            if (Double.isNaN(s.durationSec) || Double.isInfinite(s.durationSec)) {
                s.durationSec = 0;
            }
            s.startedAt = o.optLong("startedAt", 0);
            s.seq = o.optInt("seq", 0);
            s.listeners = o.optInt("listeners", 0);
            return s;
        }

        /**
         * 读取可能为 JSON null 的字符串字段
         * @param o JSON 对象
         * @param key 字段名
         * @return 非空字符串或 null
         */
        @Nullable
        private static String optStringOrNull(JSONObject o, String key) {
            String value = o.optString(key, "");
            return value.isEmpty() || "null".equals(value) ? null : value;
        }
    }

    /** 卡片视图持有者，避免每秒重建视图 */
    private static final class CardHolder {
        /** 状态徽章 */
        final TextView badge;
        /** 当前音频名 */
        final TextView now;
        /** 进度提示行（已播放 xx / xx · 由控制台投放） */
        final TextView hint;
        /** 听众数 */
        final TextView listeners;
        /** 进度时间文字 */
        final TextView time;
        /** 停止按钮 */
        final MaterialButton stop;
        /** 可拖动进度条 */
        final SeekBar seek;

        /**
         * 构造卡片持有者
         * @param badge 状态徽章
         * @param now 当前音频
         * @param hint 进度提示行
         * @param listeners 听众数
         * @param time 时间文字
         * @param stop 停止按钮
         * @param seek 可拖动进度条
         */
        CardHolder(TextView badge, TextView now, TextView hint, TextView listeners,
                   TextView time, MaterialButton stop, SeekBar seek) {
            this.badge = badge;
            this.now = now;
            this.hint = hint;
            this.listeners = listeners;
            this.time = time;
            this.stop = stop;
            this.seek = seek;
        }
    }

    /** 音频条目 */
    private static final class AudioItem {
        /** 音频 id */
        String id;
        /** 显示名（不含扩展名） */
        String name;
        /** 原始文件名（用于拼接播放地址） */
        String file;
        /** 文件大小（字节） */
        long size;
        /** 文件修改时间（毫秒时间戳），0 表示服务端未返回 */
        long mtime;
    }
}