package com.mingxing.school.shop;

import android.content.ContentResolver;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;

import com.google.android.material.bottomsheet.BottomSheetDialog;
import com.google.android.material.chip.ChipGroup;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.mingxing.school.BaseActivity;
import com.mingxing.school.R;
import com.mingxing.school.data.SessionStore;
import com.mingxing.school.databinding.ActivityShopBinding;
import com.mingxing.school.net.ImageLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 明星商店（原生端）
 * 职责：把网页版商店的主要买家流程搬到原生界面，包含
 *      店铺列表 → 店铺商品 → 规格/套餐选择 → 购物车 → 下单 → 订单（取消/退款/管理员审核）。
 * 说明：全部内容视图由代码动态构建，视图之间通过字段 state 切换，避免多套布局状态冲突。
 */
public class ShopActivity extends BaseActivity {

    /** 视图状态：店铺列表（根页面） */
    private static final int VIEW_SHOPS = 0;
    /** 视图状态：单个店铺的商品列表 */
    private static final int VIEW_SHOP = 1;
    /** 视图状态：购物车 */
    private static final int VIEW_CART = 2;
    /** 视图状态：订单列表 */
    private static final int VIEW_ORDERS = 3;
    /** 视图状态：我的店铺（卖家自己的店铺列表） */
    private static final int VIEW_MY_SHOPS = 4;
    /** 视图状态：店铺管理（店铺信息 + 商品列表） */
    private static final int VIEW_MANAGE = 5;
    /** 视图状态：商品编辑表单 */
    private static final int VIEW_PRODUCT_EDIT = 6;
    /** 视图状态：管理后台（统计 + 全部店铺） */
    private static final int VIEW_ADMIN = 7;

    /** 图片上传最长边上限（像素）：与服务端 1.5MB 限制匹配 */
    private static final int IMAGE_MAX_SIDE = 1000;

    /** 视图绑定对象，访问顶栏按钮与内容容器 */
    private ActivityShopBinding binding;
    /** 登录会话，提供令牌与管理员标记 */
    private SessionStore sessionStore;
    /** 登录令牌，所有商店接口都要携带 */
    private String token;

    /** 当前视图状态 */
    private int view = VIEW_SHOPS;
    /** 当前浏览的店铺 id（VIEW_SHOP 时有效） */
    private String currentShopId = "";
    /** 当前浏览的店铺对象，用于判断营业/查封状态 */
    private JSONObject currentShop;
    /** 订单视图是否处于「全部订单」模式（仅管理员可切换） */
    private boolean ordersAll = false;
    /** 购物车角标数字（商品总件数） */
    private int cartCount = 0;
    /** 正在编辑的商品 id，空串表示新增 */
    private String editingProductId = "";
    /** 店铺管理页是否由管理后台进入（决定返回时回到哪里） */
    private boolean manageFromAdmin = false;
    /** 等待上传结果回填的图片地址输入框（店铺表单 / 商品表单共用） */
    private EditText pendingImageField;
    /** 系统图片选择器：选中后压缩上传并把地址回填到 pendingImageField */
    private ActivityResultLauncher<String> imagePicker;

    /**
     * 规格/套餐的选项数据（原生编辑用轻量模型，保存时再转 JSON）
     */
    private static class OptionItem {
        /** 选项名称，如「原味」 */
        String label = "";
        /** 价格加价（可为负） */
        double delta = 0;
    }

    /**
     * 普通商品的规格组：一组单选，可设必选
     */
    private static class SpecGroup {
        /** 组名，如「口味」 */
        String name = "";
        /** 是否必选 */
        boolean required = true;
        /** 组内选项 */
        final List<OptionItem> options = new ArrayList<>();
    }

    /**
     * 套餐分组：每组需恰好选固定件数
     */
    private static class ComboGroup {
        /** 组名，如「主食」 */
        String name = "";
        /** 固定件数（0 表示可不选） */
        int count = 1;
        /** 组内选项 */
        final List<OptionItem> options = new ArrayList<>();
    }

    /**
     * 页面创建：顶栏、返回逻辑、初始加载店铺列表与购物车角标
     * @param savedInstanceState 页面重建时的历史状态
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityShopBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());
        // 顶栏避让状态栏、内容区避让手势条；根背景铺满，避免底部出现白带
        applySystemBarsInsets(binding.layoutTopbar, binding.layoutContent);
        setStatusBarColor(R.color.mx_surface);        // 状态栏与白色顶栏同色
        setNavigationBarColor(R.color.mx_login_bg);   // 手势条区与淡蓝内容区同色

        sessionStore = new SessionStore(this);
        token = sessionStore.getToken();

        binding.btnBack.setOnClickListener(v -> onBackAction());
        // 顶栏左侧头像：点击弹出用户菜单（与主界面一致）
        attachTopbarAvatar(binding.layoutTopbarAvatar);
        binding.btnCart.setOnClickListener(v -> showCart());
        binding.btnOrders.setOnClickListener(v -> showOrders(false));

        // 图片选择器必须在 onCreate 阶段注册（早于 STARTED），否则会抛异常
        imagePicker = registerForActivityResult(
                new ActivityResultContracts.GetContent(),
                uri -> uploadPickedImage(uri));

        // 物理返回键：子页面回上一层，根页面退出
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (view == VIEW_SHOPS) {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                } else {
                    back();
                }
            }
        });

        showShops();
        refreshCartBadge();
    }

    /**
     * 页面销毁：释放绑定，避免异步回调操作已销毁视图
     */
    @Override
    protected void onDestroy() {
        super.onDestroy();
        binding = null;
    }

    // ==================== 通用视图工具 ====================

