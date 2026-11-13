package com.mingxing.school.im;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.mingxing.school.R;
import com.mingxing.school.data.SessionStore;
import com.mingxing.school.net.ApiClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 邻语消息提醒服务
 * ----------------------------------------------------------
 * 作用：App 退到后台或锁屏后，仍能及时收到新消息提醒。
 * 实现：以前台服务方式运行（通知栏隐藏常驻通知），优先用 WebSocket 实时接收推送，
 *       同时保留 15 秒轮询作为兜底（长连接断开或服务端不可达时仍能提醒）。
 * 提醒规则：
 *   - 只提醒别人发来的新消息（自己发的跳过）；
 *   - 免打扰 / 屏蔽的会话不提醒；
 *   - 正停留在该会话聊天页时不提醒；
 *   - 首次运行只记录基线，不补提醒历史消息。
 */
public class ImMessageService extends Service {

    /** 前台服务常驻通知 ID */
    private static final int NOTIFY_SERVICE = 1001;
    /** 新消息通知 ID 偏移量，避免与常驻通知 ID 冲突 */
    private static final int NOTIFY_BASE = 2000;
    /** 常驻通知渠道（隐藏：通知栏不显示，仅用于满足前台服务的系统要求） */
    private static final String CHANNEL_SERVICE = "im_service_v3";
    /** 旧版常驻通知渠道 ID：升级后主动删除，避免通知栏残留旧通知 */
    private static final String[] CHANNEL_SERVICE_OLD = {"im_service", "im_service_v2"};
    /** 新消息通知渠道（高优先级，可横幅弹出并有提示音） */
    private static final String CHANNEL_MESSAGE = "im_message_v2";
    /** 旧版新消息渠道：渠道重要性一旦创建就无法修改，升级时删除旧渠道并用新 ID 重建 */
    private static final String[] CHANNEL_MESSAGE_OLD = {"im_message"};
    /** 轮询兜底间隔（毫秒）：WebSocket 正常时不需要轮询，放宽到 15 秒省电 */
    private static final long POLL_MS = 15000;
    /** 记录各会话已提醒消息 ID 的本地文件名 */
    private static final String PREF_STATE = "im_notify_state";
    /** 头像下载超时（毫秒） */
    private static final int AVATAR_TIMEOUT_MS = 5000;

    /** 主线程 Handler：定时轮询与通知回调都在主线程执行 */
    private Handler handler;
    /** 登录会话存储：取令牌与当前用户 ID */
    private SessionStore session;
    /** 已提醒消息记录：key=conv_会话ID，value=最后一条已提醒消息 ID */
    private SharedPreferences state;
    /** WebSocket 客户端：仅用于长连接（读写超时置 0 表示常驻） */
    private okhttp3.OkHttpClient wsClient;
    /** 当前 WebSocket 连接，null 表示未连接 */
    private okhttp3.WebSocket webSocket;
    /** 重连尝试次数：用于指数退避，连接成功后清零 */
    private int wsRetry;
    /** 是否已主动断开（服务销毁后不再自动重连） */
    private boolean wsClosed;

    /**
     * 启动消息提醒服务（已登录时调用）
     * @param context 任意上下文
     */
    public static void start(Context context) {
        try {
            ContextCompat.startForegroundService(context,
                    new Intent(context, ImMessageService.class));
        } catch (Exception ignored) {
            // Android 12+ 在后台限制启动前台服务，此时静默失败不影响 App 使用
        }
    }

    /**
     * 停止消息提醒服务（退出登录时调用，避免未登录状态下继续轮询）
     * @param context 任意上下文
     */
    public static void stop(Context context) {
        context.stopService(new Intent(context, ImMessageService.class));
    }

    /**
     * 取消某个会话的消息通知（进入该会话时调用，及时清掉通知栏提醒）
     * @param context 任意上下文
     * @param convId 会话 ID
     */
    public static void cancelFor(Context context, String convId) {
        if (convId == null) return;
        NotificationManagerCompat.from(context).cancel(notifyIdOf(convId));
    }

