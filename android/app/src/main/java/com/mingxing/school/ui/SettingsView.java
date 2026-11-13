package com.mingxing.school.ui;

import android.app.Activity;
import android.content.ContentResolver;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Typeface;
import android.net.Uri;
import android.text.InputType;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.appcompat.app.AppCompatDelegate;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.card.MaterialCardView;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.imageview.ShapeableImageView;
import com.google.android.material.shape.ShapeAppearanceModel;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;
import com.mingxing.school.R;
import com.mingxing.school.data.AppPrefs;
import com.mingxing.school.data.SessionStore;
import com.mingxing.school.net.ApiClient;
import com.mingxing.school.net.ImageLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * 设置页内容视图（三张卡片）
 * 1. 个人资料：头像预览、上传自定义图片、恢复默认
 * 2. 外观设置：深色模式（跟随系统 / 浅色 / 深色）
 * 3. 邮箱绑定：读取、保存、解绑当前账号绑定的邮箱
 * 末尾提供退出登录按钮。
 */
public class SettingsView extends ScrollView {

    /** 头像图片最长边上限（像素），超出会按采样缩小，避免 base64 过大 */
    private static final int AVATAR_MAX_SIDE = 512;

    /** 宿主 Activity，用于弹窗、Toast 与图片选择 */
    private final Activity host;
    /** 会话存储，读取用户 ID / 令牌 / 头像路径 */
    private final SessionStore session;
    /** 头像选择器，由 MainActivity 在 onCreate 阶段注册后传入 */
    private final ActivityResultLauncher<String> avatarPicker;

    /** 头像预览控件 */
    private ImageView avatarPreview;
    /** 邮箱输入框 */
    private TextInputEditText emailInput;
    /** 邮箱绑定状态提示 */
    private TextView mailHint;
    /** 邮箱解绑按钮（未绑定时隐藏） */
    private MaterialButton mailClearBtn;

    /** 头像更新后的回调，用于刷新主界面顶栏头像 */
    private Runnable onAvatarChanged;
    /** 退出登录的回调，由 MainActivity 统一处理跳转 */
    private Runnable onLogout;

    /**
     * 构造设置页视图
     * @param host 宿主 Activity
     * @param session 会话存储
     * @param avatarPicker 头像选择器
     */
    public SettingsView(Activity host, SessionStore session, ActivityResultLauncher<String> avatarPicker) {
        super(host);
        this.host = host;
        this.session = session;
        this.avatarPicker = avatarPicker;
        setFillViewport(true);
        buildContent();
    }

    /**
     * 设置头像更新回调
     * @param callback 头像更新后执行
     */
    public void setOnAvatarChanged(Runnable callback) {
        this.onAvatarChanged = callback;
    }

    /**
     * 设置退出登录回调
     * @param callback 点击退出登录时执行
     */
    public void setOnLogout(Runnable callback) {
        this.onLogout = callback;
    }

    /**
     * 组装设置页：三张卡片 + 退出登录按钮
     */
    private void buildContent() {
        LinearLayout root = new LinearLayout(host);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        root.setPadding(pad, pad, pad, pad);

        root.addView(buildProfileCard());
        root.addView(buildAppearanceCard());
        root.addView(buildMailCard());
        root.addView(buildLogoutButton());

        addView(root);
    }

    /**
     * 构建卡片 1：个人资料（头像预览 + 上传 + 恢复默认）
     * @return 卡片视图
     */
    private View buildProfileCard() {
        LinearLayout content = column();
        content.addView(heading(R.string.settings_profile_title));
        content.addView(desc(R.string.settings_profile_desc));

        LinearLayout row = new LinearLayout(host);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(16), 0, 0);

        // 头像预览：圆形裁剪，图片居中填满
        ShapeableImageView avatar = new ShapeableImageView(host);
        avatar.setShapeAppearanceModel(roundShape());
        avatar.setLayoutParams(new LinearLayout.LayoutParams(dp(72), dp(72)));
        avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
        // 浅灰圆底：未设置头像时也能看到头像轮廓
        avatar.setBackgroundResource(R.drawable.bg_avatar_circle);
        avatarPreview = avatar;
        refreshAvatar();
        row.addView(avatarPreview);

        // 操作按钮列
        LinearLayout actions = column();
        actions.setPadding(dp(16), 0, 0, 0);

        MaterialButton uploadBtn = new MaterialButton(host);
        uploadBtn.setText(R.string.settings_upload_avatar);
        uploadBtn.setOnClickListener(v -> avatarPicker.launch("image/*"));