    /**
     * 构造纯色圆角背景
     * @param color 填充色
     * @param radiusDp 圆角半径（dp）
     * @return 可直接 setBackground 的 drawable
     */
    private GradientDrawable roundBg(int color, float radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(radiusDp));
        return d;
    }

    /**
     * 构造描边圆角背景（用于次要按钮）
     * @param fill 填充色
     * @param stroke 描边色
     * @param radiusDp 圆角半径（dp）
     * @return 可直接 setBackground 的 drawable
     */
    private GradientDrawable strokeBg(int fill, int stroke, float radiusDp) {
        GradientDrawable d = roundBg(fill, radiusDp);
        d.setStroke(dp(1), stroke);
        return d;
    }

    /**
     * 创建文本视图
     * @param text 文本内容
     * @param sizeSp 字号（sp）
     * @param color 文字颜色
     * @param bold 是否加粗
     * @return 文本视图
     */
    private TextView tv(String text, float sizeSp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(sizeSp);
        t.setTextColor(color);
        if (bold) {
            t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        }
        return t;
    }

    /**
     * 创建主操作胶囊按钮（主色实底）
     * @param text 按钮文字
     * @return 按钮视图
     */
    private TextView primaryButton(String text) {
        TextView b = tv(text, 14, getColor(R.color.mx_on_primary), true);
        b.setGravity(Gravity.CENTER);
        b.setBackground(roundBg(getColor(R.color.mx_primary), 22));
        b.setPadding(dp(18), dp(10), dp(18), dp(10));
        b.setClickable(true);
        return b;
    }

    /**
     * 创建次要胶囊按钮（白底描边）
     * @param text 按钮文字
     * @return 按钮视图
     */
    private TextView outlineButton(String text) {
        TextView b = tv(text, 13, getColor(R.color.mx_on_surface), false);
        b.setGravity(Gravity.CENTER);
        b.setBackground(strokeBg(getColor(R.color.mx_surface),
                getColor(R.color.mx_input_stroke), 20));
        b.setPadding(dp(14), dp(8), dp(14), dp(8));
        b.setClickable(true);
        return b;
    }

    /**
     * 清空内容区并返回一个带四周留白的纵向滚动页面容器
     * @return 用于填充内容的纵向容器
     */
    private LinearLayout createPage() {
        binding.layoutContent.removeAllViews();
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(16), dp(12), dp(16), dp(16));
        scroll.addView(column, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        binding.layoutContent.addView(scroll, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return column;
    }

    /**
     * 创建一张白色圆角卡片（列表项容器）
     * @return 纵向卡片容器
     */
    private LinearLayout createCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(roundBg(getColor(R.color.mx_surface), 16));
        card.setPadding(dp(14), dp(14), dp(14), dp(14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(12);
        card.setLayoutParams(lp);
        return card;
    }

    /**
     * 在页面中显示纯文本提示（空状态 / 加载中）
     * @param page 页面容器
     * @param text 提示文字
     */
    private void addEmptyTip(LinearLayout page, String text) {
        TextView tip = tv(text, 13, getColor(R.color.mx_on_surface_variant), false);
        tip.setGravity(Gravity.CENTER);
        tip.setPadding(0, dp(40), 0, dp(40));
        page.addView(tip);
    }

    /**
     * 弹出短提示
     * @param message 中文提示文案
     */
    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    /**
     * 设置顶栏标题
     * @param text 标题文字
     */
    private void setTitleText(String text) {
        if (binding != null) {
            binding.tvTitle.setText(text);
        }
    }

    /**
     * 顶栏返回按钮 / 物理返回的统一处理：按当前视图回到上一层
     */
    private void onBackAction() {
        if (view == VIEW_SHOPS) {
            finish();
        } else {
            back();
        }
    }

    /**
     * 返回上一层视图（店铺管理相关页面有自己的层级关系）
     */
    private void back() {
        switch (view) {
            case VIEW_MY_SHOPS:
            case VIEW_ADMIN:
                showShops();
                break;
            case VIEW_MANAGE:
                if (manageFromAdmin) {
                    showAdmin();
                } else {
                    showMyShops();
                }
                break;
            case VIEW_PRODUCT_EDIT:
                showManage(currentShopId);
                break;
            default:
                showShops();
                break;
        }
    }

    /**
     * 金额保留两位小数字符串，避免出现 3.0 之类的不整齐写法
     * @param value 金额
     * @return 形如 12.00 / 12.50 的字符串
     */
    private String money(double value) {
        return String.format(java.util.Locale.CHINA, "%.2f", value);
    }

    /**
     * 把服务端 ISO 时间转成「yyyy-MM-dd HH:mm」
     * @param iso ISO 时间串，如 2026-10-28T11:50:00.000Z
     * @return 便于阅读的时间文本
     */
    private String formatTime(String iso) {
        if (iso == null || iso.length() < 16) {
            return "";
        }
        return iso.substring(0, 16).replace('T', ' ');
    }

    /**
     * 商品/店铺封面：有图用图片（受登录保护，需带令牌），无图回退 emoji
     * @param parent 目标父容器
     * @param image 图片相对路径
     * @param emoji 兜底 emoji
     * @param sizeDp 边长（dp）
     * @return 封面视图（ImageView 或显示 emoji 的 TextView）
     */
    private View coverView(ViewGroup parent, String image, String emoji, float sizeDp) {
        int size = dp(sizeDp);
        String url = ShopApi.imageUrl(image);
        if (url.isEmpty()) {
            TextView icon = tv(emoji == null || emoji.isEmpty() ? "🛒" : emoji, 26,
                    getColor(R.color.mx_on_surface), false);
            icon.setGravity(Gravity.CENTER);
            icon.setBackground(roundBg(getColor(R.color.mx_input_stroke), 12));
            icon.setLayoutParams(new LinearLayout.LayoutParams(size, size));
            parent.addView(icon);
            return icon;
        }
        ImageView iv = new ImageView(this);
        iv.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        iv.setClipToOutline(false);
        iv.setBackground(roundBg(getColor(R.color.mx_input_stroke), 12));
        ImageLoader.load(iv, url, R.drawable.bg_cover_placeholder, token);
        parent.addView(iv);
        return iv;
    }

    // ==================== 店铺列表 ====================

    /**
     * 加载并展示店铺列表
     */
    private void showShops() {
        view = VIEW_SHOPS;
        currentShop = null;
        currentShopId = "";
        setTitleText(getString(R.string.shop_title));
        LinearLayout page = createPage();
        addShopListActions(page);
        addEmptyTip(page, getString(R.string.shop_loading));

        ShopApi.getShops(token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null || view != VIEW_SHOPS) {
                    return;
                }
                JSONArray shops = root.optJSONArray("data");
                LinearLayout fresh = createPage();
                addShopListActions(fresh);
                if (shops == null || shops.length() == 0) {
                    addEmptyTip(fresh, getString(R.string.shop_empty_shops));
                    return;
                }
                for (int i = 0; i < shops.length(); i++) {
                    JSONObject shop = shops.optJSONObject(i);
                    if (shop != null) {
                        fresh.addView(buildShopCard(shop));
                    }
                }
            }

            @Override
            public void onFailure(String message) {
                if (binding == null || view != VIEW_SHOPS) {
                    return;
                }
                LinearLayout fresh = createPage();
                addShopListActions(fresh);
                addEmptyTip(fresh, message);
            }
        });
    }

    /**
     * 构建单个店铺卡片：封面 + 店名 + 简介 + 状态标签，点击进入店铺
     * @param shop 店铺 JSON
     * @return 卡片视图
     */
    private View buildShopCard(JSONObject shop) {
        LinearLayout card = createCard();
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        coverView(row, shop.optString("image"), shop.optString("emoji", "🏬"), 52);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        infoLp.leftMargin = dp(12);
        info.setLayoutParams(infoLp);

        TextView name = tv(shop.optString("name", getString(R.string.shop_title)), 15,
                getColor(R.color.mx_on_surface), true);
        info.addView(name);

        String desc = shop.optString("description", "");
        if (!desc.isEmpty()) {
            TextView d = tv(desc, 12, getColor(R.color.mx_on_surface_variant), false);
            d.setMaxLines(2);
            d.setPadding(0, dp(3), 0, 0);
            info.addView(d);
        }

        // 状态标签：查封 > 休息 > 营业中
        boolean seized = shop.optBoolean("seized", false);
        boolean open = shop.optBoolean("isOpen", true);
        String statusText = seized ? getString(R.string.shop_status_seized)
                : (open ? getString(R.string.shop_status_open) : getString(R.string.shop_status_closed));
        TextView badge = tv(statusText, 11, seized || !open
                ? getColor(R.color.mx_on_surface_variant)
                : getColor(R.color.mx_on_primary), false);
        badge.setBackground(roundBg(seized || !open
                ? getColor(R.color.mx_input_stroke) : getColor(R.color.mx_primary), 10));
        badge.setPadding(dp(8), dp(3), dp(8), dp(3));
        LinearLayout.LayoutParams badgeLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        badgeLp.topMargin = dp(6);
        badge.setLayoutParams(badgeLp);
        info.addView(badge);

        row.addView(info);
        card.addView(row);
        card.setOnClickListener(v -> showShopDetail(shop));
        return card;
    }

    // ==================== 店铺详情（商品列表） ====================

    /**
     * 打开某个店铺，加载其商品列表
     * @param shop 店铺 JSON
     */
    private void showShopDetail(JSONObject shop) {
        view = VIEW_SHOP;
        currentShop = shop;
        currentShopId = shop.optString("id", "");
        setTitleText(shop.optString("name", getString(R.string.shop_title)));
        LinearLayout page = createPage();
        addEmptyTip(page, getString(R.string.shop_loading));

        ShopApi.getProducts(currentShopId, token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null) {
                    return;
                }
                JSONArray products = root.optJSONArray("data");
                LinearLayout fresh = createPage();
                // 查封店铺给出醒目提示（商品仍展示，但禁止加购）
                if (currentShop != null && currentShop.optBoolean("seized", false)) {
                    addNotice(fresh, getString(R.string.shop_seized_notice));
                }
                if (products == null || products.length() == 0) {
                    addEmptyTip(fresh, getString(R.string.shop_empty_products));
                    return;
                }
                for (int i = 0; i < products.length(); i++) {
                    JSONObject p = products.optJSONObject(i);
                    if (p != null && p.optBoolean("isAvailable", true)) {
                        fresh.addView(buildProductCard(p));
                    }
                }
            }

            @Override
            public void onFailure(String message) {
                if (binding == null) {
                    return;
                }
                LinearLayout fresh = createPage();
                addEmptyTip(fresh, message);
            }
        });
    }

    /**
     * 在页面顶部加一条浅色提示条
     * @param page 页面容器
     * @param text 提示文字
     */
    private void addNotice(LinearLayout page, String text) {
        TextView notice = tv(text, 12, getColor(R.color.mx_on_primary_container), false);
        notice.setBackground(roundBg(getColor(R.color.mx_primary_container), 12));
        notice.setPadding(dp(12), dp(10), dp(12), dp(10));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(12);
        notice.setLayoutParams(lp);
        page.addView(notice);
    }

    /**
     * 构建商品卡片：封面 + 名称 + 规格提示 + 价格 + 销量，右下角「+」加购按钮
     * @param product 商品 JSON
     * @return 卡片视图
     */
    private View buildProductCard(JSONObject product) {
        LinearLayout card = createCard();
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        coverView(row, product.optString("image"), product.optString("emoji", "🛒"), 64);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        infoLp.leftMargin = dp(12);
        info.setLayoutParams(infoLp);

        info.addView(tv(product.optString("name", ""), 15,
                getColor(R.color.mx_on_surface), true));

        String desc = product.optString("description", "");
        if (!desc.isEmpty()) {
            TextView d = tv(desc, 12, getColor(R.color.mx_on_surface_variant), false);
            d.setMaxLines(2);
            d.setPadding(0, dp(2), 0, 0);
            info.addView(d);
        }

        // 规格/套餐提示：让买家知道点击后会弹出选择面板
        boolean isCombo = product.optBoolean("isCombo", false);
        JSONArray specs = product.optJSONArray("specs");
        if (isCombo || (specs != null && specs.length() > 0)) {
            info.addView(tv(isCombo ? getString(R.string.shop_combo)
                    : getString(R.string.shop_multi_spec), 11,
                    getColor(R.color.mx_on_surface_variant), false));
        }

        // 价格行：主色价格 + 销量
        LinearLayout priceRow = new LinearLayout(this);
        priceRow.setOrientation(LinearLayout.HORIZONTAL);
        priceRow.setGravity(Gravity.CENTER_VERTICAL);
        priceRow.setPadding(0, dp(4), 0, 0);
        TextView price = tv(getString(R.string.shop_price_prefix) + money(product.optDouble("price", 0)),
                16, getColor(R.color.mx_primary), true);
        priceRow.addView(price);
        int sales = product.optInt("sales", 0);
        if (sales > 0) {
            TextView sold = tv("  " + getString(R.string.shop_sold, sales), 11,
                    getColor(R.color.mx_on_surface_variant), false);
            priceRow.addView(sold);
        }
        info.addView(priceRow);
        row.addView(info);

        // 加购按钮：圆形主色「+」，点击进入规格选择
        TextView add = tv("+", 22, getColor(R.color.mx_on_primary), true);
        add.setGravity(Gravity.CENTER);
        add.setBackground(roundBg(getColor(R.color.mx_primary), 24));
        LinearLayout.LayoutParams addLp = new LinearLayout.LayoutParams(dp(32), dp(32));
        addLp.leftMargin = dp(8);
        add.setLayoutParams(addLp);
        add.setOnClickListener(v -> openProductChooser(product));
        row.addView(add);

        card.addView(row);
        return card;
    }

    // ==================== 规格 / 套餐选择面板 ====================

    /**
     * 打开商品选择面板（底部弹层）：单选规格、套餐计数、数量步进、实时合计
     * @param product 商品 JSON
     */
    private void openProductChooser(JSONObject product) {
        if (currentShop != null && currentShop.optBoolean("seized", false)) {
            toast(getString(R.string.shop_seized_notice));
            return;
        }
        boolean isCombo = product.optBoolean("isCombo", false);
        JSONArray specs = product.optJSONArray("specs");
        JSONArray comboGroups = product.optJSONArray("comboGroups");
        boolean hasSpecs = specs != null && specs.length() > 0;
        boolean hasCombo = isCombo && comboGroups != null && comboGroups.length() > 0;
        // 无规格无套餐：直接加购，省掉多余弹层
        if (!hasSpecs && !hasCombo) {
            addToCart(product, null, null, 1);
            return;
        }

        BottomSheetDialog sheet = new BottomSheetDialog(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(16), dp(20), dp(20));
        content.setBackground(roundBg(getColor(R.color.mx_surface), 20));

        double basePrice = product.optDouble("price", 0);

        // 标题：商品名 + 基础价
        content.addView(tv(product.optString("name", ""), 17,
                getColor(R.color.mx_on_surface), true));
        content.addView(tv(getString(R.string.shop_price_prefix) + money(basePrice), 14,
                getColor(R.color.mx_primary), true));

        /* 规格选择的选中态：下标对应 specs 组序号，值为选中的 label */
        List<String[]> pickedSpecs = new ArrayList<>();
        /* 套餐各组的选项计数：groups → options 的件数 */
        List<int[]> comboCounts = new ArrayList<>();
        /* 套餐各组固定件数 */
        List<Integer> comboNeeds = new ArrayList<>();
        /* 合计金额的实时展示 */
        double[] total = {0};
        int[] quantity = {1};
        /* 底部合计文本：规格、套餐、数量任一变化都需要刷新 */
        TextView totalView = tv(getString(R.string.shop_total_amount, money(total[0])), 15,
                getColor(R.color.mx_primary), true);

        // 普通商品的规格组
        if (hasSpecs) {
            for (int i = 0; i < specs.length(); i++) {
                JSONObject group = specs.optJSONObject(i);
                if (group == null) {
                    continue;
                }
                final String[] picked = new String[1];
                pickedSpecs.add(picked);
                addGroupTitle(content, group.optString("name", ""),
                        group.optBoolean("required", true));

                ChipGroup chipGroup = new ChipGroup(this);
                chipGroup.setSingleLine(false);
                LinearLayout.LayoutParams chipLp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                chipLp.bottomMargin = dp(8);
                chipGroup.setLayoutParams(chipLp);

                JSONArray options = group.optJSONArray("options");
                if (options != null) {
                    for (int k = 0; k < options.length(); k++) {
                        JSONObject opt = options.optJSONObject(k);
                        if (opt == null) {
                            continue;
                        }
                        String label = opt.optString("label", "");
                        TextView chip = makeChoiceChip(label, opt.optDouble("priceDelta", 0), false);
                        chip.setOnClickListener(v -> {
                            picked[0] = label;
                            refreshChips(chipGroup, label);
                            // 规格带加价，选中后要同步刷新合计金额
                            total[0] = calcTotal(product, pickedSpecs, comboCounts, quantity[0]);
                            totalView.setText(getString(R.string.shop_total_amount, money(total[0])));
                        });
                        chipGroup.addView(chip);
                    }
                }
                content.addView(chipGroup);
            }
        }

        // 套餐分组：每组按固定件数选择，可重复选同一项
        if (hasCombo) {
            for (int i = 0; i < comboGroups.length(); i++) {
                JSONObject group = comboGroups.optJSONObject(i);
                if (group == null) {
                    continue;
                }
                String groupName = group.optString("name", "");
                int need = group.optInt("count", 1);
                JSONArray options = group.optJSONArray("options");
                int optionCount = options == null ? 0 : options.length();
                final int[] counts = new int[optionCount];
                comboCounts.add(counts);
                comboNeeds.add(need);

                addGroupTitle(content, groupName, need > 0);
                TextView needTip = tv(getString(R.string.shop_combo_need, need), 11,
                        getColor(R.color.mx_on_surface_variant), false);
                needTip.setPadding(0, dp(2), 0, dp(6));
                content.addView(needTip);

                for (int k = 0; k < optionCount; k++) {
                    JSONObject opt = options.optJSONObject(k);
                    if (opt == null) {
                        continue;
                    }
                    final int index = k;
                    final int groupIndex = i;
                    content.addView(buildComboRow(opt.optString("label", ""),
                            opt.optDouble("priceDelta", 0), counts, index,
                            comboNeeds, groupIndex, () -> {
                                total[0] = calcTotal(product, pickedSpecs, comboCounts, quantity[0]);
                                totalView.setText(getString(R.string.shop_total_amount, money(total[0])));
                            }));
                }
            }
        }

        // 数量步进
        LinearLayout qtyRow = new LinearLayout(this);
        qtyRow.setOrientation(LinearLayout.HORIZONTAL);
        qtyRow.setGravity(Gravity.CENTER_VERTICAL);
        qtyRow.setPadding(0, dp(10), 0, dp(4));
        // 左侧「数量」文字占满剩余空间，把步进器推到最右
        TextView qtyLabel = tv(getString(R.string.shop_quantity), 14,
                getColor(R.color.mx_on_surface), true);
        qtyLabel.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        qtyRow.addView(qtyLabel);
        qtyRow.addView(buildStepper(quantity, 1, 99, () -> {
            total[0] = calcTotal(product, pickedSpecs, comboCounts, quantity[0]);
            totalView.setText(getString(R.string.shop_total_amount, money(total[0])));
        }));
        content.addView(qtyRow);

        // 底部合计 + 加入购物车
        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.HORIZONTAL);
        bottom.setGravity(Gravity.CENTER_VERTICAL);
        bottom.setPadding(0, dp(14), 0, 0);

        total[0] = calcTotal(product, pickedSpecs, comboCounts, quantity[0]);
        totalView.setText(getString(R.string.shop_total_amount, money(total[0])));
        bottom.addView(totalView, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView confirm = primaryButton(getString(R.string.shop_add_to_cart));
        confirm.setOnClickListener(v -> {
            // 校验必选规格
            if (hasSpecs) {
                for (int i = 0; i < pickedSpecs.size(); i++) {
                    JSONObject group = specs.optJSONObject(i);
                    boolean required = group != null && group.optBoolean("required", true);
                    if (required && (pickedSpecs.get(i)[0] == null || pickedSpecs.get(i)[0].isEmpty())) {
                        toast(getString(R.string.shop_spec_incomplete));
                        return;
                    }
                }
            }
            // 校验套餐各组件数是否等于固定件数
            for (int i = 0; i < comboCounts.size(); i++) {
                int sum = 0;
                for (int c : comboCounts.get(i)) {
                    sum += c;
                }
                if (sum != comboNeeds.get(i)) {
                    JSONObject group = comboGroups.optJSONObject(i);
                    toast(getString(R.string.shop_combo_incomplete,
                            group == null ? "" : group.optString("name", ""), comboNeeds.get(i)));
                    return;
                }
            }

            // 组装参数：普通商品传规格 label 数组，套餐传 groupName/label/count 明细
            JSONArray specArray = new JSONArray();
            for (String[] picked : pickedSpecs) {
                if (picked[0] != null && !picked[0].isEmpty()) {
                    specArray.put(picked[0]);
                }
            }
            JSONArray comboArray = new JSONArray();
            if (hasCombo) {
                for (int i = 0; i < comboCounts.size(); i++) {
                    JSONObject group = comboGroups.optJSONObject(i);
                    JSONArray options = group == null ? null : group.optJSONArray("options");
                    int[] counts = comboCounts.get(i);
                    for (int k = 0; k < counts.length && options != null; k++) {
                        if (counts[k] <= 0) {
                            continue;
                        }
                        JSONObject item = new JSONObject();
                        try {
                            item.put("groupName", group.optString("name", ""));
                            item.put("label", options.optJSONObject(k).optString("label", ""));
                            item.put("count", counts[k]);
                        } catch (Exception ignored) {
                            // 写入基础类型不会抛异常，此处仅作防御
                        }
                        comboArray.put(item);
                    }
                }
            }
            addToCart(product, specArray.length() > 0 ? specArray : null,
                    comboArray.length() > 0 ? comboArray : null, quantity[0]);
            sheet.dismiss();
        });
        bottom.addView(confirm);
        content.addView(bottom);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        sheet.setContentView(scroll);
        sheet.show();
    }

    /**
     * 规格组标题：组名 + 必选/可选标记
     * @param parent 目标容器
     * @param name 组名
     * @param required 是否必选
     */
    private void addGroupTitle(LinearLayout parent, String name, boolean required) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(12), 0, dp(6));
        row.addView(tv(name, 14, getColor(R.color.mx_on_surface), true));
        TextView mark = tv(required ? getString(R.string.shop_required) : getString(R.string.shop_optional),
                10, required ? getColor(R.color.mx_error) : getColor(R.color.mx_on_surface_variant), false);
        LinearLayout.LayoutParams markLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        markLp.leftMargin = dp(6);
        mark.setLayoutParams(markLp);
        row.addView(mark);
        parent.addView(row);
    }

    /**
     * 构造可点选规格项（选中态：主色描边 + 主色文字）
     * @param label 选项名
     * @param delta 价格加成，0 时不显示
     * @param selected 初始是否选中
     * @return 选项视图
     */
    private TextView makeChoiceChip(String label, double delta, boolean selected) {
        String text = label + (delta != 0
                ? " " + (delta > 0 ? "+" : "-") + getString(R.string.shop_price_prefix) + money(Math.abs(delta))
                : "");
        TextView chip = tv(text, 13, getColor(R.color.mx_on_surface), false);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(dp(12), dp(7), dp(12), dp(7));
        chip.setTag(label);
        chip.setBackground(selected
                ? strokeBg(getColor(R.color.mx_primary_container), getColor(R.color.mx_primary), 16)
                : roundBg(getColor(R.color.mx_input_stroke), 16));
        ViewGroup.MarginLayoutParams lp = new ViewGroup.MarginLayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(8);
        lp.bottomMargin = dp(8);
        chip.setLayoutParams(lp);
        return chip;
    }

    /**
     * 按当前选中值刷新同组所有选项的样式（单选：同组只有一项高亮）
     * @param group 选项所在的 ChipGroup
     * @param picked 当前选中的 label
     */
    private void refreshChips(ChipGroup group, String picked) {
        for (int i = 0; i < group.getChildCount(); i++) {
            TextView child = (TextView) group.getChildAt(i);
            boolean on = picked != null && picked.equals(String.valueOf(child.getTag()));
            child.setTextColor(on ? getColor(R.color.mx_on_primary_container)
                    : getColor(R.color.mx_on_surface));
            child.setBackground(on
                    ? strokeBg(getColor(R.color.mx_primary_container), getColor(R.color.mx_primary), 16)
                    : roundBg(getColor(R.color.mx_input_stroke), 16));
        }
    }

    /**
     * 构造套餐选项行：名称（含加价）+ 减号 + 件数 + 加号
     * @param label 选项名
     * @param delta 价格加成
     * @param counts 该组的件数数组（下标为选项序号）
     * @param index 当前选项序号
     * @param needs 各组的固定件数
     * @param groupIndex 当前组序号
     * @param onChanged 件数变化后的回调（刷新合计）
     * @return 选项行视图
     */
    private View buildComboRow(String label, double delta, int[] counts, int index,
                               List<Integer> needs, int groupIndex, Runnable onChanged) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(4), 0, dp(4));

        TextView name = tv(label + (delta != 0
                ? " " + (delta > 0 ? "+" : "-") + getString(R.string.shop_price_prefix) + money(Math.abs(delta))
                : ""), 13, getColor(R.color.mx_on_surface), false);
        name.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(name);

        TextView value = tv(String.valueOf(counts[index]), 14,
                getColor(R.color.mx_on_surface), true);
        value.setGravity(Gravity.CENTER);
        value.setLayoutParams(new LinearLayout.LayoutParams(dp(24),
                ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView minus = stepButton("−");
        TextView plus = stepButton("+");

        minus.setOnClickListener(v -> {
            if (counts[index] > 0) {
                counts[index]--;
                value.setText(String.valueOf(counts[index]));
                onChanged.run();
            }
        });
        plus.setOnClickListener(v -> {
            // 本组件数到达固定件数后不再增加，避免提交时校验失败
            int sum = 0;
            for (int c : counts) {
                sum += c;
            }
            if (sum < needs.get(groupIndex)) {
                counts[index]++;
                value.setText(String.valueOf(counts[index]));
                onChanged.run();
            } else {
                toast(getString(R.string.shop_combo_need, needs.get(groupIndex)));
            }
        });

        row.addView(minus);
        row.addView(value);
        row.addView(plus);
        return row;
    }

    /**
     * 步进器用的圆形加减按钮
     * @param text 显示的符号（+ / −）
     * @return 按钮视图
     */
    private TextView stepButton(String text) {
        TextView b = tv(text, 15, getColor(R.color.mx_on_surface), true);
        b.setGravity(Gravity.CENTER);
        b.setBackground(strokeBg(getColor(R.color.mx_surface),
                getColor(R.color.mx_input_stroke), 14));
        b.setLayoutParams(new LinearLayout.LayoutParams(dp(28), dp(28)));
        return b;
    }

    /**
     * 构造数量步进器（− 数值 +）
     * @param quantity 数量持有数组（下标 0），与调用方共享同一份状态
     * @param min 允许的最小数量
     * @param max 允许的最大数量
     * @param onChanged 数值变化回调，用于刷新合计金额
     * @return 步进器视图
     */
    private LinearLayout buildStepper(int[] quantity, int min, int max, Runnable onChanged) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        TextView value = tv(String.valueOf(quantity[0]), 14, getColor(R.color.mx_on_surface), true);
        value.setGravity(Gravity.CENTER);
        value.setLayoutParams(new LinearLayout.LayoutParams(dp(32),
                ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView minus = stepButton("−");
        TextView plus = stepButton("+");
        minus.setOnClickListener(v -> {
            if (quantity[0] > min) {
                quantity[0]--;
                value.setText(String.valueOf(quantity[0]));
                onChanged.run();
            }
        });
        plus.setOnClickListener(v -> {
            if (quantity[0] < max) {
                quantity[0]++;
                value.setText(String.valueOf(quantity[0]));
                onChanged.run();
            }
        });

        row.addView(minus);
        row.addView(value);
        row.addView(plus);
        return row;
    }

    /**
     * 计算当前选择的合计金额
     * @param product 商品
     * @param pickedSpecs 各规格组选中值（按组序）
     * @param comboCounts 套餐各组各选项件数
     * @param quantity 购买数量
     * @return 合计金额
     */
    private double calcTotal(JSONObject product, List<String[]> pickedSpecs,
                            List<int[]> comboCounts, int quantity) {
        double unit = product.optDouble("price", 0);
        // 规格加价
        JSONArray specs = product.optJSONArray("specs");
        if (specs != null) {
            for (int i = 0; i < specs.length() && i < pickedSpecs.size(); i++) {
                JSONObject group = specs.optJSONObject(i);
                JSONArray options = group == null ? null : group.optJSONArray("options");
                String picked = pickedSpecs.get(i)[0];
                if (options == null || picked == null) {
                    continue;
                }
                for (int k = 0; k < options.length(); k++) {
                    JSONObject opt = options.optJSONObject(k);
                    if (opt != null && picked.equals(opt.optString("label", ""))) {
                        unit += opt.optDouble("priceDelta", 0);
                        break;
                    }
                }
            }
        }
        // 套餐加价：按各选项件数累计
        JSONArray groups = product.optJSONArray("comboGroups");
        if (groups != null) {
            for (int i = 0; i < groups.length() && i < comboCounts.size(); i++) {
                JSONObject group = groups.optJSONObject(i);
                JSONArray options = group == null ? null : group.optJSONArray("options");
                int[] counts = comboCounts.get(i);
                if (options == null) {
                    continue;
                }
                for (int k = 0; k < counts.length && k < options.length(); k++) {
                    JSONObject opt = options.optJSONObject(k);
                    if (opt != null) {
                        unit += opt.optDouble("priceDelta", 0) * counts[k];
                    }
                }
            }
        }
        return Math.round(unit * quantity * 100) / 100.0;
    }

    /**
     * 提交加入购物车
     * @param product 商品
     * @param specs 规格 label 数组，可为 null
     * @param combo 套餐明细数组，可为 null
     * @param quantity 数量
     */
    private void addToCart(JSONObject product, JSONArray specs, JSONArray combo, int quantity) {
        JSONObject body = new JSONObject();
        try {
            body.put("productId", product.optString("id", ""));
            body.put("quantity", quantity);
            if (specs != null) {
                body.put("specs", specs);
            }
            if (combo != null) {
                body.put("combo", combo);
            }
        } catch (Exception ignored) {
            // 写入基础类型不会抛异常
        }
        ShopApi.addToCart(body, token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                toast(getString(R.string.shop_added_to_cart));
                updateBadgeFromCart(root.optJSONObject("data"));
            }

            @Override
            public void onFailure(String message) {
                toast(message);
            }
        });
    }

    // ==================== 购物车 ====================

    /**
     * 展示购物车：行内改量、清空、结算下单
     */
    private void showCart() {
        view = VIEW_CART;
        setTitleText(getString(R.string.shop_cart));
        LinearLayout page = createPage();
        addEmptyTip(page, getString(R.string.shop_loading));

        ShopApi.getCart(token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null) {
                    return;
                }
                JSONObject data = root.optJSONObject("data");
                updateBadgeFromCart(data);
                renderCart(data);
            }

            @Override
            public void onFailure(String message) {
                if (binding == null) {
                    return;
                }
                LinearLayout fresh = createPage();
                addEmptyTip(fresh, message);
            }
        });
    }

    /**
     * 用购物车视图渲染整页（数据变化后整体重绘，逻辑最简单也最不容易状态错乱）
     * @param data 购物车视图 {items, totalAmount, count}
     */
    private void renderCart(JSONObject data) {
        LinearLayout page = createPage();
        JSONArray items = data == null ? null : data.optJSONArray("items");
        if (items == null || items.length() == 0) {
            addEmptyTip(page, getString(R.string.shop_cart_empty));
            TextView go = primaryButton(getString(R.string.shop_go_shopping));
            go.setOnClickListener(v -> showShops());
            page.addView(go);
            return;
        }

        double totalAmount = data.optDouble("totalAmount", 0);

        // 顶部工具行：件数 + 清空
        LinearLayout tools = new LinearLayout(this);
        tools.setOrientation(LinearLayout.HORIZONTAL);
        tools.setGravity(Gravity.CENTER_VERTICAL);
        tools.setPadding(0, 0, 0, dp(10));
        TextView countText = tv(getString(R.string.shop_cart_count, data.optInt("count", 0)), 13,
                getColor(R.color.mx_on_surface_variant), false);
        countText.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        tools.addView(countText);
        TextView clear = outlineButton(getString(R.string.shop_cart_clear));
        clear.setOnClickListener(v -> confirmClearCart());
        tools.addView(clear);
        page.addView(tools);

        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item != null) {
                page.addView(buildCartRow(item));
            }
        }

        // 底部结算栏：合计 + 结算按钮
        LinearLayout checkout = new LinearLayout(this);
        checkout.setOrientation(LinearLayout.HORIZONTAL);
        checkout.setGravity(Gravity.CENTER_VERTICAL);
        checkout.setPadding(0, dp(8), 0, 0);
        TextView totalView = tv(getString(R.string.shop_total_amount, money(totalAmount)), 16,
                getColor(R.color.mx_primary), true);
        totalView.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        checkout.addView(totalView);
        TextView pay = primaryButton(getString(R.string.shop_checkout));
        pay.setOnClickListener(v -> placeOrder());
        checkout.addView(pay);
        page.addView(checkout);
    }

    /**
     * 构建购物车行：封面 + 名称 + 规格文本 + 单价 + 数量步进
     * @param item 购物车行 JSON
     * @return 行视图
     */
    private View buildCartRow(JSONObject item) {
        LinearLayout card = createCard();
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        coverView(row, item.optString("image"), item.optString("emoji", "🛒"), 52);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        infoLp.leftMargin = dp(12);
        info.setLayoutParams(infoLp);

        info.addView(tv(item.optString("name", ""), 14, getColor(R.color.mx_on_surface), true));

        // 规格或套餐文本（二选一，套餐商品没有 specText）
        String detail = item.optBoolean("isCombo", false)
                ? item.optString("comboText", "") : item.optString("specText", "");
        if (!detail.isEmpty()) {
            info.addView(tv(detail, 11, getColor(R.color.mx_on_surface_variant), false));
        }
        info.addView(tv(item.optString("shopName", ""), 11,
                getColor(R.color.mx_on_surface_variant), false));

        TextView price = tv(getString(R.string.shop_price_prefix) + money(item.optDouble("unitPrice", 0)),
                14, getColor(R.color.mx_primary), true);
        price.setPadding(0, dp(4), 0, 0);
        info.addView(price);
        row.addView(info);

        // 数量步进：改为直接请求服务端并整页重绘，保证数据以服务端为准
        int[] quantity = {item.optInt("quantity", 1)};
        String lineKey = item.optString("lineKey", "");
        LinearLayout stepperBox = new LinearLayout(this);
        stepperBox.setOrientation(LinearLayout.HORIZONTAL);
        stepperBox.setGravity(Gravity.CENTER_VERTICAL);
        TextView value = tv(String.valueOf(quantity[0]), 14, getColor(R.color.mx_on_surface), true);
        value.setGravity(Gravity.CENTER);
        value.setLayoutParams(new LinearLayout.LayoutParams(dp(30),
                ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView minus = stepButton("−");
        TextView plus = stepButton("+");
        minus.setOnClickListener(v -> changeQuantity(lineKey, quantity[0] - 1));
        plus.setOnClickListener(v -> changeQuantity(lineKey, quantity[0] + 1));
        stepperBox.addView(minus);
        stepperBox.addView(value);
        stepperBox.addView(plus);
        row.addView(stepperBox);

        card.addView(row);
        return card;
    }

    /**
     * 修改购物车某行数量（数量 <= 0 时服务端会移除该行）
     * @param lineKey 购物车行标识
     * @param quantity 目标数量
     */
    private void changeQuantity(String lineKey, int quantity) {
        if (quantity > 99) {
            return;
        }
        ShopApi.updateCartLine(lineKey, quantity, token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null) {
                    return;
                }
                JSONObject data = root.optJSONObject("data");
                updateBadgeFromCart(data);
                renderCart(data);
            }

            @Override
            public void onFailure(String message) {
                toast(message);
            }
        });
    }

    /**
     * 清空购物车（二次确认，避免误点）
     */
    private void confirmClearCart() {
        new MaterialAlertDialogBuilder(this)
                .setMessage(getString(R.string.shop_cart_clear_confirm))
                .setNegativeButton(getString(R.string.shop_order_closed), null)
                .setPositiveButton(getString(R.string.shop_cart_clear), (d, w) ->
                        ShopApi.clearCart(token, new ShopApi.Callback() {
                            @Override
                            public void onSuccess(JSONObject root) {
                                if (binding == null) {
                                    return;
                                }
                                toast(getString(R.string.shop_cart_cleared));
                                JSONObject data = root.optJSONObject("data");
                                updateBadgeFromCart(data);
                                renderCart(data);
                            }

                            @Override
                            public void onFailure(String message) {
                                toast(message);
                            }
                        }))
                .show();
    }

    /**
     * 购物车整体下单（平台为上门取货模式，无地址参数）
     */
    private void placeOrder() {
        JSONObject body = new JSONObject();
        try {
            body.put("note", "");
        } catch (Exception ignored) {
            // 字符串写入不会抛异常
        }
        ShopApi.createOrder(body, token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null) {
                    return;
                }
                JSONObject order = root.optJSONObject("data");
                double remaining = order == null ? 0 : order.optDouble("remainingPoints", 0);
                toast(getString(R.string.shop_order_placed, money(remaining)));
                cartCount = 0;
                updateBadge(0);
                showOrders(false);
            }

            @Override
            public void onFailure(String message) {
                toast(message);
            }
        });
    }

    // ==================== 订单 ====================

    /**
     * 展示订单列表
     * @param all true 表示查看全部订单（仅管理员生效）
     */
    private void showOrders(boolean all) {
        view = VIEW_ORDERS;
        ordersAll = all && sessionStore.isAdmin();
        setTitleText(getString(R.string.shop_orders));
        LinearLayout page = createPage();
        addEmptyTip(page, getString(R.string.shop_loading));

        ShopApi.getOrders(ordersAll, token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null) {
                    return;
                }
                JSONArray orders = root.optJSONArray("data");
                LinearLayout fresh = createPage();

                // 管理员可切换「全部订单 / 我的订单」
                if (sessionStore.isAdmin()) {
                    LinearLayout tools = new LinearLayout(ShopActivity.this);
                    tools.setOrientation(LinearLayout.HORIZONTAL);
                    tools.setGravity(Gravity.CENTER_VERTICAL);
                    tools.setPadding(0, 0, 0, dp(10));
                    TextView filler = tv("", 12, getColor(R.color.mx_on_surface_variant), false);
                    filler.setLayoutParams(new LinearLayout.LayoutParams(0,
                            ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                    tools.addView(filler);
                    TextView toggle = outlineButton(getString(ordersAll
                            ? R.string.shop_order_mine : R.string.shop_order_all));
                    toggle.setOnClickListener(v -> showOrders(!ordersAll));
                    tools.addView(toggle);
                    fresh.addView(tools);
                }

                if (orders == null || orders.length() == 0) {
                    addEmptyTip(fresh, getString(R.string.shop_orders_empty));
                    return;
                }
                for (int i = 0; i < orders.length(); i++) {
                    JSONObject order = orders.optJSONObject(i);
                    if (order != null) {
                        fresh.addView(buildOrderCard(order));
                    }
                }
            }

            @Override
            public void onFailure(String message) {
                if (binding == null) {
                    return;
                }
                LinearLayout fresh = createPage();
                addEmptyTip(fresh, message);
            }
        });
    }

    /**
     * 构建订单卡片：状态、时间、商品概要、金额、以及按身份/状态显示的快捷操作
     * @param order 订单 JSON
     * @return 卡片视图
     */
    private View buildOrderCard(JSONObject order) {
        LinearLayout card = createCard();
        String orderId = order.optString("id", "");
        String status = order.optString("status", "");
        String refundStatus = order.optString("refundStatus", "");
        boolean isAdmin = sessionStore.isAdmin();
        boolean isMine = sessionStore.getUserId().equals(order.optString("userId", ""));

        // 头部：状态标签 + 订单号
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView badge = statusBadge(status, refundStatus);
        head.addView(badge);
        TextView idText = tv(getString(R.string.shop_order_no, orderId), 11,
                getColor(R.color.mx_on_surface_variant), false);
        idText.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        idText.setGravity(Gravity.END);
        head.addView(idText);
        card.addView(head);

        card.addView(tv(formatTime(order.optString("createdAt", "")), 11,
                getColor(R.color.mx_on_surface_variant), false));

        // 商品概要：首件商品名 + 其余件数
        JSONArray items = order.optJSONArray("items");
        String summary = "";
        int totalCount = 0;
        if (items != null && items.length() > 0) {
            JSONObject first = items.optJSONObject(0);
            summary = first == null ? "" : first.optString("productName", "");
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                totalCount += it == null ? 0 : it.optInt("quantity", 0);
            }
        }
        TextView summaryView = tv(summary, 14, getColor(R.color.mx_on_surface), true);
        summaryView.setPadding(0, dp(8), 0, 0);
        card.addView(summaryView);
        if (totalCount > 1) {
            card.addView(tv(getString(R.string.shop_order_more, totalCount), 11,
                    getColor(R.color.mx_on_surface_variant), false));
        }
        card.addView(tv(getString(R.string.shop_order_total, money(order.optDouble("totalAmount", 0))),
                14, getColor(R.color.mx_primary), true));

        // 退款状态说明
        if ("pending".equals(refundStatus)) {
            card.addView(tv(getString(R.string.shop_refund_pending), 11,
                    getColor(R.color.mx_error), false));
        } else if ("rejected".equals(refundStatus)) {
            String reason = order.optString("refundRejectReason", "");
            card.addView(tv(reason.isEmpty() ? getString(R.string.shop_refund_rejected)
                            : getString(R.string.shop_refund_rejected_reason, reason),
                    11, getColor(R.color.mx_error), false));
        } else if ("approved".equals(refundStatus)) {
            card.addView(tv(getString(R.string.shop_refund_approved), 11,
                    getColor(R.color.mx_on_surface_variant), false));
        }

        // 操作区：买家（取消/退款）+ 管理员（改状态/审核退款）
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.END);
        actions.setPadding(0, dp(10), 0, 0);

        if (isMine && "pending".equals(status)) {
            TextView cancel = outlineButton(getString(R.string.shop_cancel_order));
            cancel.setOnClickListener(v -> confirmCancel(orderId));
            addAction(actions, cancel);
        }
        boolean refundable = isMine && !"cancelled".equals(status) && !"refunded".equals(status)
                && !"pending".equals(refundStatus) && !"approved".equals(refundStatus);
        if (refundable) {
            TextView refund = outlineButton(getString(R.string.shop_refund));
            refund.setOnClickListener(v -> showRefundDialog(order));
            addAction(actions, refund);
        }
        if (isAdmin && "pending".equals(refundStatus)) {
            TextView review = outlineButton(getString(R.string.shop_refund_review));
            review.setOnClickListener(v -> showRefundReviewDialog(orderId,
                    order.optDouble("refundAmount", order.optDouble("totalAmount", 0))));
            addAction(actions, review);
        }
        if (isAdmin) {
            TextView change = outlineButton(getString(R.string.shop_change_status));
            change.setOnClickListener(v -> showStatusDialog(orderId, status));
            addAction(actions, change);
        }

        if (actions.getChildCount() > 0) {
            card.addView(actions);
        }
        card.setOnClickListener(v -> showOrderDetail(order));
        return card;
    }

    /**
     * 向操作行追加一个按钮并设置左间距
     * @param actions 操作行
     * @param button 按钮
     */
    private void addAction(LinearLayout actions, TextView button) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(8);
        button.setLayoutParams(lp);
        actions.addView(button);
    }

    /**
     * 订单状态标签（退款中/已退款时优先提示退款状态）
     * @param status 订单状态
     * @param refundStatus 退款状态
     * @return 标签视图
     */
    private TextView statusBadge(String status, String refundStatus) {
        String text;
        int bgColor;
        int textColor;
        if ("pending".equals(refundStatus)) {
            text = getString(R.string.shop_refund_pending);
            bgColor = getColor(R.color.mx_primary_container);
            textColor = getColor(R.color.mx_on_primary_container);
        } else if ("refunded".equals(status) || "approved".equals(refundStatus)) {
            text = getString(R.string.shop_refund_approved);
            bgColor = getColor(R.color.mx_input_stroke);
            textColor = getColor(R.color.mx_on_surface_variant);
        } else if ("cancelled".equals(status)) {
            text = statusText(status);
            bgColor = getColor(R.color.mx_input_stroke);
            textColor = getColor(R.color.mx_on_surface_variant);
        } else if ("completed".equals(status)) {
            text = statusText(status);
            bgColor = getColor(R.color.mx_input_stroke);
            textColor = getColor(R.color.mx_on_surface_variant);
        } else if ("delivering".equals(status)) {
            text = statusText(status);
            bgColor = getColor(R.color.mx_online);
            textColor = getColor(R.color.mx_on_primary);
        } else {
            text = statusText(status);
            bgColor = getColor(R.color.mx_primary);
            textColor = getColor(R.color.mx_on_primary);
        }
        TextView badge = tv(text, 11, textColor, false);
        badge.setBackground(roundBg(bgColor, 10));
        badge.setPadding(dp(8), dp(3), dp(8), dp(3));
        return badge;
    }

    /**
     * 订单状态英译中（与网页端 STATUS_TEXT 保持一致）
     * @param status 状态枚举
     * @return 中文状态
     */
    private String statusText(String status) {
        switch (status) {
            case "pending":
                return "待确认";
            case "confirmed":
                return "已确认";
            case "delivering":
                return "待取货";
            case "completed":
                return "已完成";
            case "cancelled":
                return "已取消";
            case "refunded":
                return "已退款";
            default:
                return status;
        }
    }

    /**
     * 取消订单确认弹窗
     * @param orderId 订单 id
     */
    private void confirmCancel(String orderId) {
        new MaterialAlertDialogBuilder(this)
                .setMessage(getString(R.string.shop_cancel_confirm))
                .setNegativeButton(getString(R.string.shop_order_closed), null)
                .setPositiveButton(getString(R.string.shop_cancel_order), (d, w) ->
                        ShopApi.cancelOrder(orderId, token, simpleReloadCallback(getString(R.string.shop_cancel_done))))
                .show();
    }

    /**
     * 提交退款申请弹窗（可填写理由）
     * @param order 订单 JSON
     */
    private void showRefundDialog(JSONObject order) {
        String orderId = order.optString("id", "");
        double amount = order.optDouble("totalAmount", 0);
        EditText input = new EditText(this);
        input.setHint(getString(R.string.shop_refund_reason_hint));
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        input.setBackground(roundBg(getColor(R.color.mx_input_stroke), 12));
        input.setPadding(dp(12), dp(10), dp(12), dp(10));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(12), dp(20), 0);
        box.addView(tv(getString(R.string.shop_refund_amount, money(amount)), 12,
                getColor(R.color.mx_on_surface_variant), false));
        box.addView(input);

        new MaterialAlertDialogBuilder(this)
                .setTitle(getString(R.string.shop_refund))
                .setView(box)
                .setNegativeButton(getString(R.string.shop_order_closed), null)
                .setPositiveButton(getString(R.string.shop_refund_submit), (d, w) ->
                        ShopApi.requestRefund(orderId, input.getText().toString(), token,
                                simpleReloadCallback(getString(R.string.shop_refund_submitted))))
                .show();
    }

    /**
     * 管理员审核退款弹窗
     * @param orderId 订单 id
     * @param amount 退款金额
     */
    private void showRefundReviewDialog(String orderId, double amount) {
        new MaterialAlertDialogBuilder(this)
                .setTitle(getString(R.string.shop_refund_review))
                .setMessage(getString(R.string.shop_refund_amount, money(amount)))
                .setNegativeButton(getString(R.string.shop_refund_reject), (d, w) ->
                        ShopApi.adminReviewRefund(orderId, false, "", token,
                                simpleReloadCallback(getString(R.string.shop_status_updated))))
                .setPositiveButton(getString(R.string.shop_refund_approve), (d, w) ->
                        ShopApi.adminReviewRefund(orderId, true, "", token,
                                simpleReloadCallback(getString(R.string.shop_status_updated))))
                .show();
    }

    /**
     * 管理员修改订单状态弹窗
     * @param orderId 订单 id
     * @param current 当前状态，仅用于选中提示
     */
    private void showStatusDialog(String orderId, String current) {
        final String[] keys = {"pending", "confirmed", "delivering", "completed", "cancelled"};
        final String[] labels = {"待确认", "已确认", "待取货", "已完成", "已取消"};
        // 当前状态加「（当前）」后缀，避免误改
        String[] display = new String[labels.length];
        for (int i = 0; i < labels.length; i++) {
            display[i] = labels[i] + (keys[i].equals(current) ? "（当前）" : "");
        }
        new MaterialAlertDialogBuilder(this)
                .setTitle(getString(R.string.shop_change_status))
                .setItems(display, (d, which) -> ShopApi.adminUpdateStatus(orderId, keys[which], token,
                        simpleReloadCallback(getString(R.string.shop_status_updated))))
                .show();
    }

    /**
     * 构造「操作成功后提示 + 刷新订单列表」的通用回调
     * @param successText 成功提示文案
     * @return 接口回调
     */
    private ShopApi.Callback simpleReloadCallback(String successText) {
        return new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null) {
                    return;
                }
                toast(successText);
                showOrders(ordersAll);
            }

            @Override
            public void onFailure(String message) {
                toast(message);
            }
        };
    }

    /**
     * 订单详情弹窗：完整商品明细、备注与退款信息
     * @param order 订单 JSON
     */
    private void showOrderDetail(JSONObject order) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(12), dp(20), dp(8));

        box.addView(tv(getString(R.string.shop_order_no, order.optString("id", "")), 12,
                getColor(R.color.mx_on_surface_variant), false));
        box.addView(tv(formatTime(order.optString("createdAt", "")), 12,
                getColor(R.color.mx_on_surface_variant), false));
        box.addView(tv(getString(R.string.shop_order_items), 14,
                getColor(R.color.mx_on_surface), true));

        JSONArray items = order.optJSONArray("items");
        if (items != null) {
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) {
                    continue;
                }
                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(0, dp(6), 0, dp(6));

                LinearLayout info = new LinearLayout(this);
                info.setOrientation(LinearLayout.VERTICAL);
                LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(
                        0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                info.setLayoutParams(infoLp);
                info.addView(tv(it.optString("productName", ""), 13,
                        getColor(R.color.mx_on_surface), false));
                String detail = it.optBoolean("isCombo", false)
                        ? it.optString("comboText", "") : it.optString("specText", "");
                if (!detail.isEmpty()) {
                    info.addView(tv(detail, 11, getColor(R.color.mx_on_surface_variant), false));
                }
                row.addView(info);

                row.addView(tv(getString(R.string.shop_order_qty, it.optInt("quantity", 0)),
                        12, getColor(R.color.mx_on_surface_variant), false));
                row.addView(tv("  " + getString(R.string.shop_price_prefix) + money(it.optDouble("price", 0)),
                        13, getColor(R.color.mx_on_surface), true));
                box.addView(row);
            }
        }

        String note = order.optString("note", "");
        if (!note.isEmpty()) {
            box.addView(tv(getString(R.string.shop_order_note, note), 12,
                    getColor(R.color.mx_on_surface_variant), false));
        }
        box.addView(tv(getString(R.string.shop_order_total, money(order.optDouble("totalAmount", 0))),
                15, getColor(R.color.mx_primary), true));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);
        new MaterialAlertDialogBuilder(this)
                .setTitle(order.optString("statusText", statusText(order.optString("status", ""))))
                .setView(scroll)
                .setPositiveButton(getString(R.string.shop_order_closed), null)
                .show();
    }

    // ==================== 我的店铺 / 开店 ====================

    /**
     * 店铺列表顶部操作区：「我的店铺」入口，管理员额外显示「管理后台」
     * @param page 店铺列表页容器
     */
    private void addShopListActions(LinearLayout page) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rowLp.bottomMargin = dp(12);
        row.setLayoutParams(rowLp);

        TextView mine = outlineButton(getString(R.string.shop_my_shops));
        mine.setOnClickListener(v -> showMyShops());
        row.addView(mine);

        if (sessionStore != null && sessionStore.isAdmin()) {
            TextView admin = outlineButton(getString(R.string.shop_admin));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = dp(10);
            admin.setLayoutParams(lp);
            admin.setOnClickListener(v -> showAdmin());
            row.addView(admin);
        }
        page.addView(row);
    }

    /**
     * 展示「我的店铺」列表（卖家视角，含休息中/被查封的店铺）
     */
    private void showMyShops() {
        view = VIEW_MY_SHOPS;
        currentShop = null;
        currentShopId = "";
        setTitleText(getString(R.string.shop_my_shops));
        LinearLayout page = createPage();
        page.addView(buildOpenShopButton());
        addEmptyTip(page, getString(R.string.shop_loading));
        loadMyShops();
    }

    /**
     * 构造「开新店铺」按钮
     * @return 主操作按钮
     */
    private TextView buildOpenShopButton() {
        TextView add = primaryButton(getString(R.string.shop_open_shop));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(12);
        add.setLayoutParams(lp);
        add.setOnClickListener(v -> showShopFormDialog(null));
        return add;
    }

    /**
     * 拉取我的店铺与商品数量后渲染列表
     */
    private void loadMyShops() {
        ShopApi.getMyShops(token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                final JSONArray shops = root.optJSONArray("data");
                if (shops == null) {
                    return;
                }
                // 商品列表只用于统计每店商品数量，失败时按 0 展示
                ShopApi.getProducts("", token, new ShopApi.Callback() {
                    @Override
                    public void onSuccess(JSONObject productRoot) {
                        renderMyShops(shops, productRoot.optJSONArray("data"));
                    }

                    @Override
                    public void onFailure(String message) {
                        renderMyShops(shops, null);
                    }
                });
            }

            @Override
            public void onFailure(String message) {
                if (binding == null || view != VIEW_MY_SHOPS) {
                    return;
                }
                LinearLayout fresh = createPage();
                fresh.addView(buildOpenShopButton());
                addEmptyTip(fresh, message);
            }
        });
    }

    /**
     * 渲染我的店铺列表
     * @param shops 店铺数组
     * @param products 商品数组，用于统计商品数量，可为 null
     */
    private void renderMyShops(JSONArray shops, JSONArray products) {
        if (binding == null || view != VIEW_MY_SHOPS) {
            return;
        }
        LinearLayout page = createPage();
        page.addView(buildOpenShopButton());
        if (shops == null || shops.length() == 0) {
            addEmptyTip(page, getString(R.string.shop_no_shops));
            return;
        }
        for (int i = 0; i < shops.length(); i++) {
            JSONObject shop = shops.optJSONObject(i);
            if (shop != null) {
                page.addView(buildMyShopCard(shop, countProducts(products, shop.optString("id", ""))));
            }
        }
    }

    /**
     * 统计某店铺的商品数量
     * @param products 商品数组，可为 null
     * @param shopId 店铺 id
     * @return 商品数量
     */
    private int countProducts(JSONArray products, String shopId) {
        if (products == null || shopId.isEmpty()) {
            return 0;
        }
        int count = 0;
        for (int i = 0; i < products.length(); i++) {
            JSONObject p = products.optJSONObject(i);
            if (p != null && shopId.equals(p.optString("shopId", ""))) {
                count++;
            }
        }
        return count;
    }

    /**
     * 我的店铺卡片：封面 + 店名/分类/商品数 + 可点击的营业状态 + 管理商品按钮
     * @param shop 店铺 JSON
     * @param productCount 商品数量
     * @return 卡片视图
     */
    private View buildMyShopCard(JSONObject shop, int productCount) {
        LinearLayout card = createCard();
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        coverView(row, shop.optString("image"), shop.optString("emoji", "🏬"), 52);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        infoLp.leftMargin = dp(12);
        info.setLayoutParams(infoLp);
        info.addView(tv(shop.optString("name", getString(R.string.shop_title)), 15,
                getColor(R.color.mx_on_surface), true));
        String category = shop.optString("category", "综合");
        info.addView(tv(category + " · " + getString(R.string.shop_products_count, productCount),
                12, getColor(R.color.mx_on_surface_variant), false));
        row.addView(info);

        // 状态标签：未查封时点击可切换营业/休息
        final boolean seized = shop.optBoolean("seized", false);
        final boolean open = shop.optBoolean("isOpen", true);
        final String shopId = shop.optString("id", "");
        TextView badge = statusBadgeView(shop);
        if (!seized) {
            badge.setOnClickListener(v -> updateShopOpen(shopId, !open));
        }
        row.addView(badge);
        card.addView(row);

        TextView manage = primaryButton(getString(R.string.shop_manage_products));
        manage.setPadding(dp(14), dp(8), dp(14), dp(8));
        LinearLayout.LayoutParams manageLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        manageLp.topMargin = dp(10);
        manage.setLayoutParams(manageLp);
        manage.setOnClickListener(v -> {
            manageFromAdmin = false;
            showManage(shopId);
        });
        card.addView(manage);
        return card;
    }

    /**
     * 构造店铺状态标签（查封 > 休息中 > 营业中）
     * @param shop 店铺 JSON
     * @return 状态标签视图
     */
    private TextView statusBadgeView(JSONObject shop) {
        boolean seized = shop.optBoolean("seized", false);
        boolean open = shop.optBoolean("isOpen", true);
        String text = seized ? getString(R.string.shop_status_seized)
                : (open ? getString(R.string.shop_status_open) : getString(R.string.shop_status_closed));
        TextView badge = tv(text, 11, (seized || !open)
                ? getColor(R.color.mx_on_surface_variant)
                : getColor(R.color.mx_on_primary), false);
        badge.setBackground(roundBg((seized || !open)
                ? getColor(R.color.mx_input_stroke) : getColor(R.color.mx_primary), 10));
        badge.setPadding(dp(8), dp(3), dp(8), dp(3));
        return badge;
    }

    /**
     * 切换店铺营业状态
     * @param shopId 店铺 id
     * @param nextOpen 目标状态：true=营业，false=休息
     */
    private void updateShopOpen(String shopId, boolean nextOpen) {
        JSONObject body = new JSONObject();
        try {
            body.put("isOpen", nextOpen);
        } catch (Exception ignored) {
            // 布尔写入不会抛异常
        }
        ShopApi.updateShop(shopId, body, token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null) {
                    return;
                }
                toast(getString(nextOpen ? R.string.shop_shop_open : R.string.shop_shop_rest));
                loadMyShops();
            }

            @Override
            public void onFailure(String message) {
                toast(message);
            }
        });
    }

    // ==================== 店铺管理（卖家） ====================

    /**
     * 打开某个店铺的管理页（店铺信息 + 商品列表）
     * @param shopId 店铺 id
     */
    private void showManage(String shopId) {
        view = VIEW_MANAGE;
        currentShopId = shopId == null ? "" : shopId;
        currentShop = null;
        setTitleText(getString(R.string.shop_shop_manage));
        LinearLayout page = createPage();
        addEmptyTip(page, getString(R.string.shop_loading));

        ShopApi.getShop(currentShopId, token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null || view != VIEW_MANAGE) {
                    return;
                }
                currentShop = root.optJSONObject("data");
                loadManageProducts();
            }

            @Override
            public void onFailure(String message) {
                if (binding == null || view != VIEW_MANAGE) {
                    return;
                }
                LinearLayout fresh = createPage();
                addEmptyTip(fresh, message);
            }
        });
    }

    /**
     * 拉取当前店铺的商品（店主/管理员可见下架商品）
     */
    private void loadManageProducts() {
        ShopApi.getProducts(currentShopId, token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null || view != VIEW_MANAGE) {
                    return;
                }
                renderManage(root.optJSONArray("data"));
            }

            @Override
            public void onFailure(String message) {
                if (binding == null || view != VIEW_MANAGE) {
                    return;
                }
                LinearLayout fresh = createPage();
                addEmptyTip(fresh, message);
            }
        });
    }

    /**
     * 渲染店铺管理页：信息条 + 操作按钮 + 商品列表
     * @param products 商品数组，可为 null
     */
    private void renderManage(JSONArray products) {
        if (binding == null || view != VIEW_MANAGE || currentShop == null) {
            return;
        }
        int count = products == null ? 0 : products.length();
        LinearLayout page = createPage();
        page.addView(buildManageHead(count));
        if (count == 0) {
            addEmptyTip(page, getString(R.string.shop_product_empty_manage));
            return;
        }
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product != null) {
                page.addView(buildManageProductCard(product));
            }
        }
    }

    /**
     * 店铺信息条 + 编辑/删除/新增商品操作
     * @param productCount 商品数量
     * @return 卡片视图
     */
    private View buildManageHead(int productCount) {
        LinearLayout card = createCard();
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        coverView(row, currentShop.optString("image"), currentShop.optString("emoji", "🏬"), 52);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        infoLp.leftMargin = dp(12);
        info.setLayoutParams(infoLp);
        info.addView(tv(currentShop.optString("name", getString(R.string.shop_title)), 16,
                getColor(R.color.mx_on_surface), true));
        info.addView(tv(currentShop.optString("category", "综合") + " · "
                + getString(R.string.shop_products_count, productCount), 12,
                getColor(R.color.mx_on_surface_variant), false));
        row.addView(info);
        row.addView(statusBadgeView(currentShop));
        card.addView(row);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams actionsLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        actionsLp.topMargin = dp(12);
        actions.setLayoutParams(actionsLp);

        TextView edit = outlineButton(getString(R.string.shop_edit_shop));
        edit.setOnClickListener(v -> showShopFormDialog(currentShop));
        actions.addView(edit);

        TextView delete = dangerButton(getString(R.string.shop_delete_shop));
        LinearLayout.LayoutParams delLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        delLp.leftMargin = dp(8);
        delete.setLayoutParams(delLp);
        delete.setOnClickListener(v -> confirmDeleteShop());
        actions.addView(delete);

        TextView add = primaryButton(getString(R.string.shop_new_product));
        LinearLayout.LayoutParams addLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        addLp.leftMargin = dp(8);
        add.setLayoutParams(addLp);
        add.setOnClickListener(v -> showProductEditor(""));
        actions.addView(add);
        card.addView(actions);
        return card;
    }

    /**
     * 删除店铺（连带删除商品），成功后返回我的店铺列表
     */
    private void confirmDeleteShop() {
        new MaterialAlertDialogBuilder(this)
                .setMessage(getString(R.string.shop_delete_shop_confirm))
                .setNegativeButton(getString(R.string.action_cancel), null)
                .setPositiveButton(getString(R.string.shop_delete_shop), (d, w) ->
                        ShopApi.deleteShop(currentShopId, token, new ShopApi.Callback() {
                            @Override
                            public void onSuccess(JSONObject root) {
                                if (binding == null) {
                                    return;
                                }
                                toast(getString(R.string.shop_shop_deleted));
                                showMyShops();
                            }

                            @Override
                            public void onFailure(String message) {
                                toast(message);
                            }
                        }))
                .show();
    }

    /**
     * 商品管理卡片：封面 + 名称/分类/价格/销量 + 编辑/上下架/删除
     * @param product 商品 JSON
     * @return 卡片视图
     */
    private View buildManageProductCard(JSONObject product) {
        LinearLayout card = createCard();
        final String productId = product.optString("id", "");
        final boolean available = product.optBoolean("isAvailable", true);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        coverView(row, product.optString("image"), product.optString("emoji", "🛒"), 44);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        infoLp.leftMargin = dp(12);
        info.setLayoutParams(infoLp);
        info.addView(tv(product.optString("name", ""), 14,
                getColor(R.color.mx_on_surface), true));
        String category = product.optString("category", "其他");
        String meta = category + " · " + getString(R.string.shop_price_prefix)
                + money(product.optDouble("price", 0)) + " · "
                + getString(R.string.shop_sold, product.optInt("sales", 0));
        info.addView(tv(meta, 11, getColor(R.color.mx_on_surface_variant), false));
        row.addView(info);

        row.addView(tv(available ? getString(R.string.shop_product_on_sale)
                        : getString(R.string.shop_product_off_sale), 11,
                getColor(available ? R.color.mx_primary : R.color.mx_error), false));
        card.addView(row);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams actionsLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        actionsLp.topMargin = dp(10);
        actions.setLayoutParams(actionsLp);

        TextView edit = outlineButton(getString(R.string.shop_edit_product));
        edit.setOnClickListener(v -> showProductEditor(productId));
        actions.addView(edit);

        TextView toggle = outlineButton(getString(available
                ? R.string.shop_product_offline : R.string.shop_product_online));
        LinearLayout.LayoutParams toggleLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        toggleLp.leftMargin = dp(8);
        toggle.setLayoutParams(toggleLp);
        toggle.setOnClickListener(v -> toggleProductAvailable(productId, !available));
        actions.addView(toggle);

        TextView delete = dangerButton(getString(R.string.shop_delete));
        LinearLayout.LayoutParams delLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        delLp.leftMargin = dp(8);
        delete.setLayoutParams(delLp);
        delete.setOnClickListener(v -> confirmDeleteProduct(productId));
        actions.addView(delete);
        card.addView(actions);
        return card;
    }

    /**
     * 上架 / 下架商品
     * @param productId 商品 id
     * @param nextAvailable true=上架，false=下架
     */
    private void toggleProductAvailable(String productId, boolean nextAvailable) {
        JSONObject body = new JSONObject();
        try {
            body.put("isAvailable", nextAvailable);
        } catch (Exception ignored) {
            // 布尔写入不会抛异常
        }
        ShopApi.updateProduct(productId, body, token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null) {
                    return;
                }
                toast(getString(nextAvailable
                        ? R.string.shop_product_on_sale : R.string.shop_product_off_sale));
                loadManageProducts();
            }

            @Override
            public void onFailure(String message) {
                toast(message);
            }
        });
    }

    /**
     * 删除商品（同时从所有购物车移除）
     * @param productId 商品 id
     */
    private void confirmDeleteProduct(String productId) {
        new MaterialAlertDialogBuilder(this)
                .setMessage(getString(R.string.shop_delete_product_confirm))
                .setNegativeButton(getString(R.string.action_cancel), null)
                .setPositiveButton(getString(R.string.shop_delete_product), (d, w) ->
                        ShopApi.deleteProduct(productId, token, new ShopApi.Callback() {
                            @Override
                            public void onSuccess(JSONObject root) {
                                if (binding == null) {
                                    return;
                                }
                                toast(getString(R.string.shop_product_deleted));
                                loadManageProducts();
                            }

                            @Override
                            public void onFailure(String message) {
                                toast(message);
                            }
                        }))
                .show();
    }

    // ==================== 店铺表单 ====================

    /**
     * 新增/编辑店铺表单弹窗
     * @param shop 编辑时传入原店铺；新增时传 null
     */
    private void showShopFormDialog(JSONObject shop) {
        final boolean isNew = shop == null;
        final JSONObject data = shop == null ? new JSONObject() : shop;

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(4), dp(20), 0);

        final EditText nameInput = input(data.optString("name", ""), InputType.TYPE_CLASS_TEXT);
        final EditText descInput = input(data.optString("description", ""), InputType.TYPE_CLASS_TEXT);
        descInput.setHint(getString(R.string.shop_desc_hint));
        final EditText categoryInput = input(data.optString("category", ""), InputType.TYPE_CLASS_TEXT);
        categoryInput.setHint(getString(R.string.shop_category_hint));
        final EditText emojiInput = input(data.optString("emoji", "🏬"), InputType.TYPE_CLASS_TEXT);
        emojiInput.setHint(getString(R.string.shop_emoji_hint));
        final EditText imageInput = input(data.optString("image", ""), InputType.TYPE_CLASS_TEXT);
        imageInput.setHint(getString(R.string.shop_image_hint));

        addField(box, R.string.shop_name_label, nameInput);
        addField(box, R.string.shop_desc_label, descInput);
        addField(box, R.string.shop_category_label, categoryInput);
        addField(box, R.string.shop_emoji_label, emojiInput);
        addImageField(box, R.string.shop_image_label, imageInput);

        final CheckBox openBox = new CheckBox(this);
        openBox.setText(getString(R.string.shop_open_state));
        openBox.setTextColor(getColor(R.color.mx_on_surface));
        openBox.setChecked(data.optBoolean("isOpen", true));
        openBox.setPadding(0, dp(8), 0, 0);
        box.addView(openBox);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);

        final AlertDialog dialog = new MaterialAlertDialogBuilder(this)
                .setTitle(isNew ? getString(R.string.shop_new_shop) : getString(R.string.shop_edit_shop))
                .setView(scroll)
                .setNegativeButton(getString(R.string.action_cancel), null)
                .setPositiveButton(getString(R.string.shop_save), null)
                .create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(v -> {
                    String name = nameInput.getText().toString().trim();
                    if (name.isEmpty()) {
                        toast(getString(R.string.shop_name_required));
                        return;
                    }
                    JSONObject body = new JSONObject();
                    try {
                        body.put("name", name);
                        body.put("description", descInput.getText().toString().trim());
                        body.put("category", categoryInput.getText().toString().trim());
                        body.put("emoji", emojiInput.getText().toString().trim());
                        body.put("image", imageInput.getText().toString().trim());
                        body.put("isOpen", openBox.isChecked());
                    } catch (Exception e) {
                        toast(getString(R.string.shop_action_failed));
                        return;
                    }
                    ShopApi.Callback cb = new ShopApi.Callback() {
                        @Override
                        public void onSuccess(JSONObject root) {
                            if (binding == null) {
                                return;
                            }
                            toast(getString(R.string.shop_shop_saved));
                            dialog.dismiss();
                            if (view == VIEW_MANAGE) {
                                showManage(currentShopId);
                            } else {
                                showMyShops();
                            }
                        }

                        @Override
                        public void onFailure(String message) {
                            toast(message);
                        }
                    };
                    if (isNew) {
                        ShopApi.createShop(body, token, cb);
                    } else {
                        ShopApi.updateShop(data.optString("id", ""), body, token, cb);
                    }
                }));
        dialog.show();
    }

    // ==================== 商品编辑 ====================

    /**
     * 打开商品编辑页（新增或编辑）
     * @param productId 商品 id，空串表示新增
     */
    private void showProductEditor(String productId) {
        view = VIEW_PRODUCT_EDIT;
        editingProductId = productId == null ? "" : productId;
        setTitleText(editingProductId.isEmpty()
                ? getString(R.string.shop_new_product) : getString(R.string.shop_edit_product));

        if (editingProductId.isEmpty()) {
            buildProductForm(null);
            return;
        }
        LinearLayout page = createPage();
        addEmptyTip(page, getString(R.string.shop_loading));
        // 服务端没有单条商品查询接口，取当前店铺列表后按 id 匹配
        ShopApi.getProducts(currentShopId, token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                JSONArray products = root.optJSONArray("data");
                JSONObject target = null;
                if (products != null) {
                    for (int i = 0; i < products.length(); i++) {
                        JSONObject p = products.optJSONObject(i);
                        if (p != null && editingProductId.equals(p.optString("id", ""))) {
                            target = p;
                            break;
                        }
                    }
                }
                if (target == null) {
                    if (binding != null) {
                        toast(getString(R.string.shop_action_failed));
                        showManage(currentShopId);
                    }
                    return;
                }
                buildProductForm(target);
            }

            @Override
            public void onFailure(String message) {
                if (binding == null || view != VIEW_PRODUCT_EDIT) {
                    return;
                }
                LinearLayout fresh = createPage();
                addEmptyTip(fresh, message);
            }
        });
    }

    /**
     * 构建商品表单
     * @param product 原商品，新增时为 null
     */
    private void buildProductForm(JSONObject product) {
        if (binding == null || view != VIEW_PRODUCT_EDIT) {
            return;
        }
        final boolean isCombo = product != null && product.optBoolean("isCombo", false);
        final List<SpecGroup> specGroups = new ArrayList<>();
        final List<ComboGroup> comboGroups = new ArrayList<>();
        parseSpecs(product, specGroups);
        parseComboGroups(product, comboGroups);

        LinearLayout page = createPage();
        LinearLayout card = createCard();
        page.addView(card);

        final EditText nameInput = input(product == null ? "" : product.optString("name", ""),
                InputType.TYPE_CLASS_TEXT);
        final EditText descInput = input(product == null ? "" : product.optString("description", ""),
                InputType.TYPE_CLASS_TEXT);
        final EditText priceInput = input(product == null ? "" : String.valueOf(product.optDouble("price", 0)),
                InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        final EditText categoryInput = input(product == null ? "" : product.optString("category", ""),
                InputType.TYPE_CLASS_TEXT);
        final EditText emojiInput = input(product == null ? "🛒" : product.optString("emoji", "🛒"),
                InputType.TYPE_CLASS_TEXT);
        final EditText imageInput = input(product == null ? "" : product.optString("image", ""),
                InputType.TYPE_CLASS_TEXT);
        imageInput.setHint(getString(R.string.shop_image_hint));

        addField(card, R.string.shop_product_name_label, nameInput);
        addField(card, R.string.shop_product_desc_label, descInput);
        final TextView priceLabel = addField(card, isCombo
                ? R.string.shop_product_price_combo_label : R.string.shop_product_price_label, priceInput);
        addField(card, R.string.shop_product_category_label, categoryInput);
        addField(card, R.string.shop_product_emoji_label, emojiInput);
        addImageField(card, R.string.shop_product_image_label, imageInput);

        final CheckBox availableBox = new CheckBox(this);
        availableBox.setText(getString(R.string.shop_product_available));
        availableBox.setTextColor(getColor(R.color.mx_on_surface));
        availableBox.setChecked(product == null || product.optBoolean("isAvailable", true));
        availableBox.setPadding(0, dp(8), 0, 0);
        card.addView(availableBox);
        card.addView(tv(getString(R.string.shop_product_available_desc), 11,
                getColor(R.color.mx_on_surface_variant), false));

        final CheckBox comboBox = new CheckBox(this);
        comboBox.setText(getString(R.string.shop_product_combo));
        comboBox.setTextColor(getColor(R.color.mx_on_surface));
        comboBox.setChecked(isCombo);
        comboBox.setPadding(0, dp(8), 0, 0);
        card.addView(comboBox);
        card.addView(tv(getString(R.string.shop_product_combo_desc), 11,
                getColor(R.color.mx_on_surface_variant), false));

        // 规格区（普通商品）
        final LinearLayout specsWrap = new LinearLayout(this);
        specsWrap.setOrientation(LinearLayout.VERTICAL);
        specsWrap.addView(fieldLabel(getString(R.string.shop_specs_label)));
        final LinearLayout specHost = new LinearLayout(this);
        specHost.setOrientation(LinearLayout.VERTICAL);
        specsWrap.addView(specHost);
        TextView addSpec = outlineButton(getString(R.string.shop_specs_add));
        addSpec.setOnClickListener(v -> {
            SpecGroup group = new SpecGroup();
            group.options.add(new OptionItem());
            specGroups.add(group);
            renderSpecRows(specHost, specGroups);
        });
        specsWrap.addView(addSpec, topMarginLp(8));
        card.addView(specsWrap);

        // 套餐区（套餐商品）
        final LinearLayout comboWrap = new LinearLayout(this);
        comboWrap.setOrientation(LinearLayout.VERTICAL);
        comboWrap.addView(fieldLabel(getString(R.string.shop_combo_groups_label)));
        final LinearLayout comboHost = new LinearLayout(this);
        comboHost.setOrientation(LinearLayout.VERTICAL);
        comboWrap.addView(comboHost);
        TextView addCombo = outlineButton(getString(R.string.shop_combo_add));
        addCombo.setOnClickListener(v -> {
            ComboGroup group = new ComboGroup();
            group.options.add(new OptionItem());
            comboGroups.add(group);
            renderComboRows(comboHost, comboGroups);
        });
        comboWrap.addView(addCombo, topMarginLp(8));
        card.addView(comboWrap);

        // 规格 / 套餐互斥：勾选套餐后隐藏规格区，价格标签同步切换
        specsWrap.setVisibility(isCombo ? View.GONE : View.VISIBLE);
        comboWrap.setVisibility(isCombo ? View.VISIBLE : View.GONE);
        comboBox.setOnCheckedChangeListener((buttonView, checked) -> {
            specsWrap.setVisibility(checked ? View.GONE : View.VISIBLE);
            comboWrap.setVisibility(checked ? View.VISIBLE : View.GONE);
            priceLabel.setText(getString(checked
                    ? R.string.shop_product_price_combo_label : R.string.shop_product_price_label));
        });

        renderSpecRows(specHost, specGroups);
        renderComboRows(comboHost, comboGroups);

        // 底部：保存 / 取消
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        page.addView(actions, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView save = primaryButton(getString(R.string.shop_save));
        LinearLayout.LayoutParams saveLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        save.setLayoutParams(saveLp);
        save.setOnClickListener(v -> saveProductForm(comboBox, nameInput, descInput, priceInput,
                categoryInput, emojiInput, imageInput, availableBox, specGroups, comboGroups));
        actions.addView(save);

        TextView cancel = outlineButton(getString(R.string.action_cancel));
        LinearLayout.LayoutParams cancelLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cancelLp.leftMargin = dp(10);
        cancel.setLayoutParams(cancelLp);
        cancel.setOnClickListener(v -> showManage(currentShopId));
        actions.addView(cancel);
    }

    /**
     * 校验并保存商品表单
     * @param comboBox 套餐开关
     * @param nameInput 商品名称输入框
     * @param descInput 描述输入框
     * @param priceInput 价格输入框
     * @param categoryInput 分类输入框
     * @param emojiInput Emoji 输入框
     * @param imageInput 图片地址输入框
     * @param availableBox 在售开关
     * @param specGroups 规格组模型
     * @param comboGroups 套餐分组模型
     */
    private void saveProductForm(CheckBox comboBox, EditText nameInput, EditText descInput,
                                 EditText priceInput, EditText categoryInput, EditText emojiInput,
                                 EditText imageInput, CheckBox availableBox,
                                 List<SpecGroup> specGroups, List<ComboGroup> comboGroups) {
        String name = nameInput.getText().toString().trim();
        if (name.isEmpty()) {
            toast(getString(R.string.shop_product_name_required));
            return;
        }
        double price;
        try {
            price = Double.parseDouble(priceInput.getText().toString().trim());
        } catch (Exception e) {
            toast(getString(R.string.shop_price_invalid));
            return;
        }
        if (price < 0) {
            toast(getString(R.string.shop_price_invalid));
            return;
        }

        boolean comboMode = comboBox.isChecked();
        JSONObject body = new JSONObject();
        try {
            body.put("shopId", currentShopId);
            body.put("name", name);
            body.put("description", descInput.getText().toString().trim());
            body.put("price", price);
            body.put("category", categoryInput.getText().toString().trim());
            body.put("emoji", emojiInput.getText().toString().trim());
            body.put("image", imageInput.getText().toString().trim());
            body.put("isAvailable", availableBox.isChecked());
            body.put("isCombo", comboMode);
            if (comboMode) {
                body.put("comboGroups", buildComboJson(comboGroups));
                body.put("specs", JSONObject.NULL);
            } else {
                JSONArray specs = buildSpecsJson(specGroups);
                body.put("specs", specs.length() == 0 ? JSONObject.NULL : specs);
                body.put("comboGroups", JSONObject.NULL);
            }
        } catch (IllegalArgumentException e) {
            // 业务校验失败：直接展示具体原因
            toast(e.getMessage());
            return;
        } catch (Exception e) {
            toast(getString(R.string.shop_action_failed));
            return;
        }

        ShopApi.Callback cb = new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                if (binding == null) {
                    return;
                }
                toast(getString(R.string.shop_product_saved));
                showManage(currentShopId);
            }

            @Override
            public void onFailure(String message) {
                toast(message);
            }
        };
        if (editingProductId.isEmpty()) {
            ShopApi.createProduct(body, token, cb);
        } else {
            ShopApi.updateProduct(editingProductId, body, token, cb);
        }
    }

    /**
     * 把规格模型转成接口需要的 JSON 数组，同时做必填校验
     * @param groups 规格组模型
     * @return JSON 数组；无有效规格组时为空数组
     * @throws IllegalArgumentException 组名或选项为空时抛出中文提示
     */
    private JSONArray buildSpecsJson(List<SpecGroup> groups) throws Exception {
        JSONArray result = new JSONArray();
        for (SpecGroup group : groups) {
            String groupName = group.name.trim();
            if (groupName.isEmpty()) {
                throw new IllegalArgumentException(getString(R.string.shop_spec_name_required));
            }
            JSONArray options = new JSONArray();
            for (OptionItem option : group.options) {
                String label = option.label.trim();
                if (!label.isEmpty()) {
                    JSONObject opt = new JSONObject();
                    opt.put("label", label);
                    opt.put("priceDelta", option.delta);
                    options.put(opt);
                }
            }
            if (options.length() == 0) {
                throw new IllegalArgumentException(
                        getString(R.string.shop_spec_need_option, groupName));
            }
            JSONObject item = new JSONObject();
            item.put("name", groupName);
            item.put("required", group.required);
            item.put("options", options);
            result.put(item);
        }
        return result;
    }

    /**
     * 把套餐模型转成接口需要的 JSON 数组，同时做必填校验
     * @param groups 套餐分组模型
     * @return JSON 数组
     * @throws IllegalArgumentException 分组缺失或组名/选项为空时抛出中文提示
     */
    private JSONArray buildComboJson(List<ComboGroup> groups) throws Exception {
        if (groups.isEmpty()) {
            throw new IllegalArgumentException(getString(R.string.shop_combo_need_group));
        }
        JSONArray result = new JSONArray();
        for (ComboGroup group : groups) {
            String groupName = group.name.trim();
            if (groupName.isEmpty()) {
                throw new IllegalArgumentException(getString(R.string.shop_combo_name_required));
            }
            JSONArray options = new JSONArray();
            for (OptionItem option : group.options) {
                String label = option.label.trim();
                if (!label.isEmpty()) {
                    JSONObject opt = new JSONObject();
                    opt.put("label", label);
                    opt.put("priceDelta", option.delta);
                    options.put(opt);
                }
            }
            if (options.length() == 0) {
                throw new IllegalArgumentException(
                        getString(R.string.shop_spec_need_option, groupName));
            }
            JSONObject item = new JSONObject();
            item.put("name", groupName);
            item.put("count", group.count);
            item.put("options", options);
            result.put(item);
        }
        return result;
    }

    /**
     * 解析商品原有规格到模型
     * @param product 商品 JSON，可为 null
     * @param out 输出列表
     */
    private void parseSpecs(JSONObject product, List<SpecGroup> out) {
        if (product == null) {
            return;
        }
        JSONArray arr = product.optJSONArray("specs");
        if (arr == null) {
            return;
        }
        for (int i = 0; i < arr.length(); i++) {
            JSONObject item = arr.optJSONObject(i);
            if (item == null) {
                continue;
            }
            SpecGroup group = new SpecGroup();
            group.name = item.optString("name", "");
            group.required = item.optBoolean("required", true);
            group.options.addAll(parseOptions(item.optJSONArray("options")));
            if (!group.options.isEmpty()) {
                out.add(group);
            }
        }
    }

    /**
     * 解析商品原有套餐分组到模型
     * @param product 商品 JSON，可为 null
     * @param out 输出列表
     */
    private void parseComboGroups(JSONObject product, List<ComboGroup> out) {
        if (product == null) {
            return;
        }
        JSONArray arr = product.optJSONArray("comboGroups");
        if (arr == null) {
            return;
        }
        for (int i = 0; i < arr.length(); i++) {
            JSONObject item = arr.optJSONObject(i);
            if (item == null) {
                continue;
            }
            ComboGroup group = new ComboGroup();
            group.name = item.optString("name", "");
            group.count = item.optInt("count", 1);
            group.options.addAll(parseOptions(item.optJSONArray("options")));
            if (!group.options.isEmpty()) {
                out.add(group);
            }
        }
    }

    /**
     * 解析规格/套餐共用的选项数组
     * @param arr 选项 JSON 数组
     * @return 选项模型列表
     */
    private List<OptionItem> parseOptions(JSONArray arr) {
        List<OptionItem> list = new ArrayList<>();
        if (arr == null) {
            return list;
        }
        for (int i = 0; i < arr.length(); i++) {
            JSONObject item = arr.optJSONObject(i);
            if (item == null) {
                continue;
            }
            OptionItem option = new OptionItem();
            option.label = item.optString("label", "");
            option.delta = item.optDouble("priceDelta", 0);
            list.add(option);
        }
        return list;
    }

    /**
     * 重新渲染规格组列表（新增/删除/移动后整块重建，数据保存在模型里不会丢失）
     * @param host 规格组容器
     * @param groups 规格组模型
     */
    private void renderSpecRows(LinearLayout host, List<SpecGroup> groups) {
        host.removeAllViews();
        for (int i = 0; i < groups.size(); i++) {
            final int index = i;
            final SpecGroup group = groups.get(i);
            LinearLayout card = innerCard();

            LinearLayout head = new LinearLayout(this);
            head.setOrientation(LinearLayout.HORIZONTAL);
            head.setGravity(Gravity.CENTER_VERTICAL);

            EditText nameInput = input(group.name, InputType.TYPE_CLASS_TEXT);
            nameInput.setHint(getString(R.string.shop_spec_group_name_hint));
            LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            nameInput.setLayoutParams(nameLp);
            watch(nameInput, text -> group.name = text);
            head.addView(nameInput);

            CheckBox requiredBox = new CheckBox(this);
            requiredBox.setText(getString(R.string.shop_group_required));
            requiredBox.setTextColor(getColor(R.color.mx_on_surface));
            requiredBox.setChecked(group.required);
            requiredBox.setOnCheckedChangeListener((b, checked) -> group.required = checked);
            head.addView(requiredBox);
            card.addView(head);

            card.addView(buildRowControls(index, groups.size(),
                    () -> {
                        java.util.Collections.swap(groups, index, index - 1);
                        renderSpecRows(host, groups);
                    },
                    () -> {
                        java.util.Collections.swap(groups, index, index + 1);
                        renderSpecRows(host, groups);
                    },
                    () -> {
                        groups.remove(index);
                        renderSpecRows(host, groups);
                    }));

            for (OptionItem option : group.options) {
                card.addView(buildOptionRow(option, group.options,
                        () -> renderSpecRows(host, groups)));
            }

            TextView addOption = outlineButton(getString(R.string.shop_spec_add_option));
            addOption.setOnClickListener(v -> {
                group.options.add(new OptionItem());
                renderSpecRows(host, groups);
            });
            card.addView(addOption, topMarginLp(6));
            host.addView(card);
        }
    }

    /**
     * 重新渲染套餐分组列表
     * @param host 套餐分组容器
     * @param groups 套餐分组模型
     */
    private void renderComboRows(LinearLayout host, List<ComboGroup> groups) {
        host.removeAllViews();
        for (int i = 0; i < groups.size(); i++) {
            final int index = i;
            final ComboGroup group = groups.get(i);
            LinearLayout card = innerCard();

            LinearLayout head = new LinearLayout(this);
            head.setOrientation(LinearLayout.HORIZONTAL);
            head.setGravity(Gravity.CENTER_VERTICAL);

            EditText nameInput = input(group.name, InputType.TYPE_CLASS_TEXT);
            nameInput.setHint(getString(R.string.shop_combo_group_name_hint));
            nameInput.setLayoutParams(new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            watch(nameInput, text -> group.name = text);
            head.addView(nameInput);

            TextView countLabel = tv(getString(R.string.shop_combo_count_label), 12,
                    getColor(R.color.mx_on_surface_variant), false);
            countLabel.setPadding(dp(8), 0, dp(4), 0);
            head.addView(countLabel);

            EditText countInput = input(String.valueOf(group.count),
                    InputType.TYPE_CLASS_NUMBER);
            countInput.setLayoutParams(new LinearLayout.LayoutParams(dp(56),
                    ViewGroup.LayoutParams.WRAP_CONTENT));
            watch(countInput, text -> {
                try {
                    int value = Integer.parseInt(text.trim());
                    group.count = Math.max(0, Math.min(20, value));
                } catch (Exception ignored) {
                    // 输入过程中允许为空，保存时按原值处理
                }
            });
            head.addView(countInput);
            card.addView(head);

            card.addView(buildRowControls(index, groups.size(),
                    () -> {
                        java.util.Collections.swap(groups, index, index - 1);
                        renderComboRows(host, groups);
                    },
                    () -> {
                        java.util.Collections.swap(groups, index, index + 1);
                        renderComboRows(host, groups);
                    },
                    () -> {
                        groups.remove(index);
                        renderComboRows(host, groups);
                    }));

            for (OptionItem option : group.options) {
                card.addView(buildOptionRow(option, group.options,
                        () -> renderComboRows(host, groups)));
            }

            TextView addOption = outlineButton(getString(R.string.shop_spec_add_option));
            addOption.setOnClickListener(v -> {
                group.options.add(new OptionItem());
                renderComboRows(host, groups);
            });
            card.addView(addOption, topMarginLp(6));
            host.addView(card);
        }
    }

    /**
     * 构造规格/套餐组的「上移 / 下移 / 删除」操作行
     * @param index 当前组下标
     * @param total 组总数
     * @param onUp 上移回调
     * @param onDown 下移回调
     * @param onDelete 删除回调
     * @return 操作行视图
     */
    private View buildRowControls(int index, int total, Runnable onUp, Runnable onDown, Runnable onDelete) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        row.setLayoutParams(lp);

        TextView up = smallAction(getString(R.string.shop_move_up));
        up.setEnabled(index > 0);
        up.setAlpha(index > 0 ? 1f : 0.4f);
        up.setOnClickListener(v -> onUp.run());
        row.addView(up);

        TextView down = smallAction(getString(R.string.shop_move_down));
        down.setEnabled(index < total - 1);
        down.setAlpha(index < total - 1 ? 1f : 0.4f);
        down.setOnClickListener(v -> onDown.run());
        LinearLayout.LayoutParams downLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        downLp.leftMargin = dp(12);
        down.setLayoutParams(downLp);
        row.addView(down);

        TextView delete = smallAction(getString(R.string.shop_delete));
        delete.setTextColor(getColor(R.color.mx_error));
        delete.setOnClickListener(v -> onDelete.run());
        LinearLayout.LayoutParams delLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        delLp.leftMargin = dp(12);
        delete.setLayoutParams(delLp);
        row.addView(delete);
        return row;
    }

    /**
     * 构造单个选项行：名称 + 加价 + 删除
     * @param option 选项模型
     * @param options 所属选项列表（删除时判断是否只剩一项）
     * @param onChanged 结构变化后的重绘回调
     * @return 选项行视图
     */
    private View buildOptionRow(OptionItem option, List<OptionItem> options, Runnable onChanged) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        row.setLayoutParams(lp);

        EditText labelInput = input(option.label, InputType.TYPE_CLASS_TEXT);
        labelInput.setHint(getString(R.string.shop_spec_option_hint));
        labelInput.setLayoutParams(new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        watch(labelInput, text -> option.label = text);
        row.addView(labelInput);

        EditText deltaInput = input(option.delta == 0 ? "" : String.valueOf(option.delta),
                InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL
                        | InputType.TYPE_NUMBER_FLAG_SIGNED);
        deltaInput.setHint(getString(R.string.shop_spec_option_delta));
        LinearLayout.LayoutParams deltaLp = new LinearLayout.LayoutParams(
                dp(72), ViewGroup.LayoutParams.WRAP_CONTENT);
        deltaLp.leftMargin = dp(8);
        deltaInput.setLayoutParams(deltaLp);
        watch(deltaInput, text -> {
            try {
                option.delta = Double.parseDouble(text.trim());
            } catch (Exception ignored) {
                // 输入过程中允许为空，保存时按 0 处理
            }
        });
        row.addView(deltaInput);

        TextView delete = smallAction("✕");
        delete.setTextColor(getColor(R.color.mx_error));
        LinearLayout.LayoutParams delLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        delLp.leftMargin = dp(8);
        delete.setLayoutParams(delLp);
        delete.setOnClickListener(v -> {
            if (options.size() <= 1) {
                toast(getString(R.string.shop_keep_one_option));
                return;
            }
            options.remove(option);
            onChanged.run();
        });
        row.addView(delete);
        return row;
    }

    // ==================== 管理后台 ====================

    /**
     * 管理后台：经营统计 + 全部店铺（查封/解封）+ 全部订单入口
     */
    private void showAdmin() {
        if (sessionStore == null || !sessionStore.isAdmin()) {
            toast(getString(R.string.shop_admin_only));
            return;
        }
        view = VIEW_ADMIN;
        currentShop = null;
        setTitleText(getString(R.string.shop_admin));
        LinearLayout page = createPage();
        addEmptyTip(page, getString(R.string.shop_loading));

        ShopApi.getStats(token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject statRoot) {
                final JSONObject stats = statRoot.optJSONObject("data");
                ShopApi.getShops(token, new ShopApi.Callback() {
                    @Override
                    public void onSuccess(JSONObject shopRoot) {
                        renderAdmin(stats, shopRoot.optJSONArray("data"));
                    }

                    @Override
                    public void onFailure(String message) {
                        if (binding == null || view != VIEW_ADMIN) {
                            return;
                        }
                        LinearLayout fresh = createPage();
                        addEmptyTip(fresh, message);
                    }
                });
            }

            @Override
            public void onFailure(String message) {
                if (binding == null || view != VIEW_ADMIN) {
                    return;
                }
                LinearLayout fresh = createPage();
                addEmptyTip(fresh, message);
            }
        });
    }

    /**
     * 渲染管理后台内容
     * @param stats 统计对象，可为 null
     * @param shops 全部店铺数组，可为 null
     */
    private void renderAdmin(JSONObject stats, JSONArray shops) {
        if (binding == null || view != VIEW_ADMIN) {
            return;
        }
        LinearLayout page = createPage();

        LinearLayout statsCard = createCard();
        statsCard.addView(tv(getString(R.string.shop_admin_stats), 15,
                getColor(R.color.mx_on_surface), true));
        LinearLayout metrics = new LinearLayout(this);
        metrics.setOrientation(LinearLayout.HORIZONTAL);
        metrics.setLayoutParams(topMarginLp(10));
        metrics.addView(metricView(stats == null ? "0" : String.valueOf(stats.optInt("totalOrders", 0)),
                getString(R.string.shop_total_orders)));
        metrics.addView(metricView(stats == null ? "0" : String.valueOf(stats.optInt("todayOrders", 0)),
                getString(R.string.shop_today_orders)));
        metrics.addView(metricView(stats == null ? "0.00" : money(stats.optDouble("totalRevenue", 0)),
                getString(R.string.shop_total_revenue)));
        statsCard.addView(metrics);

        JSONArray top = stats == null ? null : stats.optJSONArray("topProducts");
        if (top != null && top.length() > 0) {
            TextView title = tv(getString(R.string.shop_top_products), 13,
                    getColor(R.color.mx_on_surface), true);
            title.setPadding(0, dp(12), 0, dp(4));
            statsCard.addView(title);
            for (int i = 0; i < top.length(); i++) {
                JSONObject item = top.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                LinearLayout line = new LinearLayout(this);
                line.setOrientation(LinearLayout.HORIZONTAL);
                TextView name = tv((i + 1) + ". " + item.optString("name", ""), 12,
                        getColor(R.color.mx_on_surface_variant), false);
                name.setLayoutParams(new LinearLayout.LayoutParams(
                        0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                line.addView(name);
                line.addView(tv(getString(R.string.shop_sold, item.optInt("sales", 0)), 12,
                        getColor(R.color.mx_on_surface_variant), false));
                statsCard.addView(line);
            }
        }
        page.addView(statsCard);

        TextView allOrders = primaryButton(getString(R.string.shop_admin_all_orders));
        allOrders.setOnClickListener(v -> showOrders(true));
        page.addView(allOrders, topMarginLp(0));

        TextView shopTitle = tv(getString(R.string.shop_admin_shops), 15,
                getColor(R.color.mx_on_surface), true);
        shopTitle.setPadding(0, dp(16), 0, dp(8));
        page.addView(shopTitle);

        if (shops == null || shops.length() == 0) {
            addEmptyTip(page, getString(R.string.shop_empty_shops));
            return;
        }
        for (int i = 0; i < shops.length(); i++) {
            JSONObject shop = shops.optJSONObject(i);
            if (shop != null) {
                page.addView(buildAdminShopCard(shop));
            }
        }
    }

    /**
     * 统计数字列：上面数值、下面说明
     * @param value 数值文本
     * @param label 说明文本
     * @return 列视图
     */
    private View metricView(String value, String label) {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.setLayoutParams(new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView number = tv(value, 18, getColor(R.color.mx_primary), true);
        number.setGravity(Gravity.CENTER);
        column.addView(number);
        TextView caption = tv(label, 11, getColor(R.color.mx_on_surface_variant), false);
        caption.setGravity(Gravity.CENTER);
        column.addView(caption);
        return column;
    }

    /**
     * 管理后台店铺卡：封面/店名/状态 + 管理店铺 + 查封（或解封）
     * @param shop 店铺 JSON
     * @return 卡片视图
     */
    private View buildAdminShopCard(JSONObject shop) {
        LinearLayout card = createCard();
        final String shopId = shop.optString("id", "");
        final boolean seized = shop.optBoolean("seized", false);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        coverView(row, shop.optString("image"), shop.optString("emoji", "🏬"), 48);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams infoLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        infoLp.leftMargin = dp(12);
        info.setLayoutParams(infoLp);
        info.addView(tv(shop.optString("name", getString(R.string.shop_title)), 14,
                getColor(R.color.mx_on_surface), true));
        info.addView(tv(shop.optString("category", "综合"), 11,
                getColor(R.color.mx_on_surface_variant), false));
        row.addView(info);
        row.addView(statusBadgeView(shop));
        card.addView(row);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams actionsLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        actionsLp.topMargin = dp(10);
        actions.setLayoutParams(actionsLp);

        TextView manage = outlineButton(getString(R.string.shop_manage_products));
        manage.setOnClickListener(v -> {
            manageFromAdmin = true;
            showManage(shopId);
        });
        actions.addView(manage);

        TextView action = seized
                ? outlineButton(getString(R.string.shop_unseize))
                : dangerButton(getString(R.string.shop_seize));
        LinearLayout.LayoutParams actionLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        actionLp.leftMargin = dp(8);
        action.setLayoutParams(actionLp);
        if (seized) {
            action.setOnClickListener(v -> confirmUnseize(shopId));
        } else {
            action.setOnClickListener(v -> showSeizeDialog(shopId));
        }
        actions.addView(action);
        card.addView(actions);
        return card;
    }

    /**
     * 解封确认弹窗
     * @param shopId 店铺 id
     */
    private void confirmUnseize(String shopId) {
        new MaterialAlertDialogBuilder(this)
                .setMessage(getString(R.string.shop_unseize_confirm))
                .setNegativeButton(getString(R.string.action_cancel), null)
                .setPositiveButton(getString(R.string.shop_unseize), (d, w) ->
                        ShopApi.unseizeShop(shopId, token, new ShopApi.Callback() {
                            @Override
                            public void onSuccess(JSONObject root) {
                                if (binding == null) {
                                    return;
                                }
                                toast(getString(R.string.shop_unseized_done));
                                showAdmin();
                            }

                            @Override
                            public void onFailure(String message) {
                                toast(message);
                            }
                        }))
                .show();
    }

    /**
     * 查封店铺弹窗：填写年级、班级、整改截止时间与违规问题，确认后查封并发整改通知
     * @param shopId 店铺 id
     */
    private void showSeizeDialog(String shopId) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(4), dp(20), 0);
        box.addView(tv(getString(R.string.shop_seize_tip), 12,
                getColor(R.color.mx_on_surface_variant), false));

        final EditText gradeInput = input("", InputType.TYPE_CLASS_TEXT);
        gradeInput.setHint(getString(R.string.shop_seize_grade));
        final EditText classInput = input("", InputType.TYPE_CLASS_TEXT);
        classInput.setHint(getString(R.string.shop_seize_class));
        final EditText deadlineInput = input("", InputType.TYPE_CLASS_TEXT);
        deadlineInput.setHint(getString(R.string.shop_seize_deadline_hint));
        final EditText issuesInput = input("", InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        issuesInput.setHint(getString(R.string.shop_seize_issues));
        issuesInput.setMinLines(3);
        issuesInput.setGravity(Gravity.TOP | Gravity.START);

        addField(box, R.string.shop_seize_grade, gradeInput);
        addField(box, R.string.shop_seize_class, classInput);
        addField(box, R.string.shop_seize_deadline, deadlineInput);
        addField(box, R.string.shop_seize_issues, issuesInput);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);

        final AlertDialog dialog = new MaterialAlertDialogBuilder(this)
                .setTitle(getString(R.string.shop_seize_title))
                .setView(scroll)
                .setNegativeButton(getString(R.string.action_cancel), null)
                .setPositiveButton(getString(R.string.shop_seize_confirm), null)
                .create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(v -> {
                    String grade = gradeInput.getText().toString().trim();
                    String className = classInput.getText().toString().trim();
                    String deadline = deadlineInput.getText().toString().trim();
                    if (grade.isEmpty() || className.isEmpty()) {
                        toast(getString(R.string.shop_seize_need_grade));
                        return;
                    }
                    if (deadline.isEmpty()) {
                        toast(getString(R.string.shop_seize_need_deadline));
                        return;
                    }
                    JSONArray issues = new JSONArray();
                    try {
                        for (String line : issuesInput.getText().toString().split("\n")) {
                            String item = line.trim();
                            if (!item.isEmpty()) {
                                issues.put(item);
                            }
                        }
                    } catch (Exception e) {
                        toast(getString(R.string.shop_action_failed));
                        return;
                    }
                    if (issues.length() == 0) {
                        toast(getString(R.string.shop_seize_need_issues));
                        return;
                    }
                    JSONObject body = new JSONObject();
                    try {
                        body.put("grade", grade);
                        body.put("className", className);
                        body.put("deadline", deadline);
                        body.put("issues", issues);
                    } catch (Exception e) {
                        toast(getString(R.string.shop_action_failed));
                        return;
                    }
                    ShopApi.seizeShop(shopId, body, token, new ShopApi.Callback() {
                        @Override
                        public void onSuccess(JSONObject root) {
                            if (binding == null) {
                                return;
                            }
                            JSONObject data = root.optJSONObject("data");
                            String notice = data == null ? "" : data.optString("mailNotice", "");
                            toast(getString(R.string.shop_seized_done));
                            if (!notice.isEmpty()) {
                                toast(notice);
                            }
                            dialog.dismiss();
                            showAdmin();
                        }

                        @Override
                        public void onFailure(String message) {
                            toast(message);
                        }
                    });
                }));
        dialog.show();
    }

    // ==================== 表单 / 图片工具 ====================

    /**
     * 创建统一样式的输入框
     * @param value 初始文本
     * @param inputType 输入类型（InputType 常量）
     * @return 输入框视图
     */
    private EditText input(String value, int inputType) {
        EditText field = new EditText(this);
        field.setText(value);
        field.setInputType(inputType);
        field.setTextSize(14);
        field.setTextColor(getColor(R.color.mx_on_surface));
        field.setHintTextColor(getColor(R.color.mx_on_surface_variant));
        field.setBackground(strokeBg(getColor(R.color.mx_input_bg),
                getColor(R.color.mx_input_stroke), 10));
        field.setPadding(dp(12), dp(8), dp(12), dp(8));
        return field;
    }

    /**
     * 字段标签文本
     * @param text 标签内容
     * @return 标签视图
     */
    private TextView fieldLabel(String text) {
        TextView label = tv(text, 12, getColor(R.color.mx_on_surface_variant), false);
        label.setPadding(0, dp(10), 0, dp(4));
        return label;
    }

    /**
     * 往表单里追加「标签 + 输入框」
     * @param parent 表单容器
     * @param labelRes 标签文案资源
     * @param field 输入框
     * @return 标签视图（价格标签需要动态改文案时使用）
     */
    private TextView addField(LinearLayout parent, int labelRes, EditText field) {
        TextView label = fieldLabel(getString(labelRes));
        parent.addView(label);
        parent.addView(field, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return label;
    }

    /**
     * 追加「图片地址 + 上传按钮」字段
     * @param parent 表单容器
     * @param labelRes 标签文案资源
     * @param imageInput 图片地址输入框
     */
    private void addImageField(LinearLayout parent, int labelRes, EditText imageInput) {
        parent.addView(fieldLabel(getString(labelRes)));
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        imageInput.setLayoutParams(new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(imageInput);

        TextView upload = outlineButton(getString(R.string.shop_upload_image));
        LinearLayout.LayoutParams uploadLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        uploadLp.leftMargin = dp(8);
        upload.setLayoutParams(uploadLp);
        upload.setOnClickListener(v -> pickImage(imageInput));
        row.addView(upload);
        parent.addView(row);
    }

    /**
     * 唤起系统图片选择器
     * @param target 上传成功后回填地址的输入框
     */
    private void pickImage(EditText target) {
        if (imagePicker == null) {
            toast(getString(R.string.shop_action_failed));
            return;
        }
        pendingImageField = target;
        try {
            imagePicker.launch("image/*");
        } catch (Exception e) {
            toast(getString(R.string.shop_image_invalid));
        }
    }

    /**
     * 处理选中的图片：压缩为 JPEG dataURL → 上传 → 回填地址
     * @param uri 选中的图片 Uri，取消选择时为 null
     */
    private void uploadPickedImage(Uri uri) {
        if (uri == null) {
            return;
        }
        final EditText target = pendingImageField;
        if (target == null) {
            return;
        }
        toast(getString(R.string.shop_uploading));
        // 压缩是 CPU 与 IO 操作，放到子线程避免阻塞界面
        new Thread(() -> {
            String dataUrl;
            try {
                dataUrl = encodeToDataUrl(uri);
            } catch (Exception e) {
                runOnUiThread(() -> toast(getString(R.string.shop_image_decode_failed)));
                return;
            }
            ShopApi.uploadImage(dataUrl, token, new ShopApi.Callback() {
                @Override
                public void onSuccess(JSONObject root) {
                    JSONObject data = root.optJSONObject("data");
                    String url = data == null ? "" : data.optString("url", "");
                    if (binding == null) {
                        return;
                    }
                    if (!url.isEmpty()) {
                        target.setText(url);
                        toast(getString(R.string.shop_image_uploaded));
                    } else {
                        toast(getString(R.string.shop_image_failed));
                    }
                }

                @Override
                public void onFailure(String message) {
                    toast(message);
                }
            });
        }).start();
    }

    /**
     * 把选中图片读取、缩放并编码为 data:image/jpeg;base64 字符串
     * @param uri 图片 Uri
     * @return 可直接提交给服务端的 dataURL
     * @throws IOException 读取或解码失败时抛出
     */
    private String encodeToDataUrl(Uri uri) throws IOException {
        ContentResolver resolver = getContentResolver();

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
        while (maxSide / sample > IMAGE_MAX_SIDE) {
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
     * 监听输入框文本变化（用于把输入结果同步到模型）
     * @param field 输入框
     * @param onChanged 文本变化回调
     */
    private void watch(EditText field, java.util.function.Consumer<String> onChanged) {
        field.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
                // 无需处理
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                // 无需处理
            }

            @Override
            public void afterTextChanged(Editable s) {
                onChanged.accept(s == null ? "" : s.toString());
            }
        });
    }

    /**
     * 构造规格/套餐分组的内部小卡片
     * @return 描边小卡片
     */
    private LinearLayout innerCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(strokeBg(getColor(R.color.mx_input_bg),
                getColor(R.color.mx_input_stroke), 12));
        card.setPadding(dp(10), dp(10), dp(10), dp(10));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(8);
        card.setLayoutParams(lp);
        return card;
    }

    /**
     * 小红字操作按钮（上移/下移/删除/✕）
     * @param text 按钮文字
     * @return 文本按钮
     */
    private TextView smallAction(String text) {
        TextView b = tv(text, 12, getColor(R.color.mx_on_surface_variant), false);
        b.setPadding(dp(2), dp(4), dp(2), dp(4));
        b.setClickable(true);
        return b;
    }

    /**
     * 危险操作按钮（红色描边胶囊）
     * @param text 按钮文字
     * @return 按钮视图
     */
    private TextView dangerButton(String text) {
        TextView b = tv(text, 13, getColor(R.color.mx_error), false);
        b.setGravity(Gravity.CENTER);
        b.setBackground(strokeBg(getColor(R.color.mx_surface), getColor(R.color.mx_error), 20));
        b.setPadding(dp(14), dp(8), dp(14), dp(8));
        b.setClickable(true);
        return b;
    }

    /**
     * 构造带顶部间距的匹配宽度布局参数
     * @param topMarginDp 顶部间距（dp）
     * @return 布局参数
     */
    private LinearLayout.LayoutParams topMarginLp(int topMarginDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(topMarginDp);
        return lp;
    }

    // ==================== 购物车角标 ====================

    /**
     * 启动时拉取购物车，刷新顶栏角标
     */
    private void refreshCartBadge() {
        ShopApi.getCart(token, new ShopApi.Callback() {
            @Override
            public void onSuccess(JSONObject root) {
                updateBadgeFromCart(root.optJSONObject("data"));
            }

            @Override
            public void onFailure(String message) {
                // 角标失败不影响主流程，静默忽略
            }
        });
    }

    /**
     * 从购物车视图中同步角标数字
     * @param cart 购物车视图，可为 null
     */
    private void updateBadgeFromCart(JSONObject cart) {
        if (cart == null) {
            return;
        }
        cartCount = cart.optInt("count", 0);
        updateBadge(cartCount);
    }

    /**
     * 更新顶栏购物车角标
     * @param count 商品总件数，<=0 时隐藏角标
     */
    private void updateBadge(int count) {
        if (binding == null) {
            return;
        }
        TextView badge = binding.tvCartBadge;
        if (count <= 0) {
            badge.setVisibility(View.GONE);
            return;
        }
        badge.setVisibility(View.VISIBLE);
        badge.setText(count > 99 ? "99+" : String.valueOf(count));
        badge.setTextColor(getColor(R.color.mx_on_primary));
        badge.setBackground(roundBg(getColor(R.color.mx_primary), 8));
    }
}
