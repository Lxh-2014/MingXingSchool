package com.mingxing.school;

import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.TextView;

import androidx.annotation.ColorRes;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.ColorUtils;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.google.android.material.imageview.ShapeableImageView;
import com.google.android.material.shape.ShapeAppearanceModel;
import com.mingxing.school.data.AppPrefs;
import com.mingxing.school.data.SessionStore;
import com.mingxing.school.net.ApiClient;
import com.mingxing.school.net.ImageLoader;

/**
 * 页面基类：统一处理全面屏适配，并提供各页面通用的顶栏头像
 * 目标：让背景铺满状态栏与底部手势导航条（小白条）区域，同时给根视图补齐
 *      安全区 padding，避免顶部内容被状态栏遮挡、底部按钮被手势条遮挡。
 */
public abstract class BaseActivity extends AppCompatActivity {

    /** 各页面顶栏右侧/左侧的头像控件引用（头像更新后重新加载） */
    protected ImageView topbarAvatar;
    /** 头像加载状态：0=未设置自定义头像，1=加载中，2=已显示，3=加载失败 */
    private int avatarState = AVATAR_STATE_NONE;
    /** 头像状态：未设置 */
    private static final int AVATAR_STATE_NONE = 0;
    /** 头像状态：加载中 */
    private static final int AVATAR_STATE_LOADING = 1;
    /** 头像状态：已成功显示 */
    private static final int AVATAR_STATE_OK = 2;
    /** 头像状态：加载失败（常见原因：登录已失效或网络不可达） */
    private static final int AVATAR_STATE_FAILED = 3;
    /** 最近一次头像请求的 HTTP 状态码（0=网络异常），用于失败提示 */
    private int avatarLastCode;
    /** 基础会话存储：供顶栏头像与用户菜单读取当前登录信息 */
    private SessionStore baseSession;

    /**
     * 页面创建：在子类 setContentView 之前完成窗口的边缘适配
     * @param savedInstanceState 页面重建时的历史状态，首次创建为 null
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 先应用深色模式偏好：必须在 super.onCreate 之前，保证主题与资源按正确模式加载
        AppCompatDelegate.setDefaultNightMode(AppPrefs.getNightMode(this));
        super.onCreate(savedInstanceState);

        // 关闭“内容适配系统栏”的默认行为，让根视图延展到系统栏后面
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // 允许内容延伸到刘海/挖孔区域：横屏时刘海多位于侧边，
        // 使用默认模式会被系统在侧边填一条黑边，改为短边延伸后黑边消失
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        // 窗口兜底背景：系统栏或挖孔区域若透出窗口底色，与浅色顶栏保持一致而不是黑
        getWindow().setBackgroundDrawable(
                new ColorDrawable(ContextCompat.getColor(this, R.color.mx_surface)));

        // 会话信息：顶栏头像与用户菜单共用
        baseSession = new SessionStore(this);

        // 根据当前深浅色主题切换系统栏图标明暗，保证在浅色/深色背景下都清晰可见
        WindowInsetsControllerCompat controller =
                new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        boolean isLightTheme = (getResources().getConfiguration().uiMode
                & Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES;
        controller.setAppearanceLightStatusBars(isLightTheme);
        controller.setAppearanceLightNavigationBars(isLightTheme);

        // 上次运行若是 Java 层崩溃，这里弹出堆栈，方便用户直接截图反馈
        new android.os.Handler(getMainLooper()).post(this::showLastCrashIfAny);
    }

    /**
     * 展示上次崩溃的堆栈（展示后即删除记录，避免每次启动都弹）
     * 信息优先级：直播中断步骤（说明停在哪一步）→ 系统记录的原生崩溃 tombstone → Java 异常堆栈
     */
    private void showLastCrashIfAny() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        String crash = CrashLog.take(this);
        String step = LiveTrace.last(this);
        if (step != null) {
            LiveTrace.clear(this);
        }
        // 只有在检测到上次直播流程中断时才读取系统 tombstone：
        // 历史退出信息会长期保留，每次启动都读会反复弹窗打扰用户
        String exitInfo = step == null ? null : readNativeExitInfo();
        if (crash == null && step == null && exitInfo == null) {
            return;
        }