        MaterialButton clearBtn = new MaterialButton(
                host, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
        clearBtn.setText(R.string.settings_clear_avatar);
        clearBtn.setOnClickListener(v -> clearAvatar());

        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnLp.topMargin = dp(8);
        actions.addView(uploadBtn, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        actions.addView(clearBtn, btnLp);
        row.addView(actions);

        content.addView(row);
        return wrapCard(content);
    }

    /**
     * 构建卡片 2：外观设置（深色模式三选一）
     * @return 卡片视图
     */
    private View buildAppearanceCard() {
        LinearLayout content = column();
        content.addView(heading(R.string.settings_appearance_title));
        content.addView(desc(R.string.settings_appearance_desc));

        LinearLayout row = new LinearLayout(host);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(16), 0, 0);

        // 左侧标题
        LinearLayout labelBox = column();
        labelBox.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        labelBox.addView(text(R.string.settings_night_label, 15, R.color.mx_on_surface));
        labelBox.addView(text(R.string.settings_night_hint, 12, R.color.mx_on_surface_variant));
        row.addView(labelBox);

        // 右侧三态单选
        RadioGroup group = new RadioGroup(host);
        group.setOrientation(RadioGroup.HORIZONTAL);

        RadioButton rbFollow = new RadioButton(host);
        rbFollow.setText(R.string.settings_night_follow);
        RadioButton rbLight = new RadioButton(host);
        rbLight.setText(R.string.settings_night_light);
        RadioButton rbDark = new RadioButton(host);
        rbDark.setText(R.string.settings_night_dark);

        // 每个选项分配独立 id，便于比较选中项
        rbFollow.setId(View.generateViewId());
        rbLight.setId(View.generateViewId());
        rbDark.setId(View.generateViewId());

        group.addView(rbFollow);
        group.addView(rbLight);
        group.addView(rbDark);

        // 先回显当前偏好，再挂监听，避免初始化触发重建
        int mode = AppPrefs.getNightMode(host);
        if (mode == AppCompatDelegate.MODE_NIGHT_NO) {
            group.check(rbLight.getId());
        } else if (mode == AppCompatDelegate.MODE_NIGHT_YES) {
            group.check(rbDark.getId());
        } else {
            group.check(rbFollow.getId());
        }
        group.setOnCheckedChangeListener((g, checkedId) -> {
            int target;
            if (checkedId == rbLight.getId()) {
                target = AppCompatDelegate.MODE_NIGHT_NO;
            } else if (checkedId == rbDark.getId()) {
                target = AppCompatDelegate.MODE_NIGHT_YES;
            } else {
                target = AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM;
            }
            // 保存并立即应用（界面会按新主题重建）
            AppPrefs.setNightMode(host, target);
        });

        row.addView(group);
        content.addView(row);
        return wrapCard(content);
    }

