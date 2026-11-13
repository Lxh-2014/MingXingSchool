package com.mingxing.school.broadcast;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

import com.mingxing.school.R;

import java.util.HashMap;
import java.util.Map;

/**
 * 音频播放前台服务：把「收听频道」的播放器从页面迁移到服务里，
 * 配合 MediaSession + 媒体样式通知，实现：
 *   1) 小米/其它机型的状态栏、锁屏、控制中心显示播放卡片（标题、频道名、暂停/继续/停止）
 *   2) 切到后台或息屏后继续播放，不被系统回收
 * 页面通过本类的静态方法下发播放/暂停/停止指令，无需绑定服务。
 */
public class PlaybackService extends Service {

    /** 通知渠道 id（Android 8.0+ 必须归属渠道） */
    private static final String CHANNEL_ID = "broadcast_playback";
    /** 前台通知 id */
    private static final int NOTIFICATION_ID = 2001;

    /** 指令：开始播放（携带音频地址、标题、起始位置、令牌） */
    private static final String ACTION_PLAY = "com.mingxing.school.PLAYBACK_PLAY";
    /** 指令：暂停 */
    private static final String ACTION_PAUSE = "com.mingxing.school.PLAYBACK_PAUSE";
    /** 指令：继续播放 */
    private static final String ACTION_RESUME = "com.mingxing.school.PLAYBACK_RESUME";
    /** 指令：停止并移除通知 */
    private static final String ACTION_STOP = "com.mingxing.school.PLAYBACK_STOP";
    /** 指令：跳转到指定位置（秒） */
    private static final String ACTION_SEEK = "com.mingxing.school.PLAYBACK_SEEK";

    private static final String EXTRA_URL = "url";               // 音频完整地址
    private static final String EXTRA_AUDIO_ID = "audioId";      // 音频 id（页面用于判断换源）
    private static final String EXTRA_TITLE = "title";           // 通知主标题（音频名）
    private static final String EXTRA_SUBTITLE = "subtitle";     // 通知副标题（频道名）
    private static final String EXTRA_START_SEC = "startSec";    // 起播位置（秒）
    private static final String EXTRA_TOKEN = "token";           // 登录令牌，音频接口需要
    private static final String EXTRA_SEEK_SEC = "seekSec";      // 跳转目标位置（秒）

    /** 播放状态回调：页面用来处理「播放完成」「播放失败」两类一次性事件 */
    public interface Listener {
        /** 音频正常播放完毕 */
        void onCompleted();

        /** 音频准备或播放失败 */
        void onError();
    }

    /** 静态播放器实例：服务内单例，页面可通过静态方法读取进度 */
    private static MediaPlayer sPlayer;
    /** 播放器是否已完成 prepare（未完成时不能 start/seek） */
    private static boolean sPrepared;
    /** 当前音频 id */
    private static String sAudioId;
    /** 通知主标题（音频名） */
    private static String sTitle = "";
    /** 通知副标题（频道名） */
    private static String sSubtitle = "";
    /** 页面注册的状态回调，可为空 */
    private static Listener sListener;

    /** 媒体会话：向系统暴露播放状态与控制入口 */
    private MediaSessionCompat session;
    /** 通知管理器，用于建渠道与更新通知 */
    private NotificationManager notificationManager;

    // ==================== 页面侧静态门面 ====================

    /**
     * 开始播放一段音频（会替换当前正在播放的音频）
     * @param context 上下文
     * @param url 音频完整地址
     * @param audioId 音频 id
     * @param title 通知标题（音频名）
     * @param subtitle 通知副标题（频道名）
     * @param startSec 起播位置（秒）
     * @param token 登录令牌
     */
    public static void play(Context context, String url, String audioId,
                            String title, String subtitle, double startSec, String token) {
        Intent intent = new Intent(context, PlaybackService.class);
        intent.setAction(ACTION_PLAY);
        intent.putExtra(EXTRA_URL, url);
        intent.putExtra(EXTRA_AUDIO_ID, audioId);
        intent.putExtra(EXTRA_TITLE, title);
        intent.putExtra(EXTRA_SUBTITLE, subtitle);
        intent.putExtra(EXTRA_START_SEC, startSec);
        intent.putExtra(EXTRA_TOKEN, token);
        context.startService(intent);
    }

    /** 暂停当前播放（保留播放位置与通知） */
    public static void pause(Context context) {
        sendSimple(context, ACTION_PAUSE);
    }

    /** 继续播放当前音频 */
    public static void resume(Context context) {
        sendSimple(context, ACTION_RESUME);
    }

    /** 停止播放并移除通知 */
    public static void stop(Context context) {
        sendSimple(context, ACTION_STOP);
    }