        StringBuilder body = new StringBuilder();
        if (step != null) {
            // 直播流程残留的步骤标记：原生崩溃不会走 Java 异常处理，只能靠这个定位停在哪儿
            body.append("直播中断步骤：").append(step).append("\n\n");
        }
        if (exitInfo != null) {
            body.append(exitInfo).append("\n\n");
        }
        if (crash != null) {
            body.append("Java 异常堆栈：\n").append(crash);
        }
        // 弹窗展示诊断信息，方便用户直接截图反馈
        showLongTextDialog(step != null ? "上次运行中断" : "上次运行崩溃信息", body.toString());
    }

    /**
     * 读取系统记录的上次异常退出信息（Android 11 / API 30 及以上）
     * 原生崩溃（SIGSEGV、abort 等）不会产生 Java 堆栈，但系统会把 tombstone 片段保存在
     * ApplicationExitInfo 中，getTraceInputStream() 可以直接读出原生调用栈，
     * 这是应用内拿到原生崩溃证据的唯一途径。
     * @return 退出原因 + 原生堆栈文本；没有异常退出记录或机型不开放该数据时返回 null
     */
    private String readNativeExitInfo() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return null;
        }
        /** 原生堆栈允许读取的最大字节数：完整 tombstone 含全部线程，太小会把真正的崩溃线程截掉 */
        final int maxTraceBytes = 200000;
        try {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            java.util.List<android.app.ApplicationExitInfo> list =
                    am.getHistoricalProcessExitReasons(getPackageName(), 0, 5);
            for (android.app.ApplicationExitInfo info : list) {
                int reason = info.getReason();
                // 只关心崩溃类退出，正常返回、被系统回收等情况直接跳过
                if (reason != android.app.ApplicationExitInfo.REASON_CRASH_NATIVE
                        && reason != android.app.ApplicationExitInfo.REASON_CRASH
                        && reason != android.app.ApplicationExitInfo.REASON_ANR) {
                    continue;
                }
                StringBuilder sb = new StringBuilder();
                sb.append("退出原因：").append(info.getDescription()).append('\n');
                sb.append("时间：").append(android.text.format.DateFormat
                        .format("MM-dd HH:mm:ss", info.getTimestamp())).append('\n');
                java.io.InputStream in = info.getTraceInputStream();
                if (in == null) {
                    sb.append("系统未提供该机型的原生堆栈数据");
                    return sb.toString();
                }
                try {
                    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                    byte[] buffer = new byte[8192];   // 分块读取缓冲
                    int read;
                    while ((read = in.read(buffer)) > 0 && out.size() < maxTraceBytes) {
                        out.write(buffer, 0, read);
                    }
                    sb.append("原生堆栈：\n").append(out.toString("UTF-8"));
                } finally {
                    in.close();
                }
                return sb.toString();
            }
        } catch (Throwable ignored) {
            // 部分机型（个别小米版本）不开放历史退出信息，读取失败时静默跳过
        }
        return null;
    }

    /**
     * 以可滚动对话框展示可能很长的诊断文本（原生崩溃 tombstone 通常有几十行）
     * @param title 标题
     * @param text 内容
     */
    private void showLongTextDialog(String title, String text) {
        android.widget.TextView content = new android.widget.TextView(this);
        int pad = dp(20);   // 与 AlertDialog 默认左右留白接近
        content.setPadding(pad, dp(8), pad, dp(8));
        content.setText(text);
        content.setTextSize(11);
        content.setTextIsSelectable(true);
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        scroll.addView(content);
        new androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle(title)
                .setView(scroll)
                .setPositiveButton("知道了", null)
                .show();
    }

    /**
     * 在顶栏容器中创建圆形头像（40dp，左对齐），点击弹出用户菜单
     * 所有页面（除登录页）共用，保证头像位置与交互一致
     * @param host 顶栏中的头像容器
     */
    protected void attachTopbarAvatar(ViewGroup host) {
        if (host == null) {
            return;
        }
        ShapeableImageView avatar = new ShapeableImageView(this);
        // 半径取超大值，Material 会自动收敛到短边一半，任何尺寸都是正圆
        avatar.setShapeAppearanceModel(new ShapeAppearanceModel.Builder()
                .setAllCornerSizes(999f)
                .build());
        // 居中裁剪，保证图片填满圆形、不留白边
        avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
        avatar.setContentDescription(getString(R.string.user_avatar));
        // 浅灰圆底：未设置头像或图片加载失败时仍能看清头像轮廓（白顶栏上不至于整片空白）
        avatar.setBackgroundResource(R.drawable.bg_avatar_circle);

        int size = dp(40);
        ViewGroup.MarginLayoutParams lp = new ViewGroup.MarginLayoutParams(size, size);
        lp.setMarginEnd(dp(8));
        avatar.setLayoutParams(lp);

        topbarAvatar = avatar;
        refreshTopbarAvatar();
        avatar.setOnClickListener(this::showUserMenu);
        host.addView(avatar);
    }

    /**
     * 刷新顶栏头像：走公开头像接口 /api/user-avatar/:id
     * 说明：旧实现读 /drive/assets/user/*.png，该路径受登录校验保护，令牌失效时会被 302 到登录页，
     *       导致永远取不到图；公开接口不依赖令牌，未设置头像时返回 404，由界面显示占位图。
     */
    protected void refreshTopbarAvatar() {
        if (topbarAvatar == null || baseSession == null) {
            return;
        }
        String userId = baseSession.getUserId();
        // 头像地址：按用户 ID 拼接，ID 可能含中文或特殊字符，需要编码
        String url = userId.isEmpty() ? ""
                : ApiClient.baseUrl() + "/api/user-avatar/" + android.net.Uri.encode(userId);
        // 同一地址换图后需清缓存，否则仍显示旧头像
        ImageLoader.evict(url);
        avatarState = AVATAR_STATE_LOADING;
        ImageLoader.load(topbarAvatar, url, R.drawable.ic_avatar_default, baseSession.getToken(),
                code -> {
                    if (code >= 200 && code < 300) {
                        avatarState = AVATAR_STATE_OK;
                    } else if (code == 404) {
                        avatarState = AVATAR_STATE_NONE;      // 该用户确实没有头像文件
                    } else {
                        avatarState = AVATAR_STATE_FAILED;    // 302=登录失效，0=网络不通
                        avatarLastCode = code;
                    }
                });
    }

    /**
     * 头像加载失败时的中文说明：区分「网络不通」与「HTTP 状态码」（如 302 表示登录失效）
     * @return 展示用文案
     */
    private String avatarFailureText() {
        return avatarLastCode == 0
                ? getString(R.string.avatar_load_network)
                : getString(R.string.avatar_load_failed, avatarLastCode);
    }

    /**
     * 弹出用户下拉菜单（头像 + 姓名/ID、金币积分、退出登录）
     * 积分在打开时先显示缓存值，同时异步刷新，保证管理员改分后能及时看到
     * @param anchor 菜单锚点视图（一般传头像或用户区容器）
     */
    protected void showUserMenu(View anchor) {
        if (baseSession == null) {
            return;
        }
        final int panelWidth = dp(228);

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(14), dp(12), dp(14), dp(6));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(getColor(R.color.mx_surface));
        bg.setCornerRadius(dp(14));
        panel.setBackground(bg);

        // —— 头部：头像 + 姓名 / ID ——
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);

        ShapeableImageView avatar = new ShapeableImageView(this);
        avatar.setShapeAppearanceModel(new ShapeAppearanceModel.Builder()
                .setAllCornerSizes(999f)
                .build());
        avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
        int avatarSize = dp(34);
        LinearLayout.LayoutParams avatarLp = new LinearLayout.LayoutParams(avatarSize, avatarSize);
        avatarLp.rightMargin = dp(10);
        avatar.setLayoutParams(avatarLp);
        // 菜单里的小头像同样走公开接口，保证与顶栏一致
        String menuUserId = baseSession.getUserId();
        String avatarUrl = menuUserId.isEmpty() ? ""
                : ApiClient.baseUrl() + "/api/user-avatar/" + android.net.Uri.encode(menuUserId);
        avatar.setBackgroundResource(R.drawable.bg_avatar_circle);
        ImageLoader.load(avatar, avatarUrl, R.drawable.ic_avatar_default, baseSession.getToken());
        head.addView(avatar);

        LinearLayout nameBox = new LinearLayout(this);
        nameBox.setOrientation(LinearLayout.VERTICAL);
        TextView nameView = new TextView(this);
        nameView.setText(baseSession.getUsername());
        nameView.setTextColor(getColor(R.color.mx_on_surface));
        nameView.setTextSize(14);
        nameView.setTypeface(null, android.graphics.Typeface.BOLD);
        nameBox.addView(nameView);
        TextView idView = new TextView(this);
        idView.setText(getString(R.string.menu_user_id, baseSession.getUserId()));
        idView.setTextColor(getColor(R.color.mx_on_surface_variant));
        idView.setTextSize(11);
        nameBox.addView(idView);
        head.addView(nameBox);
        panel.addView(head);

        // —— 积分行：金币图标 + 纯数字 ——
        LinearLayout pointsRow = new LinearLayout(this);
        pointsRow.setOrientation(LinearLayout.HORIZONTAL);
        pointsRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams pointsLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pointsLp.topMargin = dp(10);
        pointsRow.setLayoutParams(pointsLp);

        ImageView coin = new ImageView(this);
        coin.setImageResource(R.drawable.ic_coin);
        LinearLayout.LayoutParams coinLp = new LinearLayout.LayoutParams(dp(16), dp(16));
        coinLp.rightMargin = dp(6);
        coin.setLayoutParams(coinLp);
        pointsRow.addView(coin);

        final TextView pointsText = new TextView(this);
        pointsText.setText(topbarPoints);
        pointsText.setTextColor(getColor(R.color.mx_on_surface));
        pointsText.setTextSize(13);
        pointsRow.addView(pointsText);
        panel.addView(pointsRow);

        // —— 头像状态提示：仅在未设置或加载失败时显示，帮助定位“头像不显示”的原因 ——
        if (avatarState == AVATAR_STATE_FAILED || avatarState == AVATAR_STATE_NONE) {
            TextView avatarHint = new TextView(this);
            avatarHint.setText(avatarState == AVATAR_STATE_FAILED
                    ? avatarFailureText() : getString(R.string.avatar_not_set));
            avatarHint.setTextColor(getColor(R.color.mx_on_surface_variant));
            avatarHint.setTextSize(11);
            LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            hintLp.topMargin = dp(4);
            avatarHint.setLayoutParams(hintLp);
            panel.addView(avatarHint);
        }

        // —— 分割线 ——
        View divider = new View(this);
        divider.setBackgroundColor(getColor(R.color.mx_input_stroke));
        LinearLayout.LayoutParams dividerLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1));
        dividerLp.topMargin = dp(10);
        divider.setLayoutParams(dividerLp);
        panel.addView(divider);

        final PopupWindow popup = new PopupWindow(panel, panelWidth,
                ViewGroup.LayoutParams.WRAP_CONTENT, true);
        popup.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        popup.setOutsideTouchable(true);
        popup.setElevation(dp(8));

        // —— 退出登录行 ——
        TextView logout = new TextView(this);
        logout.setText(getString(R.string.menu_logout));
        logout.setTextColor(getColor(R.color.mx_on_surface));
        logout.setTextSize(14);
        logout.setGravity(Gravity.CENTER_VERTICAL);
        logout.setPadding(dp(2), dp(12), dp(2), dp(12));
        logout.setClickable(true);
        logout.setOnClickListener(v -> {
            popup.dismiss();
            baseSession.clear();
            backToLogin();
        });
        panel.addView(logout);

        popup.showAsDropDown(anchor, 0, dp(4), Gravity.START);

        // 异步刷新积分：接口返回后若菜单仍显示则同步更新数字
        fetchPoints(points -> pointsText.setText(points));
    }

    /** 顶栏用户积分缓存（字符串保存，支持超长整数原样展示） */
    private String topbarPoints = "0";

    /**
     * 拉取当前用户积分（主站 /api/me 与商店 /shop/api/me 结构不同，这里做兼容解析）
     * @param onLoaded 拿到积分后的回调（主线程）
     */
    private void fetchPoints(java.util.function.Consumer<String> onLoaded) {
        ApiClient.get("/api/me", baseSession.getToken(), new ApiClient.Callback() {
            @Override
            public void onSuccess(org.json.JSONObject json) {
                String points = parsePoints(json);
                topbarPoints = points;
                onLoaded.accept(points);
            }

            @Override
            public void onFailure(String message) {
                // 拉取失败时沿用缓存值，不打断菜单使用
            }
        });
    }

    /**
     * 兼容解析积分字段：主站可能直接放在根节点，也可能在 user/data 子对象里；
     * 积分允许任意长度，因此按字符串读取，避免超出 int 范围被截断
     * @param json 接口返回的 JSON
     * @return 积分文本，缺失或非法时为 "0"
     */
    private String parsePoints(org.json.JSONObject json) {
        if (json == null) {
            return "0";
        }
        String value = pointsField(json);
        if (value != null) {
            return value;
        }
        org.json.JSONObject user = json.optJSONObject("user");
        if (user != null && pointsField(user) != null) {
            return pointsField(user);
        }
        org.json.JSONObject data = json.optJSONObject("data");
        if (data != null && pointsField(data) != null) {
            return pointsField(data);
        }
        return "0";
    }

    /**
     * 从单个 JSON 对象中读取积分字段
     * @param json 待读取对象
     * @return 合规的积分文本；字段缺失或为空时返回 null
     */
    private String pointsField(org.json.JSONObject json) {
        if (!json.has("points") || json.isNull("points")) {
            return null;
        }
        String value = json.optString("points", "").trim();
        return value.isEmpty() ? null : value;
    }

    /**
     * 回到登录页并清空任务栈
     */
    protected void backToLogin() {
        // 退出登录时停止邻语消息提醒服务，避免未登录状态下继续轮询
        com.mingxing.school.im.ImMessageService.stop(this);
        Intent intent = new Intent(this, LoginActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
    }

    /**
     * dp 转像素
     * @param value dp 数值
     * @return 对应像素值
     */
    protected int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /**
     * 设置状态栏与导航栏（底部小横条）的背景色，并按底色亮度自动切换图标明暗。
     * 传入的颜色应与页面顶部/底部相邻区域一致，才能做到系统栏与页面无缝衔接。
     * @param colorRes 颜色资源，如登录页传淡蓝底、主界面传顶栏的 surface 色
     */
    protected void setSystemBarColor(@ColorRes int colorRes) {
        int color = ContextCompat.getColor(this, colorRes);
        Window window = getWindow();
        // 系统栏背景色：Android 15 起被标记为废弃，但在 targetSdk 34 上仍然生效
        window.setStatusBarColor(color);
        window.setNavigationBarColor(color);

        // 底色偏亮用深色图标，偏暗用浅色图标，保证时间、电量与手势条清晰可见
        boolean darkIcons = ColorUtils.calculateLuminance(color) > 0.5;
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(darkIcons);
        controller.setAppearanceLightNavigationBars(darkIcons);
    }

    /**
     * 只设置状态栏背景色，并按底色亮度自动切换状态栏图标明暗。
     * 用于顶部与底部相邻区域颜色不同的页面（如顶栏白色、内容区淡蓝）。
     * @param colorRes 顶部相邻区域的颜色资源
     */
    protected void setStatusBarColor(@ColorRes int colorRes) {
        int color = ContextCompat.getColor(this, colorRes);
        Window window = getWindow();
        window.setStatusBarColor(color);   // Android 15 起废弃，但 targetSdk 34 仍生效
        boolean darkIcons = ColorUtils.calculateLuminance(color) > 0.5;
        WindowCompat.getInsetsController(window, window.getDecorView())
                .setAppearanceLightStatusBars(darkIcons);
    }

    /**
     * 只设置底部导航条（小白条）背景色，并按底色亮度自动切换手势条明暗。
     * @param colorRes 底部相邻区域的颜色资源
     */
    protected void setNavigationBarColor(@ColorRes int colorRes) {
        int color = ContextCompat.getColor(this, colorRes);
        Window window = getWindow();
        window.setNavigationBarColor(color);
        boolean darkIcons = ColorUtils.calculateLuminance(color) > 0.5;
        WindowCompat.getInsetsController(window, window.getDecorView())
                .setAppearanceLightNavigationBars(darkIcons);
    }

    /**
     * 让根视图背景铺满状态栏与手势条区域（避免出现白带），
     * 同时把安全区作为 padding 交给指定的子视图，保证内容不被遮挡。
     * 左右安全区同时考虑刘海/挖孔，横屏时顶栏按钮不会被挖孔压住。
     * @param topAnchor 顶部避让状态栏的视图（一般传顶栏）
     * @param bottomAnchor 底部避让手势条的视图（一般传内容区或底部导航栏）
     */
    protected void applySystemBarsInsets(View topAnchor, View bottomAnchor) {
        applyInsetPadding(topAnchor, true, false, true);
        applyInsetPadding(bottomAnchor, false, true, true);
    }

    /**
     * 给指定视图补齐系统栏安全区 padding
     * @param target 需要避让系统栏的视图
     * @param top true=顶部让出状态栏高度
     * @param bottom true=底部让出手势条高度
     * @param side true=左右让出刘海/侧边系统栏宽度
     */
    private void applyInsetPadding(View target, boolean top, boolean bottom, boolean side) {
        if (target == null) {
            return;
        }
        // 记录视图原有 padding，避免覆盖布局里写死的留白
        final int baseLeft = target.getPaddingLeft();
        final int baseTop = target.getPaddingTop();
        final int baseRight = target.getPaddingRight();
        final int baseBottom = target.getPaddingBottom();

        ViewCompat.setOnApplyWindowInsetsListener(target, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            // 刘海/挖孔安全区：横屏时位于左右两侧，需要与系统栏取较大值
            Insets cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
            int insetLeft = Math.max(bars.left, cutout.left);
            int insetRight = Math.max(bars.right, cutout.right);
            v.setPadding(
                    baseLeft + (side ? insetLeft : 0),
                    baseTop + (top ? bars.top : 0),
                    baseRight + (side ? insetRight : 0),
                    baseBottom + (bottom ? bars.bottom : 0));
            // 返回 insets 交给系统继续传递，避免中断其它 Insets 逻辑
            return insets;
        });
    }

    /**
     * 给根视图补齐系统栏安全区：
     * 顶部让出状态栏高度、底部让出导航条（小白条）高度，左右保持不变。
     * @param root 根布局视图，通常在 setContentView 之后调用一次
     */
    protected void applySystemBarsInsets(View root) {
        // 记录根视图原有的 padding，避免每次都覆盖掉布局里已写死的留白
        final int baseLeft = root.getPaddingLeft();
        final int baseTop = root.getPaddingTop();
        final int baseRight = root.getPaddingRight();
        final int baseBottom = root.getPaddingBottom();

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            // 取出状态栏 + 导航栏的系统区域尺寸
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(baseLeft, baseTop + bars.top, baseRight, baseBottom + bars.bottom);
            // 返回 insets 交给系统继续处理，避免中断其它 Insets 逻辑
            return insets;
        });
    }
}