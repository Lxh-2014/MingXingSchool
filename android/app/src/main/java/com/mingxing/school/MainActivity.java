package com.mingxing.school;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.SparseArray;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.Menu;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.android.material.imageview.ShapeableImageView;
import com.google.android.material.shape.ShapeAppearanceModel;
import com.mingxing.school.broadcast.BroadcastActivity;
import com.mingxing.school.data.SessionStore;
import com.mingxing.school.databinding.ActivityMainBinding;
import com.mingxing.school.im.ImActivity;
import com.mingxing.school.im.ImMessageService;
import com.mingxing.school.live.LiveActivity;
import com.mingxing.school.net.ApiClient;
import com.mingxing.school.net.ImageLoader;
import com.mingxing.school.shop.ShopActivity;
import com.mingxing.school.ui.SettingsView;

/**
 * 主界面（主项目框架）
 * 职责：顶部为顶栏（头像与姓名），底部为横向导航栏（首页/设置/用户管理/邮件），
 *      内容区按导航切换页面；首页为应用图标网格入口，设置页提供退出登录，
 *      用户管理与邮件暂以占位页呈现（管理员可见）。
 */
public class MainActivity extends BaseActivity {

    /** 页面标识：首页 */
    private static final int PAGE_HOME = 0;
    /** 页面标识：设置 */
    private static final int PAGE_SETTINGS = 1;
    /** 页面标识：用户管理（管理员） */
    private static final int PAGE_USERMGMT = 2;
    /** 页面标识：邮件（管理员） */
    private static final int PAGE_MAIL = 3;

    /** 视图绑定对象，访问侧边栏导航容器、顶栏与内容区 */
    private ActivityMainBinding binding;
    /** 本地会话存储，读取用户信息并在退出时清空 */
    private SessionStore sessionStore;
    /** 页面标识 → 导航项视图持有者映射，用于切换选中态 */
    private final SparseArray<NavItemHolder> navViews = new SparseArray<>();
    /** 当前展示的页面标识，避免重复构建内容 */
    private int currentPage = -1;
    /** 页面状态保存键：切换深色模式会重建 Activity，需要恢复原页面 */
    private static final String STATE_PAGE = "state_page";
    /** 设置页视图引用，头像选择结果需要分发到它（切到其他页时置空） */
    private SettingsView settingsView;
    /** 头像选择器，必须在 onCreate 阶段注册，供设置页触发选图 */
    private ActivityResultLauncher<String> avatarPicker;

    /**
     * 首页应用入口数据单元
     */
    private static final class AppEntry {
        /** 应用显示名 */
        final String name;
        /** 应用图标资源 id */
        final int iconRes;
        /** 外链地址；为空表示不是外链应用 */
        final String externalUrl;
        /** 内部页面（原生 Activity）；为空表示尚未在原生端实现 */
        final Class<?> internalActivity;

        /**
         * 构造应用入口
         * @param name 显示名
         * @param iconRes 图标资源
         * @param externalUrl 外链地址，可为空
         * @param internalActivity 内部页面 Class，可为空
         */
        AppEntry(String name, int iconRes, String externalUrl, Class<?> internalActivity) {
            this.name = name;
            this.iconRes = iconRes;
            this.externalUrl = externalUrl;
            this.internalActivity = internalActivity;
        }
    }

    /**
     * 底部导航项持有的子视图
     * 作用：切换选中态时统一刷新胶囊底色、图标着色与文字颜色。
     */
    private static final class NavItemHolder {
        /** 图标外的胶囊容器，选中时显示圆角底色 */
        final FrameLayout pill;
        /** 导航图标 */
        final ImageView icon;
        /** 导航文字 */
        final TextView label;

        /**
         * 构造导航项持有者
         * @param pill 胶囊容器
         * @param icon 图标视图
         * @param label 文字视图
         */
        NavItemHolder(FrameLayout pill, ImageView icon, TextView label) {
            this.pill = pill;
            this.icon = icon;
            this.label = label;
        }
    }