    /**
     * 跳转到指定位置
     * @param context 上下文
     * @param sec 目标位置（秒）
     */
    public static void seekTo(Context context, double sec) {
        Intent intent = new Intent(context, PlaybackService.class);
        intent.setAction(ACTION_SEEK);
        intent.putExtra(EXTRA_SEEK_SEC, sec);
        context.startService(intent);
    }

    /** @return 播放器是否已准备就绪 */
    public static boolean isPrepared() {
        return sPrepared && sPlayer != null;
    }

    /** @return 当前是否正在播放 */
    public static boolean isPlaying() {
        try {
            return sPrepared && sPlayer != null && sPlayer.isPlaying();
        } catch (IllegalStateException e) {
            return false;
        }
    }

    /** @return 当前播放位置（秒），未知时返回 0 */
    public static double positionSec() {
        try {
            return (sPrepared && sPlayer != null) ? sPlayer.getCurrentPosition() / 1000.0 : 0;
        } catch (IllegalStateException e) {
            return 0;
        }
    }

    /**
     * 注册播放状态回调（页面销毁时应传 null 解除，避免内存泄漏）
     * @param listener 回调
     */
    public static void setListener(Listener listener) {
        sListener = listener;
    }

    /**
     * 下发无参数的简单指令
     * @param context 上下文
     * @param action 指令
     */
    private static void sendSimple(Context context, String action) {
        Intent intent = new Intent(context, PlaybackService.class);
        intent.setAction(action);
        context.startService(intent);
    }