    /**
     * 计算会话通知 ID：同一会话始终复用同一个 ID，新消息只更新原通知
     * @param convId 会话 ID
     * @return 通知 ID
     */
    private static int notifyIdOf(String convId) {
        return (convId.hashCode() & 0x7fffffff) + NOTIFY_BASE;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        session = new SessionStore(this);
        state = getSharedPreferences(PREF_STATE, MODE_PRIVATE);
        // 长连接客户端：25 秒 ping 心跳，读超时关闭（由 ping 保活）
        wsClient = new okhttp3.OkHttpClient.Builder()
                .connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(0, java.util.concurrent.TimeUnit.SECONDS)
                .pingInterval(25, java.util.concurrent.TimeUnit.SECONDS)
                .build();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 未登录时直接停止：没有令牌无法拉取会话
        if (!session.isLoggedIn()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(NOTIFY_SERVICE, buildServiceNotification());
        connectWebSocket();                     // 优先建立实时推送连接
        handler.removeCallbacks(pollTask);
        handler.post(pollTask);
        // 被系统回收后尝试重新创建，保证提醒持续
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        closeWebSocket();
        if (handler != null) {
            handler.removeCallbacksAndMessages(null);
        }
    }

    /**
     * 建立 WebSocket 长连接（登录令牌放在 query 中，原生端无法设置握手头）
     */
    private void connectWebSocket() {
        String token = session.getToken();
        if (token.isEmpty() || wsClient == null) return;
        closeWebSocket();
        wsClosed = false;

        String base = ApiClient.baseUrl();
        String wsUrl = base.replaceFirst("^http", "ws")
                + "/im/ws?token=" + Uri.encode(token);
        okhttp3.Request request = new okhttp3.Request.Builder().url(wsUrl).build();
        webSocket = wsClient.newWebSocket(request, new okhttp3.WebSocketListener() {
            @Override
            public void onOpen(okhttp3.WebSocket ws, okhttp3.Response response) {
                wsRetry = 0;                    // 连接成功，重置退避次数
            }

            @Override
            public void onMessage(okhttp3.WebSocket ws, String text) {
                handleWsMessage(text);
            }

            @Override
            public void onClosed(okhttp3.WebSocket ws, int code, String reason) {
                webSocket = null;
                // 4001 = 未登录：不重连，等待用户重新登录
                if (!wsClosed && code != 4001) scheduleReconnect();
            }

            @Override
            public void onFailure(okhttp3.WebSocket ws, Throwable t, okhttp3.Response response) {
                webSocket = null;
                if (!wsClosed) scheduleReconnect();
            }
        });
    }

    /**
     * 主动关闭连接，并阻止自动重连
     */
    private void closeWebSocket() {
        wsClosed = true;
        okhttp3.WebSocket ws = webSocket;
        webSocket = null;
        if (ws != null) {
            try {
                ws.close(1000, "bye");
            } catch (Exception ignored) {
                // 连接已断开时忽略
            }
        }
    }

    /**
     * 断线重连：2s 起步指数退避，最长 30s
     */
    private void scheduleReconnect() {
        if (handler == null || wsClosed) return;
        long delay = Math.min(30000L, 2000L * (1L << Math.min(wsRetry, 4)));
        wsRetry++;
        handler.postDelayed(this::connectWebSocket, delay);
    }

    /**
     * 处理服务端推送（在 OkHttp 线程回调，转主线程统一处理）
     * @param text 推送 JSON 文本
     */
    private void handleWsMessage(String text) {
        try {
            JSONObject json = new JSONObject(text);
            if (!"message".equals(json.optString("type"))) return;
            JSONObject conv = json.optJSONObject("conversation");
            JSONObject msg = json.optJSONObject("message");
            if (conv == null || msg == null) return;
            handler.post(() -> handleRealtimeMessage(conv, msg));
        } catch (Exception ignored) {
            // 非 JSON 或字段缺失：忽略该条推送
        }
    }

    /**
     * 处理实时推送的新消息：提醒规则与轮询保持一致
     * @param conv 会话摘要（id / type / title / prefs）
     * @param msg 消息体
     */
    private void handleRealtimeMessage(JSONObject conv, JSONObject msg) {
        String convId = conv.optString("id");
        String msgId = msg.optString("id");
        if (convId.isEmpty() || msgId.isEmpty()) return;

        String key = "conv_" + convId;
        if (msgId.equals(state.getString(key, null))) return;   // 同一条消息重复推送

        // 先记录再提醒，避免轮询兜底重复通知
        state.edit().putString(key, msgId).apply();

        // 自己发的消息不提醒
        String myId = session.getUserId();
        if (!myId.isEmpty() && myId.equals(msg.optString("senderId"))) return;

        // 免打扰 / 屏蔽的会话不提醒
        JSONObject prefs = conv.optJSONObject("prefs");
        if (prefs != null && (prefs.optBoolean("muted") || prefs.optBoolean("blocked"))) {
            return;
        }
        // 正停留在该会话聊天页时不提醒
        if (ImActivity.isViewingConv(convId)) return;

        showMessageNotification(conv, msg);
    }

    /** 轮询任务：按间隔持续拉取会话列表 */
    private final Runnable pollTask = new Runnable() {
        @Override
        public void run() {
            pollOnce();
            handler.postDelayed(this, POLL_MS);
        }
    };

    /**
     * 拉取一次会话列表并处理新消息提醒
     */
    private void pollOnce() {
        String token = session.getToken();
        if (token.isEmpty()) return;
        ApiClient.get("/im/api/conversations", token, new ApiClient.Callback() {
            @Override
            public void onSuccess(JSONObject json) {
                handleConversations(json.optJSONArray("data"));
            }

            @Override
            public void onFailure(String message) {
                // 网络异常或登录失效：本轮跳过，下轮继续尝试
            }
        });
    }

    /**
     * 处理会话列表：对比本地记录判断哪些会话出现了新消息
     * @param arr 会话数组，可能为空
     */
    private void handleConversations(@Nullable JSONArray arr) {
        if (arr == null) return;
        String myId = session.getUserId();
        SharedPreferences.Editor editor = state.edit();
        boolean changed = false;                     // 是否有记录变化，需要提交

        for (int i = 0; i < arr.length(); i++) {
            JSONObject conv = arr.optJSONObject(i);
            if (conv == null) continue;
            String convId = conv.optString("id");
            JSONObject last = conv.optJSONObject("lastMessage");
            if (convId.isEmpty() || last == null) continue;

            String msgId = last.optString("id");
            if (msgId.isEmpty()) continue;

            String key = "conv_" + convId;
            String remembered = state.getString(key, null);
            if (remembered == null) {
                // 首次见到该会话：只记录基线，不补提醒历史消息
                editor.putString(key, msgId);
                changed = true;
                continue;
            }
            if (msgId.equals(remembered)) {
                // 没有新消息：未读已清零时顺便撤掉该会话通知
                if (conv.optInt("unread", 0) == 0) {
                    cancelFor(this, convId);
                }
                continue;
            }

            // 出现新消息：先记录再提醒，避免下一次轮询重复通知
            editor.putString(key, msgId);
            changed = true;

            // 自己发送的消息不提醒
            if (!myId.isEmpty() && myId.equals(last.optString("senderId"))) continue;
            // 免打扰 / 屏蔽的会话不提醒
            JSONObject prefs = conv.optJSONObject("prefs");
            if (prefs != null && (prefs.optBoolean("muted") || prefs.optBoolean("blocked"))) {
                continue;
            }
            // 正停留在该会话聊天页时不提醒
            if (ImActivity.isViewingConv(convId)) continue;

            showMessageNotification(conv, last);
        }

        if (changed) {
            editor.apply();
        }
    }

    /**
     * 弹出某个会话的新消息通知（标题为会话名，正文为「发送者：内容」，右侧为发送者头像）
     * @param conv 会话 JSON
     * @param last 新消息 JSON
     */
    private void showMessageNotification(JSONObject conv, JSONObject last) {
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return;

        final String convId = conv.optString("id");
        final String title = conv.optString("title", getString(R.string.im_title));
        final boolean isGroup = "group".equals(conv.optString("type"));

        String senderId = last.optString("senderId", "");
        String senderNick = last.optString("senderNick", "");
        String senderName = senderNick.isEmpty()
                ? last.optString("senderName", "") : senderNick;
        String summary = summaryOf(last);
        // 群聊正文带发送者前缀（与 QQ 群通知一致），单聊标题已是对方名称
        String body = (isGroup && !senderName.isEmpty())
                ? senderName + "：" + summary : summary;

        // 点击通知：打开邻语并直接进入该会话
        Intent open = new Intent(this, ImActivity.class)
                .putExtra(ImActivity.EXTRA_CONV_ID, convId)
                .putExtra(ImActivity.EXTRA_CONV_TITLE, title)
                .putExtra(ImActivity.EXTRA_CONV_GROUP, isGroup)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, notifyIdOf(convId), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        final NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_MESSAGE)
                .setSmallIcon(R.drawable.ic_im_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(false)
                .setAutoCancel(true)
                .setShowWhen(true)
                .setContentIntent(contentIntent);

        // 右侧大图标用发送者头像；没有头像时保持默认
        String avatarUrl = senderId.isEmpty()
                ? "" : ImApi.absolute("/api/user-avatar/" + Uri.encode(senderId));
        if (avatarUrl.isEmpty()) {
            post(builder, notifyIdOf(convId));
            return;
        }
        final int notifyId = notifyIdOf(convId);
        new Thread(() -> {
            Bitmap bitmap = downloadAvatar(avatarUrl);
            handler.post(() -> {
                if (bitmap != null) {
                    builder.setLargeIcon(bitmap);
                }
                post(builder, notifyId);
            });
        }).start();
    }

    /**
     * 提交通知（未授权或系统限制时静默失败）
     * @param builder 通知构造器
     * @param id 通知 ID
     */
    private void post(NotificationCompat.Builder builder, int id) {
        try {
            NotificationManagerCompat.from(this).notify(id, builder.build());
        } catch (Exception ignored) {
            // 通知权限被关闭等异常不影响消息服务本身
        }
    }

    /**
     * 下载发送者头像用于通知右侧大图标
     * @param url 头像绝对地址
     * @return 解码后的位图，失败返回 null
     */
    @Nullable
    private Bitmap downloadAvatar(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(AVATAR_TIMEOUT_MS);
            conn.setReadTimeout(AVATAR_TIMEOUT_MS);
            String token = session.getToken();
            if (!token.isEmpty()) {
                // 头像接口虽免登录，带上令牌可兼容受保护路径
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) {
                return null;
            }
            try (InputStream in = conn.getInputStream()) {
                return BitmapFactory.decodeStream(in);
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
     * 生成消息摘要：优先用正文，其次识别图片 / 文件片段
     * @param msg 消息 JSON
     * @return 可直接展示的一行摘要
     */
    private String summaryOf(JSONObject msg) {
        if (msg.optBoolean("recalled", false)) {
            return getString(R.string.im_notify_recalled);
        }
        String text = msg.optString("text", "").trim();
        if (!text.isEmpty()) return text;

        JSONArray parts = msg.optJSONArray("parts");
        if (parts != null) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < parts.length(); i++) {
                JSONObject part = parts.optJSONObject(i);
                if (part == null) continue;
                String type = part.optString("type");
                if ("text".equals(type)) {
                    sb.append(part.optString("text", ""));
                } else if ("image".equals(type)) {
                    sb.append(getString(R.string.im_notify_image));
                } else if ("file".equals(type)) {
                    sb.append(getString(R.string.im_notify_file));
                }
            }
            if (sb.length() > 0) return sb.toString();
        }
        if (!msg.optString("image", "").isEmpty()) {
            return getString(R.string.im_notify_image);
        }
        return getString(R.string.im_notify_unknown);
    }

    /**
     * 构建前台服务常驻通知（低优先级，点击回到会话列表）
     * @return 常驻通知
     */
    private Notification buildServiceNotification() {
        Intent open = new Intent(this, ImActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_SERVICE)
                .setSmallIcon(R.drawable.ic_im_notify)
                .setContentTitle(getString(R.string.im_notify_service_title))
                .setContentText(getString(R.string.im_notify_service_text))
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setSilent(true)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(contentIntent)
                .build();
    }

    /**
     * 创建通知渠道（Android 8.0 起必须先建渠道才能发通知）
     */
    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        // 升级清理：删除旧版常驻通知渠道，避免通知栏残留旧通知
        for (String old : CHANNEL_SERVICE_OLD) {
            manager.deleteNotificationChannel(old);
        }
        // 升级清理：旧消息渠道可能被历史版本建成低重要性（只有状态栏图标、不弹横幅），
        // 渠道重要性不可修改，这里删除旧渠道，改用新 ID 以恢复横幅提醒
        for (String old : CHANNEL_MESSAGE_OLD) {
            manager.deleteNotificationChannel(old);
        }

        // 常驻服务通知：重要性设为「无」，通知栏完全不可见；
        // 前台服务仍会正常运行，因此既满足系统要求，又不打扰用户
        NotificationChannel serviceChannel = new NotificationChannel(
                CHANNEL_SERVICE,
                getString(R.string.im_notify_channel_service),
                NotificationManager.IMPORTANCE_NONE);
        serviceChannel.setShowBadge(false);
        serviceChannel.setSound(null, null);
        serviceChannel.enableVibration(false);
        serviceChannel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        manager.createNotificationChannel(serviceChannel);

        // 新消息通知：高优先级，允许横幅与提示音
        NotificationChannel messageChannel = new NotificationChannel(
                CHANNEL_MESSAGE,
                getString(R.string.im_notify_channel_messages),
                NotificationManager.IMPORTANCE_HIGH);
        messageChannel.setDescription(getString(R.string.im_notify_channel_messages_desc));
        messageChannel.setShowBadge(true);
        // 显式设置提示音、震动与锁屏可见：高重要性 + 声音/震动才会触发横幅提醒
        android.media.AudioAttributes audio = new android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        messageChannel.setSound(android.media.RingtoneManager.getDefaultUri(
                android.media.RingtoneManager.TYPE_NOTIFICATION), audio);
        messageChannel.enableVibration(true);
        messageChannel.setVibrationPattern(new long[]{0, 250, 200, 250});
        messageChannel.enableLights(true);
        messageChannel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(messageChannel);
    }
}