    /**
     * 页面创建：校验登录态、构建侧边栏与顶栏、默认展示首页
     * @param savedInstanceState 页面重建时的历史状态，首次创建为 null
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityMainBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        // 全面屏适配：顶栏避让状态栏、底部导航栏避让手势条；根背景铺满全屏
        applySystemBarsInsets(binding.layoutTopbar, binding.layoutNavContainer);
        // 系统栏取 surface 色，与白色顶栏、底部导航栏保持一致
        setSystemBarColor(R.color.mx_surface);

        sessionStore = new SessionStore(this);

        // 头像选择器必须在 onCreate 阶段注册（早于 STARTED），否则会抛异常
        avatarPicker = registerForActivityResult(
                new ActivityResultContracts.GetContent(),
                uri -> {
                    if (uri != null && settingsView != null) {
                        settingsView.onAvatarPicked(uri);
                    }
                });

        // 未登录（例如会话被清空）时直接退回登录页
        if (!sessionStore.isLoggedIn()) {
            backToLogin();
            return;
        }

        // 邻语消息提醒：已登录时启动后台轮询服务，退到后台或锁屏也能收到新消息通知
        ImMessageService.start(this);
        requestNotificationPermission();

        buildBottomNav();
        buildTopbar();

        // 恢复重建前的页面（切换深色模式会触发重建），默认回到首页
        int startPage = (savedInstanceState == null)
                ? PAGE_HOME
                : savedInstanceState.getInt(STATE_PAGE, PAGE_HOME);
        // 非管理员不允许停留在管理员页面
        if ((startPage == PAGE_USERMGMT || startPage == PAGE_MAIL) && !sessionStore.isAdmin()) {
            startPage = PAGE_HOME;
        }
        showPage(startPage);
    }

    /**
     * 保存当前页面标识，避免切换深色模式重建后回到首页
     * @param outState 状态保存容器
     */
    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (currentPage >= 0) {
            outState.putInt(STATE_PAGE, currentPage);
        }
    }

    /**
     * 页面销毁：释放视图绑定
     */
    @Override
    protected void onDestroy() {
        super.onDestroy();
        // 避免已销毁页面的回调继续操作视图
        settingsView = null;
        binding = null;
    }

    /**
     * 请求通知权限（Android 13+）：未授权时邻语新消息无法在通知栏提醒
     * 说明：后台消息提醒依赖该权限，首次进入主页时向用户申请一次
     */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        // 已授权则不再重复请求
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ActivityCompat.requestPermissions(this,
                new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1002);
    }

    /**
     * 构建底部导航：首页/设置，管理员额外显示用户管理/邮件
     */
    private void buildBottomNav() {
        boolean isAdmin = sessionStore.isAdmin();
        addNavItem(PAGE_HOME, R.drawable.ic_nav_home, R.string.nav_home, false);
        addNavItem(PAGE_SETTINGS, R.drawable.ic_nav_settings, R.string.nav_settings, false);
        // 管理员才显示用户管理、邮件导航
        addNavItem(PAGE_USERMGMT, R.drawable.ic_nav_users, R.string.nav_usermgmt, !isAdmin);
        addNavItem(PAGE_MAIL, R.drawable.ic_nav_mail, R.string.nav_mail, !isAdmin);
    }

    /**
     * 向底部导航栏追加一个导航项（图标 + 文字，图标外套可高亮的胶囊背景）
     * @param page 页面标识，也是 SparseArray 的键
     * @param iconRes 导航图标资源
     * @param titleRes 导航文字资源
     * @param hide 是否隐藏（非管理员时管理员导航传 true）
     */
    private void addNavItem(int page, int iconRes, int titleRes, boolean hide) {
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        // 底部导航横向等分：宽 0 + weight 1，高度撑满导航栏
        item.setLayoutParams(new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));
        item.setVisibility(hide ? View.GONE : View.VISIBLE);
        item.setOnClickListener(v -> showPage(page));

        // 图标胶囊：选中时显示圆角底色，未选中时透明
        FrameLayout pill = new FrameLayout(this);
        pill.setLayoutParams(new LinearLayout.LayoutParams(dp(56), dp(30)));

        ImageView icon = new ImageView(this);
        icon.setLayoutParams(new FrameLayout.LayoutParams(
                dp(22), dp(22), Gravity.CENTER));
        icon.setImageResource(iconRes);
        icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
        pill.addView(icon);
        item.addView(pill);

        // 文字标签：字号偏小，随选中态一起变色
        TextView label = new TextView(this);
        label.setText(titleRes);
        label.setTextSize(11);
        label.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams labelLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        labelLp.topMargin = dp(2);
        label.setLayoutParams(labelLp);
        item.addView(label);

        binding.layoutNavItems.addView(item);
        navViews.put(page, new NavItemHolder(pill, icon, label));
    }

    /**
     * 构建顶栏左侧用户区：头像 + 姓名，点击弹出下拉菜单（ID + 退出登录）
     */
    private void buildTopbar() {
        // 头像复用基类实现：40dp 圆形、带令牌加载、点击弹用户菜单
        attachTopbarAvatar(binding.layoutTopbarRight);

        // 姓名
        TextView name = new TextView(this);
        name.setText(sessionStore.getUsername());
        name.setTextColor(getColor(R.color.mx_on_surface));
        name.setTextSize(15);

        LinearLayout box = binding.layoutTopbarRight;
        box.addView(name);

        // 点击用户区任意位置都能弹出菜单，扩大点击热区
        box.setOnClickListener(v -> showUserMenu(box));
    }

    /**
     * 切换内容区到指定页面，并刷新导航选中态
     * @param page 目标页面标识
     */
    private void showPage(int page) {
        if (page == currentPage) {
            return;
        }
        currentPage = page;
        updateNavSelected(page);

        // 离开设置页时清空引用，避免头像选择回调操作已移除的视图
        if (page != PAGE_SETTINGS) {
            settingsView = null;
        }

        View content;
        switch (page) {
            case PAGE_SETTINGS:
                content = buildSettingsContent();
                break;
            case PAGE_USERMGMT:
                content = buildPlaceholder(R.string.nav_usermgmt);
                break;
            case PAGE_MAIL:
                content = buildPlaceholder(R.string.nav_mail);
                break;
            case PAGE_HOME:
            default:
                content = buildHomeContent();
                break;
        }

        binding.layoutContent.removeAllViews();
        binding.layoutContent.addView(content);
    }

    /**
     * 刷新底部导航选中态：选中项图标胶囊高亮、图标与文字变主色
     * @param activePage 当前激活的页面标识
     */
    private void updateNavSelected(int activePage) {
        for (int i = 0; i < navViews.size(); i++) {
            int page = navViews.keyAt(i);
            NavItemHolder holder = navViews.valueAt(i);
            boolean active = page == activePage;
            // 选中：胶囊底色 + 深色主色图标；未选中：无底色 + 次要文字色
            holder.pill.setBackground(active
                    ? roundedBg(getColor(R.color.mx_primary_container), 15)
                    : null);
            int color = getColor(active
                    ? R.color.mx_on_primary_container
                    : R.color.mx_on_surface_variant);
            holder.icon.setImageTintList(ColorStateList.valueOf(color));
            holder.label.setTextColor(color);
        }
    }

    /**
     * 构建首页内容：应用列表（网盘/转盘/广播器/商店/QQ/成绩），一行一个平铺排列
     * @return 首页内容视图
     */
    private View buildHomeContent() {
        AppEntry[] apps = {
                new AppEntry(getString(R.string.app_drive), R.drawable.drive, null, null),
                new AppEntry(getString(R.string.app_roulette), R.drawable.roulette, null, null),
                new AppEntry(getString(R.string.app_broadcast), R.drawable.broadcast,
                        null, BroadcastActivity.class),
                new AppEntry(getString(R.string.app_shop), R.drawable.shop, null, ShopActivity.class),
                new AppEntry(getString(R.string.app_live), R.drawable.live, null, LiveActivity.class),
                new AppEntry(getString(R.string.app_im), R.drawable.im, null, ImActivity.class),
                new AppEntry(getString(R.string.app_qq), R.drawable.qq, "https://pd.qq.com/g/MingXing233", null),
                new AppEntry(getString(R.string.app_grade), R.drawable.grade, "https://www.kdocs.cn/etapps/query/q/MzRYzQLE", null),
        };

        // 外层负责四周留白，内层是包裹所有行的白色平铺列表
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setPadding(dp(16), dp(16), dp(16), dp(16));

        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        // 白色底 + 圆角，并把子视图裁到圆角内，避免分隔线溢出
        list.setBackground(roundedBg(getColor(R.color.mx_surface)));
        list.setClipToOutline(true);

        for (int i = 0; i < apps.length; i++) {
            list.addView(buildAppItem(apps[i]));
            // 除最后一行外补一条分隔线
            if (i < apps.length - 1) {
                list.addView(buildDivider());
            }
        }

        root.addView(list);
        return root;
    }

    /**
     * 构建单个应用行（图标在左、名称在右，整行可点击）
     * @param app 应用入口数据
     * @return 应用行视图
     */
    private View buildAppItem(AppEntry app) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        // 每行固定 64dp 高，铺满列表宽度
        row.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(64)));
        row.setPadding(dp(16), 0, dp(16), 0);
        // 使用主题的水波纹背景，点击时有原生反馈
        row.setBackgroundResource(resolveSelectableBackground());

        ImageView icon = new ImageView(this);
        icon.setImageResource(app.iconRes);
        icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
        icon.setLayoutParams(new LinearLayout.LayoutParams(dp(40), dp(40)));
        row.addView(icon);

        TextView name = new TextView(this);
        name.setText(app.name);
        name.setTextColor(getColor(R.color.mx_on_surface));
        name.setTextSize(15);
        // 名称占满剩余宽度，左缩进与图标拉开间距
        LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        nameLp.leftMargin = dp(16);
        name.setLayoutParams(nameLp);
        row.addView(name);

        row.setOnClickListener(v -> {
            if (app.internalActivity != null) {
                // 已实现的原生应用：直接打开对应页面
                startActivity(new Intent(this, app.internalActivity));
            } else if (app.externalUrl != null) {
                // 外链应用交给系统浏览器打开
                openBrowser(app.externalUrl);
            } else {
                // 内部应用尚未在原生端上线，先提示
                Toast.makeText(this, getString(R.string.app_coming_soon, app.name), Toast.LENGTH_SHORT).show();
            }
        });
        return row;
    }

    /**
     * 构建列表分隔线（1dp，颜色随深浅色主题变化）
     * @return 分隔线视图
     */
    private View buildDivider() {
        View line = new View(this);
        line.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(1))));
        line.setBackgroundColor(getColor(R.color.mx_input_stroke));
        return line;
    }

    /**
     * 读取主题中的可点击水波纹背景资源 id
     * @return 水波纹 drawable 资源 id
     */
    private int resolveSelectableBackground() {
        TypedValue value = new TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, value, true);
        return value.resourceId;
    }

    /**
     * 构建设置页内容：个人资料 / 外观设置 / 邮箱绑定三张卡片 + 退出登录
     * @return 设置页内容视图
     */
    private View buildSettingsContent() {
        settingsView = new SettingsView(this, sessionStore, avatarPicker);
        // 头像更新后同步刷新顶栏头像
        settingsView.setOnAvatarChanged(this::refreshTopbarAvatar);
        // 退出登录统一由主界面负责清空会话与跳转
        settingsView.setOnLogout(() -> {
            sessionStore.clear();
            backToLogin();
        });
        return settingsView;
    }

    /**
     * 构建占位页内容：居中显示「xxx」开发中
     * @param titleRes 页面标题文字资源
     * @return 占位页视图
     */
    private View buildPlaceholder(int titleRes) {
        TextView tv = new TextView(this);
        tv.setText(getString(R.string.placeholder_wip, getString(titleRes)));
        tv.setTextColor(getColor(R.color.mx_on_surface_variant));
        tv.setTextSize(16);
        tv.setGravity(Gravity.CENTER);
        tv.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return tv;
    }

    /**
     * 生成圆角矩形背景（用于导航选中态）
     * @param color 背景颜色
     * @return 圆角矩形背景
     */
    private GradientDrawable roundedBg(int color) {
        return roundedBg(color, 12);
    }

    /**
     * 生成指定圆角的纯色圆角背景
     * @param color 背景色
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
     * 打开系统浏览器访问外链
     * @param url 目标地址
     */
    private void openBrowser(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            startActivity(intent);
        } catch (Exception e) {
            // 没有可用浏览器时兜底提示
            Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show();
        }
    }
}