    /**
     * 构建卡片 3：邮箱绑定（输入框 + 状态提示 + 保存/解绑）
     * @return 卡片视图
     */
    private View buildMailCard() {
        LinearLayout content = column();
        content.addView(heading(R.string.settings_mail_title));
        content.addView(desc(R.string.settings_mail_desc));

        TextInputLayout til = new TextInputLayout(host);
        til.setHint(host.getString(R.string.settings_mail_email));
        LinearLayout.LayoutParams tilLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tilLp.topMargin = dp(16);
        til.setLayoutParams(tilLp);

        emailInput = new TextInputEditText(host);
        emailInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        emailInput.setSingleLine(true);
        til.addView(emailInput, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.addView(til);

        // 绑定状态提示
        mailHint = text(R.string.settings_mail_loading, 13, R.color.mx_on_surface_variant);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.topMargin = dp(8);
        mailHint.setLayoutParams(hintLp);
        content.addView(mailHint);

        // 操作按钮行
        LinearLayout btns = new LinearLayout(host);
        btns.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams btnsLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnsLp.topMargin = dp(12);
        btns.setLayoutParams(btnsLp);

        MaterialButton saveBtn = new MaterialButton(host);
        saveBtn.setText(R.string.settings_mail_save);
        saveBtn.setOnClickListener(v -> saveBinding(emailInput.getText() == null
                ? "" : emailInput.getText().toString().trim()));

        mailClearBtn = new MaterialButton(
                host, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
        mailClearBtn.setText(R.string.settings_mail_clear);
        mailClearBtn.setVisibility(View.GONE);
        mailClearBtn.setOnClickListener(v -> confirmClearBinding());

        LinearLayout.LayoutParams clearLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clearLp.leftMargin = dp(12);
        btns.addView(saveBtn, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        btns.addView(mailClearBtn, clearLp);
        content.addView(btns);

        loadBinding();
        return wrapCard(content);
    }

    /**
     * 构建退出登录按钮
     * @return 按钮视图
     */
    private View buildLogoutButton() {
        MaterialButton logout = new MaterialButton(host);
        logout.setText(R.string.settings_logout);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        logout.setLayoutParams(lp);
        logout.setOnClickListener(v -> {
            if (onLogout != null) {
                onLogout.run();
            }
        });
        return logout;
    }

    /**
     * 头像选择完成后的回调（由 MainActivity 转发）
     * 读取图片并压缩为 JPEG，转 base64 后上传到网盘头像接口
     * @param uri 用户选中的图片 Uri
     */
    public void onAvatarPicked(Uri uri) {
        new Thread(() -> {
            try {
                String dataUrl = encodeToDataUrl(uri);
                JSONObject body = new JSONObject();
                body.put("userId", session.getUserId());
                body.put("avatarData", dataUrl);
                ApiClient.post("/drive/api/avatar/upload", body, null, new ApiClient.Callback() {
                    @Override
                    public void onSuccess(JSONObject json) {
                        String avatar = json.optString("avatar", "");
                        session.updateAvatar(avatar);
                        refreshAvatar();
                        Toast.makeText(host, R.string.settings_avatar_uploaded, Toast.LENGTH_SHORT).show();
                        if (onAvatarChanged != null) {
                            onAvatarChanged.run();
                        }
                    }

                    @Override
                    public void onFailure(String message) {
                        Toast.makeText(host, message, Toast.LENGTH_SHORT).show();
                    }
                });
            } catch (Exception e) {
                Toast.makeText(host, R.string.settings_avatar_failed, Toast.LENGTH_SHORT).show();
            }
        }).start();
    }

    /**
     * 恢复默认头像：清除服务端头像设置
     */
    private void clearAvatar() {
        try {
            JSONObject body = new JSONObject();
            body.put("userId", session.getUserId());
            body.put("color", "");
            ApiClient.post("/drive/api/avatar/color", body, null, new ApiClient.Callback() {
                @Override
                public void onSuccess(JSONObject json) {
                    session.updateAvatar("");
                    refreshAvatar();
                    Toast.makeText(host, R.string.settings_avatar_cleared, Toast.LENGTH_SHORT).show();
                    if (onAvatarChanged != null) {
                        onAvatarChanged.run();
                    }
                }

                @Override
                public void onFailure(String message) {
                    Toast.makeText(host, message, Toast.LENGTH_SHORT).show();
                }
            });
        } catch (Exception e) {
            Toast.makeText(host, R.string.settings_avatar_failed, Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * 刷新头像预览图：走公开头像接口，避免 /drive 登录校验把请求重定向到登录页
     */
    private void refreshAvatar() {
        String userId = session.getUserId();
        String url = userId.isEmpty() ? ""
                : ApiClient.baseUrl() + "/api/user-avatar/" + android.net.Uri.encode(userId);
        // 同一地址更新后需清缓存，否则仍显示旧图
        ImageLoader.evict(url);
        ImageLoader.load(avatarPreview, url, R.drawable.ic_avatar_default, session.getToken());
    }

    /**
     * 读取当前用户邮箱绑定并回显
     */
    private void loadBinding() {
        ApiClient.get("/api/mail/me", session.getToken(), new ApiClient.Callback() {
            @Override
            public void onSuccess(JSONObject json) {
                JSONObject binding = json.optJSONObject("binding");
                applyBinding(binding == null ? "" : binding.optString("email", ""));
            }

            @Override
            public void onFailure(String message) {
                mailHint.setText(message);
            }
        });
    }

    /**
     * 用绑定结果刷新输入框、状态提示与解绑按钮显隐
     * @param email 当前绑定邮箱，空串表示未绑定
     */
    private void applyBinding(String email) {
        emailInput.setText(email);
        mailHint.setText(email.isEmpty()
                ? host.getString(R.string.settings_mail_unbound)
                : host.getString(R.string.settings_mail_bound, email));
        mailClearBtn.setVisibility(email.isEmpty() ? View.GONE : View.VISIBLE);
    }

    /**
     * 保存绑定；email 为空时提示先填写
     * @param email 邮箱地址
     */
    private void saveBinding(String email) {
        if (email.isEmpty()) {
            Toast.makeText(host, R.string.settings_mail_empty, Toast.LENGTH_SHORT).show();
            return;
        }
        submitBinding(email);
    }

    /**
     * 确认后解绑当前邮箱
     */
    private void confirmClearBinding() {
        new MaterialAlertDialogBuilder(host)
                .setMessage(R.string.settings_mail_clear_confirm)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.settings_mail_clear, (dialog, which) -> submitBinding(""))
                .show();
    }

    /**
     * 提交绑定 / 解绑请求
     * @param email 邮箱地址，空串表示解绑
     */
    private void submitBinding(String email) {
        try {
            JSONObject body = new JSONObject();
            body.put("email", email);
            ApiClient.put("/api/mail/me", body, session.getToken(), new ApiClient.Callback() {
                @Override
                public void onSuccess(JSONObject json) {
                    JSONObject binding = json.optJSONObject("binding");
                    applyBinding(binding == null ? "" : binding.optString("email", ""));
                    Toast.makeText(host,
                            json.optString("message", host.getString(R.string.settings_mail_saved)),
                            Toast.LENGTH_SHORT).show();
                }

                @Override
                public void onFailure(String message) {
                    Toast.makeText(host, message, Toast.LENGTH_SHORT).show();
                }
            });
        } catch (Exception e) {
            Toast.makeText(host, R.string.settings_mail_save_failed, Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * 把选中图片读取、缩放并编码为 data:image/jpeg;base64 字符串
     * @param uri 图片 Uri
     * @return 可直接提交给服务端的 dataURL
     * @throws IOException 读取或解码失败时抛出
     */
    private String encodeToDataUrl(Uri uri) throws IOException {
        ContentResolver resolver = host.getContentResolver();

        // 第一遍只读取尺寸，用于计算采样率
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = resolver.openInputStream(uri)) {
            BitmapFactory.decodeStream(in, null, bounds);
        }
        int maxSide = Math.max(bounds.outWidth, bounds.outHeight);
        if (maxSide <= 0) {
            throw new IOException("无法读取图片尺寸");
        }
        // 按 2 的幂逐步缩小，直到最长边不超过上限
        int sample = 1;
        while (maxSide / sample > AVATAR_MAX_SIDE) {
            sample *= 2;
        }

        // 第二遍按采样率真正解码
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        Bitmap bitmap;
        try (InputStream in = resolver.openInputStream(uri)) {
            bitmap = BitmapFactory.decodeStream(in, null, opts);
        }
        if (bitmap == null) {
            throw new IOException("图片解码失败");
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out);
        String base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        return "data:image/jpeg;base64," + base64;
    }

    /**
     * 生成正圆形状模型：半径取超大值，Material 会自动收敛到短边一半，任何尺寸都是圆形
     * @return 正圆形状模型
     */
    private ShapeAppearanceModel roundShape() {
        return new ShapeAppearanceModel.Builder()
                .setAllCornerSizes(999f)
                .build();
    }

    /**
     * 创建纵向排列的容器
     * @return 空容器
     */
    private LinearLayout column() {
        LinearLayout box = new LinearLayout(host);
        box.setOrientation(LinearLayout.VERTICAL);
        return box;
    }

    /**
     * 创建卡片标题
     * @param textRes 标题文字资源
     * @return 标题视图
     */
    private TextView heading(int textRes) {
        TextView tv = text(R.string.settings_title, 16, R.color.mx_on_surface);
        tv.setText(textRes);
        tv.setTypeface(null, Typeface.BOLD);
        return tv;
    }

    /**
     * 创建卡片说明文字
     * @param textRes 说明文字资源
     * @return 说明视图
     */
    private TextView desc(int textRes) {
        TextView tv = text(R.string.settings_title, 13, R.color.mx_on_surface_variant);
        tv.setText(textRes);
        tv.setPadding(0, dp(6), 0, 0);
        return tv;
    }

    /**
     * 创建普通文字视图
     * @param textRes 文字资源
     * @param sizeSp 字号（sp）
     * @param colorRes 文字颜色资源
     * @return 文字视图
     */
    private TextView text(int textRes, int sizeSp, int colorRes) {
        TextView tv = new TextView(host);
        tv.setText(textRes);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        tv.setTextColor(host.getColor(colorRes));
        return tv;
    }

    /**
     * 把内容包进 Material 卡片
     * @param content 卡片内容容器
     * @return 卡片视图
     */
    private View wrapCard(LinearLayout content) {
        MaterialCardView card = new MaterialCardView(host);
        LinearLayout.LayoutParams cardLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardLp.bottomMargin = dp(16);
        card.setLayoutParams(cardLp);
        card.setRadius(dp(16));
        card.setCardElevation(dp(1));

        int p = dp(16);
        content.setPadding(p, p, p, p);
        card.addView(content, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return card;
    }

    /**
     * dp 转像素
     * @param value dp 值
     * @return 像素值
     */
    private int dp(int value) {
        return Math.round(value * host.getResources().getDisplayMetrics().density);
    }
}