    // ==================== 生命周期 ====================

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        createChannel();
        createSession();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) {
            return START_NOT_STICKY;
        }
        switch (action) {
            case ACTION_PLAY:
                startPlay(intent);
                break;
            case ACTION_PAUSE:
                pauseInternal();
                break;
            case ACTION_RESUME:
                resumeInternal();
                break;
            case ACTION_STOP:
                stopInternal();
                break;
            case ACTION_SEEK:
                seekInternal(intent.getDoubleExtra(EXTRA_SEEK_SEC, 0));
                break;
            default:
                break;
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        releasePlayer();
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        super.onDestroy();
    }

    // ==================== 通知与媒体会话 ====================

    /** 创建通知渠道（Android 8.0+），名称交给系统展示 */
    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.playback_channel_name),
                NotificationManager.IMPORTANCE_LOW);   // 低优先级：无提示音，不打扰
        channel.setShowBadge(false);
        notificationManager.createNotificationChannel(channel);
    }

    /** 建立媒体会话并接管系统媒体按钮（播放/暂停/停止/拖动进度） */
    private void createSession() {
        session = new MediaSessionCompat(this, "MingxingBroadcast");
        session.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                resumeInternal();
            }

            @Override
            public void onPause() {
                pauseInternal();
            }

            @Override
            public void onStop() {
                stopInternal();
            }

            @Override
            public void onSeekTo(long pos) {
                seekInternal(pos / 1000.0);
            }
        });
        session.setActive(true);
    }

    /**
     * 构建媒体样式通知（状态栏/锁屏/控制中心展示的播放卡片）
     * @param playing 当前是否正在播放，用于切换「暂停」与「继续」按钮
     * @return 通知对象
     */
    private Notification buildNotification(boolean playing) {
        // 点击通知回到广播器页面
        Intent contentIntent = new Intent(this, BroadcastActivity.class);
        contentIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, contentIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // 暂停 / 继续按钮
        int toggleIcon = playing ? R.drawable.ic_pause : R.drawable.ic_play;
        int toggleTitle = playing ? R.string.playback_pause : R.string.playback_resume;
        PendingIntent toggle = PendingIntent.getService(this, 1, new Intent(this, PlaybackService.class)
                        .setAction(playing ? ACTION_PAUSE : ACTION_RESUME),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // 停止按钮
        PendingIntent stop = PendingIntent.getService(this, 2, new Intent(this, PlaybackService.class)
                        .setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification_music)
                .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher))
                .setContentTitle(sTitle.isEmpty() ? getString(R.string.broadcast_title) : sTitle)
                .setContentText(sSubtitle)
                .setContentIntent(content)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(playing)
                .addAction(toggleIcon, getString(toggleTitle), toggle)
                .addAction(R.drawable.ic_stop, getString(R.string.playback_stop), stop)
                .setStyle(new MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1))
                .build();
    }

    /**
     * 刷新前台通知：首次调用会进入前台，之后只更新内容
     * @param playing 是否正在播放
     */
    private void updateForeground(boolean playing) {
        Notification notification = buildNotification(playing);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    /**
     * 更新媒体会话的播放状态，系统据此渲染控制中心的按钮与进度
     * @param state 播放状态（PlaybackStateCompat.STATE_*）
     * @param positionSec 当前进度（秒）
     */
    private void updateSessionState(int state, double positionSec) {
        if (session == null) {
            return;
        }
        PlaybackStateCompat playbackState = new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY
                        | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_STOP
                        | PlaybackStateCompat.ACTION_SEEK_TO)
                .setState(state, Math.max(0, (long) (positionSec * 1000)), 1f)
                .build();
        session.setPlaybackState(playbackState);
        session.setMetadata(new android.support.v4.media.MediaMetadataCompat.Builder()
                .putString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_TITLE, sTitle)
                .putString(android.support.v4.media.MediaMetadataCompat.METADATA_KEY_ARTIST, sSubtitle)
                .build());
    }

    // ==================== 播放控制 ====================

    /**
     * 处理播放指令：替换旧播放器、准备新音源并起播
     * @param intent 携带地址、标题、起播位置与令牌的指令
     */
    private void startPlay(Intent intent) {
        String url = intent.getStringExtra(EXTRA_URL);
        if (url == null || url.isEmpty()) {
            return;
        }
        sAudioId = intent.getStringExtra(EXTRA_AUDIO_ID);
        sTitle = safeText(intent.getStringExtra(EXTRA_TITLE));
        sSubtitle = safeText(intent.getStringExtra(EXTRA_SUBTITLE));
        double startSec = intent.getDoubleExtra(EXTRA_START_SEC, 0);
        String token = intent.getStringExtra(EXTRA_TOKEN);

        releasePlayer();

        MediaPlayer mp = new MediaPlayer();
        mp.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build());
        // 音频接口受登录保护，必须带上 Authorization 头
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", "Bearer " + token);
        try {
            mp.setDataSource(this, Uri.parse(url), headers);
        } catch (Exception e) {
            notifyError();
            return;
        }
        mp.setOnPreparedListener(prepared -> {
            sPrepared = true;
            if (startSec > 0.5) {
                prepared.seekTo((int) (startSec * 1000));
            }
            prepared.start();
            updateForeground(true);
            updateSessionState(PlaybackStateCompat.STATE_PLAYING, startSec);
        });
        mp.setOnErrorListener((prepared, what, extra) -> {
            sPrepared = false;
            notifyError();
            return true;
        });
        // 播完通知系统与页面，让所有听众一起回到空闲（与网页版 audio ended 一致）
        mp.setOnCompletionListener(completed -> {
            sPrepared = false;
            updateSessionState(PlaybackStateCompat.STATE_STOPPED, 0);
            if (notificationManager != null) {
                notificationManager.cancel(NOTIFICATION_ID);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            if (sListener != null) {
                sListener.onCompleted();
            }
            stopSelf();
        });
        sPlayer = mp;
        sPrepared = false;
        // 先在通知栏展示「载入中」，避免起播前出现空档
        updateForeground(false);
        updateSessionState(PlaybackStateCompat.STATE_BUFFERING, startSec);
        mp.prepareAsync();
    }

    /** 暂停播放并同步通知与会话状态 */
    private void pauseInternal() {
        if (!isPrepared() || !isPlaying()) {
            return;
        }
        sPlayer.pause();
        updateForeground(false);
        updateSessionState(PlaybackStateCompat.STATE_PAUSED, positionSec());
    }

    /** 继续播放并同步通知与会话状态 */
    private void resumeInternal() {
        if (!isPrepared()) {
            return;
        }
        sPlayer.start();
        updateForeground(true);
        updateSessionState(PlaybackStateCompat.STATE_PLAYING, positionSec());
    }

    /**
     * 跳转播放位置
     * @param sec 目标位置（秒）
     */
    private void seekInternal(double sec) {
        if (!isPrepared()) {
            return;
        }
        sPlayer.seekTo((int) (sec * 1000));
        updateSessionState(isPlaying()
                ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, sec);
    }

    /** 停止播放、移除通知并结束服务 */
    private void stopInternal() {
        releasePlayer();
        updateSessionState(PlaybackStateCompat.STATE_STOPPED, 0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    /** 释放播放器（幂等） */
    private void releasePlayer() {
        sPrepared = false;
        MediaPlayer mp = sPlayer;
        sPlayer = null;
        if (mp != null) {
            try {
                mp.reset();
            } catch (Exception ignored) {
                // 已释放时 reset 会抛异常，忽略
            }
            try {
                mp.release();
            } catch (Exception ignored) {
                // 重复释放忽略
            }
        }
    }

    /** 通知页面播放失败：页面负责弹提示 */
    private void notifyError() {
        updateSessionState(PlaybackStateCompat.STATE_ERROR, 0);
        if (sListener != null) {
            sListener.onError();
        }
        stopInternal();
    }

    /**
     * 空值兜底：Intent 取到的字符串可能为 null
     * @param value 原始值
     * @return 非空字符串
     */
    private String safeText(String value) {
        return value == null ? "" : value;
    }
}
